// Мини-воркер: FIFO, глобальный кап, пер-юзер=1, исходы (done/qc_review/failed+release),
// resume после «рестарта». Провайдер/QC — фейки через setCarouselWorkerDepsForTests.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-carousel-worker-'));
process.env.CAROUSEL_CONCURRENCY = '2';
process.env.PRICING_OVERRIDES = JSON.stringify({
  'gpt-image-2': { inPerM: 10, outPerM: 40 },
  'gpt-5.6-luna': { inPerM: 2, outPerM: 8 },
  'gpt-5.6-terra': { inPerM: 0.5, outPerM: 2 },
});

const { getDb } = await import('../src/db');
const { grantPurchase, creditBalance } = await import('../src/billing/credits');
const { startGenerationHold } = await import('../src/engine/carousel/billing');
const {
  carouselQueuePosition,
  enqueueCarouselRun,
  pumpCarousels,
  resumeCarousels,
  setCarouselWorkerDepsForTests,
  waitCarouselWorkerIdle,
} = await import('../src/engine/carousel/worker');
const { ensureModelDirs, modelRefsDir } = await import('../src/storage');
import type { ImageProvider } from '../src/image/provider';
import type { QcVerdict } from '../../shared/carousel';

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const GOOD: QcVerdict = { identity: 9, artifacts: 8, realism: 8, sceneMatch: true, notes: '' };
const BAD: QcVerdict = { identity: 3, artifacts: 3, realism: 3, sceneMatch: false, notes: '' };

function seedUser(): string {
  const id = randomUUID();
  getDb()
    .prepare(`INSERT INTO users (id, telegram_id, tg_username) VALUES (?, ?, ?)`)
    .run(id, Math.floor(Math.random() * 1e9), 'w-user');
  grantPurchase(id, 500_000, `seed-${randomUUID()}`, 'seed');
  return id;
}

function seedModelFor(userId: string): { modelId: string; variantId: string } {
  const db = getDb();
  const modelId = randomUUID();
  const variantId = randomUUID();
  db.prepare(`INSERT INTO models (id, user_id, name) VALUES (?, ?, 'M')`).run(modelId, userId);
  db.prepare(`INSERT INTO model_variants (id, model_id, title, idx) VALUES (?, ?, 'V', 0)`).run(variantId, modelId);
  ensureModelDirs(modelId);
  fs.writeFileSync(path.join(modelRefsDir(modelId), 'sheet.jpg'), PIXEL);
  db.prepare(
    `INSERT INTO model_refs (id, model_id, variant_id, file, role, note, idx) VALUES (?, ?, ?, 'sheet.jpg', 'model', 'N', 0)`,
  ).run(randomUUID(), modelId, variantId);
  return { modelId, variantId };
}

function storyboardJson(n: number): string {
  return JSON.stringify({
    slides: Array.from({ length: n }, (_, i) => ({
      idx: i + 1,
      role: i === 0 ? 'hook' : 'payoff',
      sceneId: 'south-beach-sand',
      action: `a${i + 1}`,
      outfit: 'dress',
      camera: 'phone',
      useProductRef: false,
    })),
    anchorNote: 'lock',
  });
}

function seedReadyCarousel(userId: string, slideCount = 2): string {
  const { modelId, variantId } = seedModelFor(userId);
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO carousel_projects (id, user_id, model_id, variant_id, status, storyboard_json, slide_count, idea_json)
       VALUES (?, ?, ?, ?, 'storyboard', ?, ?, '{"ugcPreset":"casual"}')`,
    )
    .run(id, userId, modelId, variantId, storyboardJson(slideCount), slideCount);
  startGenerationHold(id, userId, slideCount);
  getDb().prepare(`UPDATE carousel_projects SET status='generating' WHERE id=?`).run(id);
  return id;
}

function slowOkProvider(delayMs: number, active: { peak: number; now: number }): ImageProvider {
  return {
    name: () => 'fake',
    async edit() {
      active.now++;
      active.peak = Math.max(active.peak, active.now);
      await new Promise((r) => setTimeout(r, delayMs));
      active.now--;
      return { b64: PIXEL.toString('base64'), model: 'f', tokensIn: 1, tokensOut: 1 };
    },
  };
}

const qcOf = (verdicts: QcVerdict[]) => ({
  name: () => 'q',
  async structured() {
    return verdicts.length > 1 ? verdicts.shift()! : verdicts[0]!;
  },
});

function projectRow(id: string): { status: string; error: string | null; review_deadline: string | null } {
  return getDb()
    .prepare(`SELECT status, error, review_deadline FROM carousel_projects WHERE id=?`)
    .get(id) as never;
}

beforeEach(() => setCarouselWorkerDepsForTests(null));
afterEach(async () => {
  await waitCarouselWorkerIdle();
  setCarouselWorkerDepsForTests(null);
});

describe('carousel: воркер', () => {
  it('happy: generating → done, hold settled', async () => {
    const userId = seedUser();
    const id = seedReadyCarousel(userId);
    setCarouselWorkerDepsForTests({
      provider: slowOkProvider(1, { peak: 0, now: 0 }),
      qcLlm: qcOf([GOOD]),
    });
    enqueueCarouselRun(id);
    await waitCarouselWorkerIdle();
    expect(projectRow(id).status).toBe('done');
    expect(creditBalance(userId).held).toBe(0);
  });

  it('needs_review слайд → qc_review + дедлайн, hold остаётся открытой', async () => {
    const userId = seedUser();
    const id = seedReadyCarousel(userId);
    setCarouselWorkerDepsForTests({
      provider: slowOkProvider(1, { peak: 0, now: 0 }),
      qcLlm: qcOf([GOOD, BAD, BAD]), // якорь ок; слайд 2 дважды плохой
    });
    enqueueCarouselRun(id);
    await waitCarouselWorkerIdle();
    const row = projectRow(id);
    expect(row.status).toBe('qc_review');
    expect(row.review_deadline).toBeTruthy();
    expect(creditBalance(userId).held).toBeGreaterThan(0);
  });

  it('фатальный ран (модель удалена) → failed + полный возврат', async () => {
    const userId = seedUser();
    const id = seedReadyCarousel(userId);
    getDb().prepare(`UPDATE carousel_projects SET model_id=NULL WHERE id=?`).run(id);
    const before = creditBalance(userId).balance;
    setCarouselWorkerDepsForTests({
      provider: slowOkProvider(1, { peak: 0, now: 0 }),
      qcLlm: qcOf([GOOD]),
    });
    enqueueCarouselRun(id);
    await waitCarouselWorkerIdle();
    const row = projectRow(id);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/модел/i);
    expect(creditBalance(userId).balance).toBe(before);
    expect(creditBalance(userId).held).toBe(0);
  });

  it('пер-юзер = 1: две карусели одного юзера идут последовательно; глобальный кап 2 работает для разных', async () => {
    const active = { peak: 0, now: 0 };
    setCarouselWorkerDepsForTests({ provider: slowOkProvider(25, active), qcLlm: qcOf([GOOD]) });
    const u1 = seedUser();
    const a = seedReadyCarousel(u1);
    const b = seedReadyCarousel(u1); // тот же юзер — должен ждать
    const u2 = seedUser();
    const c = seedReadyCarousel(u2); // другой юзер — параллельно с a
    expect(carouselQueuePosition(b)).toBeGreaterThan(0);
    pumpCarousels();
    await waitCarouselWorkerIdle();
    for (const id of [a, b, c]) expect(projectRow(id).status).toBe('done');
    expect(active.peak).toBe(2); // глобальный кап соблюдён и использован
  });

  it('resume: карусель в generating после «рестарта» докатывается', async () => {
    const userId = seedUser();
    const id = seedReadyCarousel(userId);
    // «Рестарт»: строка есть, воркер чист.
    setCarouselWorkerDepsForTests({
      provider: slowOkProvider(1, { peak: 0, now: 0 }),
      qcLlm: qcOf([GOOD]),
    });
    resumeCarousels();
    await waitCarouselWorkerIdle();
    expect(projectRow(id).status).toBe('done');
  });
});
