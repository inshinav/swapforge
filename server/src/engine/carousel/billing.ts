// Деньги карусели (SPEC §7): hold→settle/release на низкоуровневых примитивах credits.ts,
// цена ТОЛЬКО через frozen priceCredits(). Правила из адверс-ревью плана:
// - placeHold с reused:true = КОНФЛИКТ (409), никогда не работаем под чужой/старой hold;
// - settle по id-атрибуции (slide ids + op ids), НЕ по временному окну;
// - reconcileCarouselHolds() на буте — статус-матрица §7.
import { randomUUID } from 'node:crypto';
import { getDb } from '../../db';
import { config } from '../../config';
import {
  creditBalance,
  openHoldForProject,
  placeHold,
  priceCredits,
  releaseHold,
  settleHold,
} from '../../billing/credits';
import { buildCarouselQuote, buildIdeationQuote } from './pricing';
import type { CarouselQuoteInfo } from '../../../../shared/carousel';
import { CAROUSEL_TASKS } from '../../../../shared/carousel';

/** Конкурентная операция уже держит hold на этой карусели → HTTP 409. */
export class HoldConflictError extends Error {
  constructor() {
    super('Другая операция этой карусели ещё не завершена — подожди пару секунд и повтори');
    this.name = 'HoldConflictError';
  }
}

/** Не хватает кредитов → HTTP 402-подобный ответ с shortfall. */
export class InsufficientCreditsError extends Error {
  constructor(
    public needCredits: number,
    public availableCredits: number,
  ) {
    super(
      `Нужно $${(needCredits / 100).toFixed(2)}, на балансе $${(Math.max(0, availableCredits) / 100).toFixed(2)}`,
    );
    this.name = 'InsufficientCreditsError';
  }
}

/** Владелец не резервирует и не платит (unmetered, как в видео-пайплайне). */
function isOwner(userId: string): boolean {
  const row = getDb().prepare(`SELECT role FROM users WHERE id=?`).get(userId) as
    | { role: string }
    | undefined;
  return row?.role === 'owner';
}

/** Свежесозданная СВОЯ hold или исключение; reused-hold — всегда конфликт (анти-эксплойт §7). */
export function placeCarouselHold(userId: string, scopeId: string, credits: number): string {
  const r = placeHold(userId, scopeId, credits);
  if (!r.ok) throw new InsufficientCreditsError(r.needCredits, r.availableCredits);
  if (r.reused) throw new HoldConflictError();
  return r.holdId;
}

/** Квота генерации для показа пользователю (кредиты → «$» = кредиты/100). */
export function carouselQuoteInfo(userId: string, slideCount: number): CarouselQuoteInfo {
  const q = buildCarouselQuote(slideCount);
  const priceCents = q.totalUsd === null ? null : priceCredits(q.totalUsd);
  // Владелец unmetered (как в видео-пайплайне): цена справочно, баланс-гейта нет.
  if (isOwner(userId)) {
    return {
      priceUsd: priceCents === null ? -1 : priceCents / 100,
      balanceUsd: 0,
      enough: priceCents !== null,
      shortfallUsd: 0,
      approximate: q.approximate,
    };
  }
  const { available } = creditBalance(userId);
  const enough = priceCents !== null && priceCents <= available;
  return {
    priceUsd: priceCents === null ? -1 : priceCents / 100,
    balanceUsd: available / 100,
    enough,
    shortfallUsd: priceCents === null || enough ? 0 : Math.ceil(priceCents - available) / 100,
    approximate: q.approximate,
  };
}

/**
 * Старт генерации: прекол «нет чужой open-hold» → свежая hold на полную квоту →
 * персист hold_id/run_id/quote_json. Владелец проходит без hold (unmetered).
 */
export function startGenerationHold(carouselId: string, userId: string, slideCount: number): void {
  const db = getDb();
  if (isOwner(userId)) {
    db.prepare(
      `UPDATE carousel_projects SET run_id=?, quote_json=?, updated_at=datetime('now') WHERE id=?`,
    ).run(randomUUID(), JSON.stringify({ owner: true }), carouselId);
    return;
  }
  if (openHoldForProject(carouselId)) throw new HoldConflictError();
  const q = buildCarouselQuote(slideCount);
  if (q.totalUsd === null) {
    throw new Error('Точная смета временно недоступна — попробуй чуть позже');
  }
  const credits = priceCredits(q.totalUsd);
  const holdId = placeCarouselHold(userId, carouselId, credits);
  db.prepare(
    `UPDATE carousel_projects SET hold_id=?, run_id=?, quote_json=?, updated_at=datetime('now') WHERE id=?`,
  ).run(holdId, randomUUID(), JSON.stringify({ credits, quote: q }), carouselId);
}

/** Себестоимость рана по атрибуции: done-слайды + ран-левел (caption) минус ничего лишнего. */
export function carouselFactUsd(carouselId: string): number {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(u.cost_usd), 0) AS s
         FROM usage_events u
        WHERE u.project_id = ?
          AND (
            u.generation_id IN (SELECT id FROM carousel_slides WHERE carousel_id = ? AND status = 'done')
            OR u.generation_id = (SELECT run_id FROM carousel_projects WHERE id = ?)
          )`,
    )
    .get(carouselId, carouselId, carouselId) as { s: number };
  return row.s;
}

/**
 * Закрыть деньги рана по итогам слайдов: ≥1 done → settle факта (кап = hold);
 * 0 done → полный release. Идемпотентно (закрытая hold — no-op).
 */
export function settleCarousel(carouselId: string): void {
  const db = getDb();
  const carousel = db
    .prepare(`SELECT user_id, hold_id FROM carousel_projects WHERE id=?`)
    .get(carouselId) as { user_id: string; hold_id: string | null } | undefined;
  if (!carousel?.hold_id) return; // владелец или hold не ставилась
  const done = db
    .prepare(`SELECT COUNT(*) AS c FROM carousel_slides WHERE carousel_id=? AND status='done'`)
    .get(carouselId) as { c: number };
  if (done.c === 0) {
    releaseHold(carousel.hold_id, 0, 'карусель не удалась — резерв возвращён');
    return;
  }
  const fact = carouselFactUsd(carouselId);
  settleHold(carousel.hold_id, priceCredits(fact), null, 'списание по факту карусели');
}

/**
 * Синхронный микро-hold идеации (SPEC §7): quote → СВОЯ hold → вызов → settle факта по opId.
 * Провал вызова → полный release (неудачное бесплатно). Владелец — без hold.
 */
export async function withIdeationHold<T>(
  input: {
    carouselId: string;
    userId: string;
    task: typeof CAROUSEL_TASKS.idea | typeof CAROUSEL_TASKS.storyboard | typeof CAROUSEL_TASKS.caption;
  },
  fn: (opId: string) => Promise<T>,
): Promise<T> {
  const opId = `op-${randomUUID()}`;
  if (isOwner(input.userId)) return fn(opId);
  const q = buildIdeationQuote(input.task);
  if (q.totalUsd === null) throw new Error('Точная смета временно недоступна — попробуй чуть позже');
  const holdId = placeCarouselHold(input.userId, input.carouselId, priceCredits(q.totalUsd));
  try {
    const res = await fn(opId);
    const fact = getDb()
      .prepare(`SELECT COALESCE(SUM(cost_usd),0) AS s FROM usage_events WHERE generation_id=?`)
      .get(opId) as { s: number };
    settleHold(holdId, priceCredits(fact.s), opId, 'списание по факту (идеи/раскадровка/подпись)');
    return res;
  } catch (e) {
    releaseHold(holdId, 0, 'идеация не удалась — резерв возвращён');
    throw e;
  }
}

/**
 * Бут-реконсиляция холдов карусели (SPEC §7, статус-матрица). Существующий
 * reconcileOrphanHolds эти холды не видит (JOIN на generations) — чистильщик свой.
 * Возвращает счётчики для лога.
 */
export function reconcileCarouselHolds(): { released: number; settled: number; autoAccepted: number } {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT h.id AS hold_id, c.id AS carousel_id, c.status, c.review_deadline
         FROM credit_holds h
         JOIN carousel_projects c ON c.id = h.project_id
        WHERE h.status = 'open'`,
    )
    .all() as Array<{ hold_id: string; carousel_id: string; status: string; review_deadline: string | null }>;
  let released = 0;
  let settled = 0;
  let autoAccepted = 0;
  for (const r of rows) {
    if (r.status === 'generating') continue; // resumeCarousels() дорастит ран и закроет сам
    if (r.status === 'qc_review') {
      const expired =
        !r.review_deadline ||
        (db.prepare(`SELECT datetime('now') > ? AS e`).get(r.review_deadline) as { e: number }).e === 1;
      if (!expired) continue; // окно ревью живо — hold легитимна
      autoAccepted += autoAcceptReview(r.carousel_id);
      settled++;
      continue;
    }
    if (r.status === 'done') {
      settleCarousel(r.carousel_id);
      settled++;
      continue;
    }
    // draft/storyboard/failed: упавшая идеация или мёртвый ран — «неудачное бесплатно».
    releaseHold(r.hold_id, 0, 'сиротская hold карусели — возвращено при старте сервиса');
    released++;
  }
  if (released || settled) {
    console.log(`[carousel-holds] реконсиляция: released=${released} settled=${settled} autoAccepted=${autoAccepted}`);
  }
  return { released, settled, autoAccepted };
}

/** Принять один слайд; если needs_review не осталось — карусель done + settle. */
export function acceptSlide(carouselId: string, slideId: string): boolean {
  const db = getDb();
  const n = db
    .prepare(
      `UPDATE carousel_slides SET status='done', accepted=1, updated_at=datetime('now')
        WHERE id=? AND carousel_id=? AND status='needs_review'`,
    )
    .run(slideId, carouselId) as { changes: number | bigint };
  if (Number(n.changes ?? 0) === 0) return false;
  const left = db
    .prepare(`SELECT COUNT(*) AS c FROM carousel_slides WHERE carousel_id=? AND status='needs_review'`)
    .get(carouselId) as { c: number };
  if (left.c === 0) {
    db.prepare(
      `UPDATE carousel_projects SET status='done', review_deadline=NULL, updated_at=datetime('now') WHERE id=?`,
    ).run(carouselId);
    settleCarousel(carouselId);
  }
  return true;
}

/** TTL ревью истёк: needs_review → done (accepted), карусель done, settle. */
export function autoAcceptReview(carouselId: string): number {
  const db = getDb();
  const n = db
    .prepare(
      `UPDATE carousel_slides SET status='done', accepted=1, updated_at=datetime('now')
        WHERE carousel_id=? AND status='needs_review'`,
    )
    .run(carouselId) as { changes: number | bigint };
  db.prepare(
    `UPDATE carousel_projects SET status='done', review_deadline=NULL, updated_at=datetime('now') WHERE id=?`,
  ).run(carouselId);
  settleCarousel(carouselId);
  return Number(n.changes ?? 0);
}

/** Дедлайн ревью от текущего момента (config TTL) — ставится при входе в qc_review. */
export function reviewDeadlineFromNow(): string {
  const hours = Math.max(1, Math.round(config.carouselReviewTtlMs / 3_600_000));
  return (
    getDb().prepare(`SELECT datetime('now', ?) AS d`).get(`+${hours} hours`) as { d: string }
  ).d;
}
