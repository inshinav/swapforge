// Движки Idea/Storyboard/Caption через роуты (SPEC §4): микро-холды считаются честно,
// невалидный LLM-JSON → 502 и полный возврат, правки раскадровки нормализуются,
// статус-гейты 409, цены идеации отдаются для кнопок.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-carousel-engines-'));
process.env.AUTH_DEV_BYPASS = '1';
process.env.OWNER_TELEGRAM_ID = '9200';
process.env.CAROUSEL_STUDIO = '1';
process.env.PRICING_OVERRIDES = JSON.stringify({
  'gpt-image-2': { inPerM: 10, outPerM: 40 },
  'gpt-5.6-luna': { inPerM: 2, outPerM: 8 },
  'gpt-5.6-terra': { inPerM: 0.5, outPerM: 2 },
});

const { buildApp } = await import('../src/app');
const { getDb } = await import('../src/db');
const { creditBalance, grantPurchase } = await import('../src/billing/credits');
const { setCarouselLlmForTests } = await import('../src/engine/carousel/engines');
const { ensureModelDirs, modelRefsDir } = await import('../src/storage');
const { recordUsage } = await import('../src/usage');

import type { FastifyInstance } from 'fastify';
import type { StructuredRequest } from '../src/llm/provider';

const IDEA = {
  title: 'Утро у океана',
  hook: 'Так выглядит мой вторник',
  concept: 'Пляж, кофе, прогулка.',
  slideCount: 2,
  sceneIds: ['south-beach-sand', 'open-air-cafe'],
  ugcPreset: 'casual',
};
const STORYBOARD = {
  slides: [
    { idx: 5, role: 'hook', sceneId: 'south-beach-sand', action: 'a', outfit: 'o', camera: 'c', useProductRef: false },
    { idx: 9, role: 'payoff', sceneId: 'open-air-cafe', action: 'b', outfit: 'o', camera: 'c', useProductRef: false },
  ],
  anchorNote: 'lock the look',
};
const CAPTION = {
  caption: 'my tuesday looked like this…',
  hashtags: Array.from({ length: 11 }, (_, i) => `#t${i}`),
  hookLine: 'you need this tuesday',
};

/** Фейковый LLM: отвечает по schemaName; пишет usage-строку как настоящий импл. */
function fakeLlm(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: () => 'fake',
    async structured(req: StructuredRequest) {
      recordUsage({
        projectId: req.meta?.projectId ?? req.meta?.carouselId,
        generationId: req.meta?.generationId,
        userId: req.meta?.userId,
        task: req.schemaName,
        model: 'gpt-5.6-luna',
        tokensIn: 500,
        tokensOut: 500,
      });
      if (req.schemaName in overrides) return overrides[req.schemaName];
      if (req.schemaName === 'carousel_idea') return { ideas: [IDEA, IDEA, IDEA] };
      if (req.schemaName === 'carousel_storyboard') return STORYBOARD;
      if (req.schemaName === 'carousel_caption') return CAPTION;
      throw new Error(`неожиданный schemaName ${req.schemaName}`);
    },
  };
}

interface Creds {
  cookie: string;
  csrf: string;
  userId: string;
}

async function login(app: FastifyInstance, telegramId: number): Promise<Creds> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/dev-login', payload: { telegramId, name: 'E' } });
  const setCookies = res.headers['set-cookie'] as string[];
  const sess = setCookies.find((c) => c.startsWith('sf_sess='))!.split(';')[0]!;
  const csrfPair = setCookies.find((c) => c.startsWith('sf_csrf='))!.split(';')[0]!;
  return {
    cookie: `${sess}; ${csrfPair}`,
    csrf: decodeURIComponent(csrfPair.split('=').slice(1).join('=')),
    userId: (res.json() as { user: { id: string } }).user.id,
  };
}

const authed = (c: Creds) => ({ cookie: c.cookie, 'x-sf-csrf': c.csrf });

describe('carousel: движки', () => {
  let app: FastifyInstance;
  let user: Creds;
  let carouselId: string;

  beforeAll(async () => {
    setCarouselLlmForTests(fakeLlm());
    app = await buildApp({ logger: false });
    user = await login(app, 4001);
    grantPurchase(user.userId, 100_000, `seed-${randomUUID()}`, 'seed');
    const db = getDb();
    const modelId = randomUUID();
    const variantId = randomUUID();
    db.prepare(`INSERT INTO models (id, user_id, name) VALUES (?, ?, 'M')`).run(modelId, user.userId);
    db.prepare(`INSERT INTO model_variants (id, model_id, title, idx) VALUES (?, ?, 'V', 0)`).run(variantId, modelId);
    ensureModelDirs(modelId);
    fs.writeFileSync(path.join(modelRefsDir(modelId), 's.jpg'), Buffer.alloc(32));
    db.prepare(
      `INSERT INTO model_refs (id, model_id, variant_id, file, role, note, idx) VALUES (?, ?, ?, 's.jpg', 'model', 'Persona note.', 0)`,
    ).run(randomUUID(), modelId, variantId);
    const created = await app.inject({
      method: 'POST',
      url: '/api/carousel/projects',
      headers: authed(user),
      payload: { modelId, variantId },
    });
    carouselId = (created.json() as { carousel: { id: string } }).carousel.id;
  });

  afterAll(async () => {
    setCarouselLlmForTests(null);
    await app.close();
  });

  it('цены идеации отдаются для кнопок', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/carousel/ideation-prices', headers: authed(user) });
    const prices = res.json() as { ideasUsd: number; storyboardUsd: number; captionUsd: number };
    expect(prices.ideasUsd).toBeGreaterThan(0);
    expect(prices.captionUsd).toBeGreaterThan(0);
  });

  it('ideas → 3 идеи, микро-hold списан честно и закрыт', async () => {
    const before = creditBalance(user.userId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/carousel/projects/${carouselId}/ideas`,
      headers: authed(user),
      payload: { wish: 'хочу пляж' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { ideas: unknown[] }).ideas).toHaveLength(3);
    const after = creditBalance(user.userId);
    expect(after.held).toBe(0);
    expect(before.balance - after.balance).toBeGreaterThan(0);
  });

  it('выбор идеи пишет idea_json/slide_count; чужая сцена → 422', async () => {
    const badIdea = { ...IDEA, sceneIds: ['tokyo-tower'] };
    const rejected = await app.inject({
      method: 'POST',
      url: `/api/carousel/projects/${carouselId}/idea`,
      headers: authed(user),
      payload: { idea: badIdea },
    });
    expect(rejected.statusCode).toBe(422);

    const ok = await app.inject({
      method: 'POST',
      url: `/api/carousel/projects/${carouselId}/idea`,
      headers: authed(user),
      payload: { idea: IDEA },
    });
    expect(ok.statusCode).toBe(200);
    const row = getDb().prepare(`SELECT idea_json, slide_count FROM carousel_projects WHERE id=?`).get(carouselId) as {
      idea_json: string;
      slide_count: number;
    };
    expect(JSON.parse(row.idea_json).title).toBe(IDEA.title);
    expect(row.slide_count).toBe(2);
  });

  it('storyboard: генерация пишет json+status; PATCH нормализует idx и валидирует сцены', async () => {
    const gen = await app.inject({
      method: 'POST',
      url: `/api/carousel/projects/${carouselId}/storyboard`,
      headers: authed(user),
    });
    expect(gen.statusCode).toBe(200);
    const row = getDb().prepare(`SELECT status, storyboard_json FROM carousel_projects WHERE id=?`).get(carouselId) as {
      status: string;
      storyboard_json: string;
    };
    expect(row.status).toBe('storyboard');

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/carousel/projects/${carouselId}/storyboard`,
      headers: authed(user),
      payload: { storyboard: STORYBOARD },
    });
    expect(patched.statusCode).toBe(200);
    const slides = (patched.json() as { storyboard: { slides: Array<{ idx: number }> } }).storyboard.slides;
    expect(slides.map((s) => s.idx)).toEqual([1, 2]);

    const badScene = {
      ...STORYBOARD,
      slides: [{ ...STORYBOARD.slides[0], sceneId: 'mars-base' }, STORYBOARD.slides[1]],
    };
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/carousel/projects/${carouselId}/storyboard`,
          headers: authed(user),
          payload: { storyboard: badScene },
        })
      ).statusCode,
    ).toBe(422);
  });

  it('caption: генерится и пишется; при generating — 409', async () => {
    const ok = await app.inject({
      method: 'POST',
      url: `/api/carousel/projects/${carouselId}/caption`,
      headers: authed(user),
      payload: { language: 'en' },
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { caption: { hashtags: string[] } }).caption.hashtags.length).toBeGreaterThanOrEqual(10);

    getDb().prepare(`UPDATE carousel_projects SET status='generating' WHERE id=?`).run(carouselId);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/carousel/projects/${carouselId}/caption`,
          headers: authed(user),
          payload: {},
        })
      ).statusCode,
    ).toBe(409);
    getDb().prepare(`UPDATE carousel_projects SET status='storyboard' WHERE id=?`).run(carouselId);
  });

  it('невалидный LLM-JSON → 502, hold released, баланс не тронут', async () => {
    setCarouselLlmForTests(fakeLlm({ carousel_idea: { garbage: true } }));
    const before = creditBalance(user.userId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/carousel/projects/${carouselId}/ideas`,
      headers: authed(user),
      payload: {},
    });
    expect(res.statusCode).toBe(502);
    const after = creditBalance(user.userId);
    expect(after.balance).toBe(before.balance);
    expect(after.held).toBe(0);
    setCarouselLlmForTests(fakeLlm());
  });

  it('статус-гейт: при generating идеи → 409', async () => {
    getDb().prepare(`UPDATE carousel_projects SET status='generating' WHERE id=?`).run(carouselId);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/carousel/projects/${carouselId}/ideas`,
          headers: authed(user),
          payload: {},
        })
      ).statusCode,
    ).toBe(409);
    getDb().prepare(`UPDATE carousel_projects SET status='storyboard' WHERE id=?`).run(carouselId);
  });
});
