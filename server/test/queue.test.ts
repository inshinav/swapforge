// FIFO-очередь рендеров + дневные лимиты + пер-юзер сторедж-кап.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-queue-'));
process.env.AUTH_DEV_BYPASS = '1';
process.env.OPENAI_API_KEY = 'test-key';
process.env.WAVESPEED_API_KEY = 'test-key';
process.env.USER_QUEUE_CAP = '2';
process.env.RENDER_CONCURRENCY = '1';

const { getDb } = await import('../src/db');
const {
  RenderGateError,
  activeGeneration,
  activeGenerationCount,
  cancelQueued,
  promoteNext,
  queuePositionOf,
  startRender,
  _setPollBaseMs,
} = await import('../src/engine/render');
_setPollBaseMs(5);
const { grantPurchase, openHoldForProject, placeHold, creditBalance } = await import('../src/billing/credits');
const { forceReleaseProjectHold, settleProjectHold } = await import('../src/billing/flow');
const { consumeDailyLimit, dayKey } = await import('../src/limits');
const { enforceStorageCap, projectDir, refsDir, startDir } = await import('../src/storage');
const { config } = await import('../src/config');
import type { WaveSpeed, WsPrediction } from '../src/wavespeed';

const LIVE_FORMULA =
  '{"total_price": 75000 * (resolution = "4k" ? 10 : (resolution = "1080p" ? 5 : (resolution = "720p" ? 2 : 1))) * ($max([2, $ceil($min([$number($ceil(get_duration_v3(video))), 15]))]) + (duration ? $number(duration) : $max([4, $min([15, $ceil($number($ceil(get_duration_v3(video))))])])))}';

function fakeWs(o: { pollScript?: Array<Partial<WsPrediction>>; uploadLog?: string[] } = {}): WaveSpeed {
  let pollIdx = 0;
  return {
    uploadBinary: async (p: string) => {
      o.uploadLog?.push(path.basename(p));
      return `https://cdn/${path.basename(p)}`;
    },
    submitVideoEdit: async () => `pred-${randomUUID().slice(0, 6)}`,
    pollResult: async (id: string): Promise<WsPrediction> => {
      const step = o.pollScript?.[Math.min(pollIdx, (o.pollScript?.length ?? 1) - 1)];
      pollIdx++;
      return { id, status: 'completed', outputs: ['https://cdn/out.mp4'], error: '', raw: {}, ...(step ?? {}) };
    },
    downloadOutput: async (_u: string, dest: string) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.alloc(500, 1));
      return 500;
    },
    getBalance: async () => 50,
    fetchModelEntry: async () => ({ model_id: config.seedanceEndpoint, base_price: 0.75, formula: LIVE_FORMULA }),
  } as WaveSpeed;
}

async function until(fn: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout в ожидании условия');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const OWNER_ID = 'owner-queue-tests';
getDb().prepare(`INSERT INTO users (id, telegram_id, role) VALUES (?, 4242, 'owner')`).run(OWNER_ID);

function mkUser(tg: number): string {
  const id = randomUUID();
  getDb().prepare(`INSERT INTO users (id, telegram_id) VALUES (?, ?)`).run(id, tg);
  return id;
}

function readyProject(userId: string, id = randomUUID()): string {
  const db = getDb();
  db.prepare(
    `INSERT INTO projects (id, user_id, title, status, video_file, video_bytes, meta_json, frames_json, analysis_json)
     VALUES (?, ?, 'q', 'complete', 'source.mp4', 3000, ?, '[]', '{}')`,
  ).run(id, userId, JSON.stringify({ durationSec: 6, width: 1080, height: 1920, fps: 30, aspect: '9:16', sizeBytes: 3000 }));
  fs.mkdirSync(refsDir(id), { recursive: true });
  fs.mkdirSync(startDir(id), { recursive: true });
  fs.writeFileSync(path.join(projectDir(id), 'source.mp4'), Buffer.alloc(3000, 2));
  db.prepare(`INSERT INTO refs (id, project_id, idx, role, file) VALUES (?, ?, 0, 'model', 'ref_a.jpg')`).run(`${id}-r1`, id);
  fs.writeFileSync(path.join(refsDir(id), 'ref_a.jpg'), 'a');
  db.prepare(
    `INSERT INTO prompts (id, project_id, version, kind, text, flags_json) VALUES (?, ?, 1, 'video', 'VP', '{}')`,
  ).run(randomUUID(), id);
  db.prepare(
    `INSERT INTO prompts (id, project_id, version, kind, text, flags_json) VALUES (?, ?, 1, 'image', 'IP', '{}')`,
  ).run(randomUUID(), id);
  fs.writeFileSync(path.join(startDir(id), 'start_v1_2026-07-19T00-00-00.png'), 'png');
  return id;
}

function authorizePaidProject(userId: string, projectId: string, credits = 500): void {
  const db = getDb();
  const attemptId = randomUUID();
  const existing = openHoldForProject(projectId);
  const holdId = existing?.id ?? randomUUID();
  db.prepare(
    `INSERT INTO flow_attempts
      (id, user_id, project_id, action, final_price_cents, pricing_snapshot_json,
       ref_fingerprint, context_fingerprint, status, expires_at, hold_id, started_at)
     VALUES (?, ?, ?, 'rerun', ?, '{}', 'test', 'test', 'running', datetime('now','+5 minutes'), ?, datetime('now'))`,
  ).run(attemptId, userId, projectId, credits, holdId);
  if (existing) {
    db.prepare(`UPDATE credit_holds SET attempt_id=? WHERE id=?`).run(attemptId, holdId);
  } else {
    db.prepare(
      `INSERT INTO credit_holds (id, user_id, project_id, credits, attempt_id) VALUES (?, ?, ?, ?, ?)`,
    ).run(holdId, userId, projectId, credits, attemptId);
  }
}

function genStatus(id: string): string | undefined {
  return (getDb().prepare(`SELECT status FROM generations WHERE id = ?`).get(id) as { status: string } | undefined)
    ?.status;
}

describe('FIFO-очередь', () => {
  it('до RENDER_CONCURRENCY проектов рендерятся одновременно, следующий остаётся FIFO', async () => {
    const original = config.renderConcurrency;
    (config as { renderConcurrency: number }).renderConcurrency = 3;
    try {
      const ws = fakeWs({ pollScript: [{ status: 'processing' }] });
      const gens = Array.from({ length: 4 }, () => startRender(readyProject(OWNER_ID), 1, { ws, pollBaseMs: 5 }));
      expect(gens.slice(0, 3).every((g) => genStatus(g) !== 'queued')).toBe(true);
      expect(genStatus(gens[3]!)).toBe('queued');
      expect(activeGenerationCount()).toBe(3);
      getDb().prepare(`UPDATE generations SET status='failed' WHERE id IN (?, ?, ?, ?)`).run(...gens);
      await new Promise((r) => setTimeout(r, 15));
    } finally {
      (config as { renderConcurrency: number }).renderConcurrency = original;
    }
  });

  it('занятый слот → queued с позицией; финал первого продвигает второй; порядок FIFO', async () => {
    const ws = fakeWs({ pollScript: [{ status: 'processing' }, { status: 'processing' }, { status: 'completed' }] });
    const p1 = readyProject(OWNER_ID);
    const p2 = readyProject(OWNER_ID);
    const p3 = readyProject(OWNER_ID);

    const g1 = startRender(p1, 1, { ws, pollBaseMs: 5 });
    expect(genStatus(g1)).toBe('uploading_assets');
    const g2 = startRender(p2, 1, { ws, pollBaseMs: 5 });
    const g3 = startRender(p3, 1, { ws, pollBaseMs: 5 });
    expect(genStatus(g2)).toBe('queued');
    expect(genStatus(g3)).toBe('queued');
    expect(queuePositionOf(g2)).toBe(1);
    expect(queuePositionOf(g3)).toBe(2);
    expect(activeGeneration()?.id).toBe(g1);

    await until(() => genStatus(g1) === 'done', 6000);
    // g1 done → promoteNext поднял g2; g3 остался в очереди первым
    await until(() => genStatus(g2) !== 'queued', 6000);
    await until(() => genStatus(g2) === 'done', 6000);
    await until(() => genStatus(g3) === 'done', 6000);
  });

  it('повторный startRender на проект с queued-задачей → 409', () => {
    const ws = fakeWs({ pollScript: [{ status: 'processing' }] });
    const p1 = readyProject(OWNER_ID);
    const p2 = readyProject(OWNER_ID);
    const g1 = startRender(p1, 1, { ws, pollBaseMs: 5 });
    const g2 = startRender(p2, 1, { ws, pollBaseMs: 5 });
    expect(genStatus(g2)).toBe('queued');
    expect(() => startRender(p2, 1, { ws })).toThrow(RenderGateError);
    // чистим
    getDb().prepare(`UPDATE generations SET status='failed' WHERE id IN (?, ?)`).run(g1, g2);
  });

  it('кап очереди не-владельца: третья queued-задача → 409', () => {
    const u = mkUser(7101);
    grantPurchase(u, 100000, `ref-${randomUUID()}`, 'тест');
    const ws = fakeWs({ pollScript: [{ status: 'processing' }] });
    const blocker = readyProject(OWNER_ID);
    startRender(blocker, 1, { ws, pollBaseMs: 5 }); // владелец занял слот
    const p1 = readyProject(u);
    const p2 = readyProject(u);
    authorizePaidProject(u, p1);
    authorizePaidProject(u, p2);
    const q1 = startRender(p1, 1, { ws, pollBaseMs: 5 });
    const q2 = startRender(p2, 1, { ws, pollBaseMs: 5 });
    expect(genStatus(q1)).toBe('queued');
    expect(genStatus(q2)).toBe('queued');
    const p3 = readyProject(u);
    authorizePaidProject(u, p3);
    expect(() => startRender(p3, 1, { ws })).toThrow(/В очереди уже 2/);
    // владельца кап не касается
    const o1 = startRender(readyProject(OWNER_ID), 1, { ws, pollBaseMs: 5 });
    const o2 = startRender(readyProject(OWNER_ID), 1, { ws, pollBaseMs: 5 });
    const o3 = startRender(readyProject(OWNER_ID), 1, { ws, pollBaseMs: 5 });
    expect([o1, o2, o3].every((g) => genStatus(g) === 'queued')).toBe(true);
    getDb()
      .prepare(`UPDATE generations SET status='failed' WHERE status IN ('queued','uploading_assets','submitted','rendering')`)
      .run();
  });

  it('cancelQueued: строка → failed, hold освобождается, очередь едет дальше', async () => {
    const u = mkUser(7102);
    grantPurchase(u, 10000, `ref-${randomUUID()}`, 'тест');
    const ws = fakeWs({ pollScript: [{ status: 'processing' }] });
    const blocker = readyProject(OWNER_ID);
    startRender(blocker, 1, { ws, pollBaseMs: 5 });
    const pu = readyProject(u);
    placeHold(u, pu, 400); // резерв как от /swap
    authorizePaidProject(u, pu, 400);
    const gq = startRender(pu, 1, { ws, pollBaseMs: 5 });
    expect(genStatus(gq)).toBe('queued');
    expect(openHoldForProject(pu)?.status).toBe('open');

    expect(cancelQueued(gq)).toBe(true);
    expect(genStatus(gq)).toBe('failed');
    expect(openHoldForProject(pu)).toBeUndefined();
    expect(creditBalance(u).held).toBe(0);
    expect(cancelQueued(gq)).toBe(false); // идемпотентно
    getDb().prepare(`UPDATE generations SET status='failed' WHERE status != 'failed'`).run();
  });

  it('кредиты: hold от /swap привязывается к рендеру и селтится по факту (не-владелец)', async () => {
    const u = mkUser(7110);
    grantPurchase(u, 100000, `ref-${randomUUID()}`, 'тест');
    const p = readyProject(u);
    // как /swap: резерв на весь флоу (generation_id пока null)
    const hold = placeHold(u, p, 500);
    expect(hold.ok).toBe(true);
    authorizePaidProject(u, p, 500);
    const ws = fakeWs();
    const g = startRender(p, 1, { ws, pollBaseMs: 5 }); // привязывает hold к g
    expect(openHoldForProject(p)?.generation_id).toBe(g);
    await until(() => genStatus(g) === 'done', 6000);
    // единый финал закрыл hold по факту — резерв снят, кредиты списаны один раз
    expect(openHoldForProject(p)).toBeUndefined();
    expect(creditBalance(u).held).toBe(0);
    expect(creditBalance(u).balance).toBeLessThan(100000);
  });

  it('F2: recheck-путь старого gen НЕ освобождает hold, переклеенный на retry-gen', () => {
    const u = mkUser(7111);
    grantPurchase(u, 100000, `ref-${randomUUID()}`, 'тест');
    const p = readyProject(u);
    placeHold(u, p, 500);
    const db = getDb();
    // gen1 «завис» failed с живым prediction_id (таймаут поллинга) — hold держится
    const gen1 = randomUUID();
    db.prepare(
      `INSERT INTO generations (id, project_id, version, status, ws_prediction_id, user_id) VALUES (?, ?, 1, 'failed', 'pred-1', ?)`,
    ).run(gen1, p, u);
    // retry создал gen2 и переклеил hold на него (эмулируем attach как в startRender)
    const gen2 = randomUUID();
    db.prepare(
      `INSERT INTO generations (id, project_id, version, status, ws_prediction_id, user_id) VALUES (?, ?, 1, 'submitted', 'pred-2', ?)`,
    ).run(gen2, p, u);
    db.prepare(`UPDATE credit_holds SET generation_id = ? WHERE project_id = ? AND status = 'open'`).run(gen2, p);

    // recheck старого gen1 обнаружил WS-terminal fail → markFailed(gen1, wsTerminal)
    // раньше это освобождало hold, принадлежащий gen2 (F2). Теперь — нет.
    forceReleaseProjectHold(p, gen1, 'WaveSpeed отклонил задачу');
    expect(openHoldForProject(p)?.status).toBe('open'); // hold gen2 цел

    // gen2 дорендерился → settle списывает (ролик НЕ бесплатный)
    settleProjectHold(p, gen2, 2.0);
    expect(openHoldForProject(p)).toBeUndefined();
    expect(creditBalance(u).balance).toBeLessThan(100000);
  });

  it('promoteNext на пустой очереди/занятом слоте — no-op', () => {
    const ws = fakeWs({ pollScript: [{ status: 'processing' }] });
    promoteNext(ws); // пустая очередь
    const p = readyProject(OWNER_ID);
    const g = startRender(p, 1, { ws, pollBaseMs: 5 });
    const before = genStatus(g);
    promoteNext(ws); // слот занят этой же задачей
    expect(genStatus(g)).toBe(before);
    getDb().prepare(`UPDATE generations SET status='failed' WHERE id = ?`).run(g);
  });
});

describe('дневные лимиты', () => {
  it('reserve-and-decide: limit-я попытка проходит, limit+1 — нет и не персистится', () => {
    const u = mkUser(7103);
    for (let i = 1; i <= 3; i++) {
      expect(consumeDailyLimit(u, 'describe', 3).allowed).toBe(true);
    }
    const denied = consumeDailyLimit(u, 'describe', 3);
    expect(denied.allowed).toBe(false);
    expect(denied.count).toBe(3); // отклонённая попытка не записана
    // другой kind — независимый счётчик
    expect(consumeDailyLimit(u, 'projects', 3).allowed).toBe(true);
  });

  it('dayKey — UTC-сутки', () => {
    expect(dayKey(Date.UTC(2026, 6, 19, 23, 59))).toBe('2026-07-19');
    expect(dayKey(Date.UTC(2026, 6, 20, 0, 1))).toBe('2026-07-20');
  });
});

describe('ротация не трогает queued-проекты', () => {
  it('source очередного проекта переживает enforceStorageCap', () => {
    const db = getDb();
    // кап в 0 → ротация хочет чистить всё, что можно
    const origCap = config.storageCapBytes;
    (config as { storageCapBytes: number }).storageCapBytes = 1;
    try {
      const pQueued = readyProject(OWNER_ID);
      db.prepare(`INSERT INTO generations (id, project_id, version, status) VALUES (?, ?, 1, 'queued')`).run(
        randomUUID(),
        pQueued,
      );
      const pIdle = readyProject(OWNER_ID);
      enforceStorageCap();
      const queuedRow = db.prepare(`SELECT video_purged FROM projects WHERE id = ?`).get(pQueued) as {
        video_purged: number;
      };
      const idleRow = db.prepare(`SELECT video_purged FROM projects WHERE id = ?`).get(pIdle) as {
        video_purged: number;
      };
      expect(queuedRow.video_purged).toBe(0); // исходник очередного цел
      expect(idleRow.video_purged).toBe(1); // обычный старый — вычищен
      db.prepare(`UPDATE generations SET status='failed' WHERE project_id = ?`).run(pQueued);
    } finally {
      (config as { storageCapBytes: number }).storageCapBytes = origCap;
    }
  });
});
