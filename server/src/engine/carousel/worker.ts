// Мини-воркер каруселей (SPEC §7/§10): СВОЯ очередь — jobs.ts недоступен (FK на projects),
// render.ts несёт деньги WaveSpeed. Очередь = строки carousel_projects в статусе 'generating';
// клейм в памяти (один процесс), рестарт закрывает resumeCarousels() на буте: пер-слайдовые
// чекпоинты движка делают повторный ран идемпотентным.
import { getDb } from '../../db';
import { config } from '../../config';
import { CarouselRunError, generateCarouselSlides, type CarouselRunDeps } from './generate';
import { reviewDeadlineFromNow, settleCarousel } from './billing';
import { runCaptionEngine } from './caption';
import { notifyCarouselReady } from '../../telegram/notify';

const running = new Set<string>();
let testDeps: CarouselRunDeps | null = null;

/** Только для тестов: подменить провайдер/QC для всех ранов воркера. */
export function setCarouselWorkerDepsForTests(deps: CarouselRunDeps | null): void {
  testDeps = deps;
}

/** Тестовый хелпер: дождаться полного простоя воркера. */
export async function waitCarouselWorkerIdle(): Promise<void> {
  while (running.size > 0) await new Promise((r) => setTimeout(r, 5));
}

interface Candidate {
  id: string;
  user_id: string;
}

/** FIFO-кандидаты: generating, не запущены, юзер не занят другим раном. */
function claimNext(): Candidate | null {
  const rows = getDb()
    .prepare(
      `SELECT id, user_id FROM carousel_projects WHERE status='generating' ORDER BY created_at ASC, rowid ASC`,
    )
    .all() as unknown as Candidate[];
  const busyUsers = new Set(
    rows.filter((r) => running.has(r.id)).map((r) => r.user_id),
  );
  for (const row of rows) {
    if (running.has(row.id)) continue;
    if (busyUsers.has(row.user_id)) continue; // пер-юзер параллельность = 1 (SPEC §10)
    return row;
  }
  return null;
}

function setProject(carouselId: string, fields: Record<string, unknown>): void {
  const keys = Object.keys(fields);
  getDb()
    .prepare(
      `UPDATE carousel_projects SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=datetime('now') WHERE id=?`,
    )
    .run(...keys.map((k) => fields[k] as never), carouselId);
}

async function runOne(carouselId: string): Promise<void> {
  try {
    await generateCarouselSlides(carouselId, testDeps ?? {});
    const counts = getDb()
      .prepare(
        `SELECT
           SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done,
           SUM(CASE WHEN status='needs_review' THEN 1 ELSE 0 END) AS review
         FROM carousel_slides WHERE carousel_id=?`,
      )
      .get(carouselId) as { done: number | null; review: number | null };
    // Подпись — часть квоты генерации (usage на run_id); best-effort, провал не роняет ран.
    if ((counts.done ?? 0) > 0 || (counts.review ?? 0) > 0) {
      await generateRunCaption(carouselId);
    }
    if ((counts.review ?? 0) > 0) {
      // Ревью-окно: hold остаётся открытой до принятия/ретраев/TTL (SPEC §5/§7).
      setProject(carouselId, { status: 'qc_review', review_deadline: reviewDeadlineFromNow() });
    } else if ((counts.done ?? 0) > 0) {
      setProject(carouselId, { status: 'done' });
      settleCarousel(carouselId);
      void notifyDone(carouselId, counts.done ?? 0);
    } else {
      setProject(carouselId, { status: 'failed', error: 'Ни один слайд не получился — резерв возвращён' });
      settleCarousel(carouselId); // 0 done → полный release
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!(e instanceof CarouselRunError)) {
      console.error(`[carousel-worker] ран ${carouselId} упал: ${msg}`);
    }
    setProject(carouselId, { status: 'failed', error: msg.slice(0, 500) });
    settleCarousel(carouselId);
  } finally {
    running.delete(carouselId);
    pumpCarousels();
  }
}

/** Авто-подпись после слайдов: usage на run_id (в квоте генерации), провал только warn. */
async function generateRunCaption(carouselId: string): Promise<void> {
  const row = getDb()
    .prepare(`SELECT user_id, run_id, caption_json, idea_json FROM carousel_projects WHERE id=?`)
    .get(carouselId) as
    | { user_id: string; run_id: string | null; caption_json: string | null; idea_json: string | null }
    | undefined;
  if (!row || row.caption_json || !row.idea_json) return;
  try {
    const caption = await runCaptionEngine(
      { carouselId, userId: row.user_id, opId: row.run_id ?? `run-${carouselId.slice(0, 8)}` },
      testDeps?.qcLlm,
    );
    getDb()
      .prepare(`UPDATE carousel_projects SET caption_json=?, updated_at=datetime('now') WHERE id=?`)
      .run(JSON.stringify(caption), carouselId);
  } catch (e) {
    console.warn(
      `[carousel-caption] carousel=${carouselId}: подпись не сгенерилась (${e instanceof Error ? e.message.slice(0, 120) : e}) — кнопка «Пересобрать подпись» доступна`,
    );
  }
}

/** Уведомление о готовности (best-effort; в тестах сеть заглушена — просто молчит). */
async function notifyDone(carouselId: string, slides: number): Promise<void> {
  try {
    const row = getDb()
      .prepare(
        `SELECT u.telegram_id AS tg, c.title AS title
           FROM carousel_projects c JOIN users u ON u.id = c.user_id WHERE c.id = ?`,
      )
      .get(carouselId) as { tg: number; title: string } | undefined;
    if (row?.tg) await notifyCarouselReady({ telegramId: row.tg, title: row.title || 'без названия', slides });
  } catch {
    /* уведомление вторично */
  }
}

/** Насос: добирает раны до глобального капа. Вызывается на enqueue, финише рана и буте. */
export function pumpCarousels(): void {
  while (running.size < Math.max(1, config.carouselConcurrency)) {
    const next = claimNext();
    if (!next) return;
    running.add(next.id);
    void runOne(next.id);
  }
}

/** Постановка в очередь после startGenerationHold (статус уже 'generating'). */
export function enqueueCarouselRun(_carouselId: string): void {
  pumpCarousels();
}

/** Позиция в очереди для UI (1 = следующий; 0 = уже выполняется). */
export function carouselQueuePosition(carouselId: string): number {
  if (running.has(carouselId)) return 0;
  const rows = getDb()
    .prepare(`SELECT id FROM carousel_projects WHERE status='generating' ORDER BY created_at ASC, rowid ASC`)
    .all() as Array<{ id: string }>;
  let pos = 0;
  for (const r of rows) {
    if (running.has(r.id)) continue;
    pos++;
    if (r.id === carouselId) return pos;
  }
  return pos;
}

/** Бут: подобрать раны, прерванные рестартом (чекпоинты делают это идемпотентным). */
export function resumeCarousels(): void {
  const n = (
    getDb().prepare(`SELECT COUNT(*) AS c FROM carousel_projects WHERE status='generating'`).get() as {
      c: number;
    }
  ).c;
  if (n > 0) {
    console.log(`[carousel-worker] resume: ${n} каруселей в статусе generating`);
    pumpCarousels();
  }
}
