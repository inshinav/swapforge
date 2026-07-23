// Роуты Carousel Studio v1 (SPEC §9) на РЕАЛЬНОМ приложении (buildApp + inject):
// флаг, CRUD, тенантность, generate-гейты (hold/409/402+shortfall), file-гард.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-carousel-routes-'));
process.env.AUTH_DEV_BYPASS = '1';
process.env.OWNER_TELEGRAM_ID = '9100';
process.env.CAROUSEL_STUDIO = '1';
process.env.PRICING_OVERRIDES = JSON.stringify({
  'gpt-image-2': { inPerM: 10, outPerM: 40 },
  'gpt-5.6-luna': { inPerM: 2, outPerM: 8 },
  'gpt-5.6-terra': { inPerM: 0.5, outPerM: 2 },
});

const { buildApp } = await import('../src/app');
const { getDb } = await import('../src/db');
const { grantPurchase } = await import('../src/billing/credits');
const { carouselSlidesDir, ensureCarouselDirs, ensureModelDirs, modelRefsDir } = await import(
  '../src/storage'
);
const { setCarouselWorkerDepsForTests, waitCarouselWorkerIdle } = await import(
  '../src/engine/carousel/worker'
);

// Блокирующий провайдер: ран висит, пока тест не отпустит — статусы детерминированы.
let releaseRun: (() => void) | null = null;
setCarouselWorkerDepsForTests({
  provider: {
    name: () => 'blocking',
    edit: () =>
      new Promise((_, reject) => {
        releaseRun = () => reject(new Error('тест отпустил ран'));
      }),
  },
});

import type { FastifyInstance } from 'fastify';

interface Creds {
  cookie: string;
  csrf: string;
  userId: string;
}

async function login(app: FastifyInstance, telegramId: number, name: string): Promise<Creds> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/dev-login', payload: { telegramId, name } });
  expect(res.statusCode).toBe(200);
  const setCookies = res.headers['set-cookie'] as string[];
  const sess = setCookies.find((c) => c.startsWith('sf_sess='))!.split(';')[0]!;
  const csrfPair = setCookies.find((c) => c.startsWith('sf_csrf='))!.split(';')[0]!;
  const csrf = decodeURIComponent(csrfPair.split('=').slice(1).join('='));
  return { cookie: `${sess}; ${csrfPair}`, csrf, userId: (res.json() as { user: { id: string } }).user.id };
}

const authed = (c: Creds) => ({ cookie: c.cookie, 'x-sf-csrf': c.csrf });

function seedModelFor(userId: string): { modelId: string; variantId: string } {
  const db = getDb();
  const modelId = randomUUID();
  const variantId = randomUUID();
  db.prepare(`INSERT INTO models (id, user_id, name) VALUES (?, ?, 'M')`).run(modelId, userId);
  db.prepare(`INSERT INTO model_variants (id, model_id, title, idx) VALUES (?, ?, 'V', 0)`).run(variantId, modelId);
  ensureModelDirs(modelId);
  fs.writeFileSync(path.join(modelRefsDir(modelId), 'sheet.jpg'), Buffer.alloc(64));
  db.prepare(
    `INSERT INTO model_refs (id, model_id, variant_id, file, role, note, idx) VALUES (?, ?, ?, 'sheet.jpg', 'model', 'N', 0)`,
  ).run(randomUUID(), modelId, variantId);
  return { modelId, variantId };
}

const STORYBOARD = JSON.stringify({
  slides: [
    { idx: 1, role: 'hook', sceneId: 'south-beach-sand', action: 'a', outfit: 'o', camera: 'c', useProductRef: false },
    { idx: 2, role: 'payoff', sceneId: 'open-air-cafe', action: 'a', outfit: 'o', camera: 'c', useProductRef: false },
  ],
  anchorNote: 'lock',
});

describe('carousel: роуты', () => {
  let app: FastifyInstance;
  let userA: Creds;
  let userB: Creds;
  let model: { modelId: string; variantId: string };

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    userA = await login(app, 2001, 'А');
    userB = await login(app, 2002, 'Б');
    grantPurchase(userA.userId, 100_000, `seed-${randomUUID()}`, 'seed');
    model = seedModelFor(userA.userId);
  });

  afterAll(async () => {
    releaseRun?.();
    await waitCarouselWorkerIdle();
    setCarouselWorkerDepsForTests(null);
    await app.close();
  });

  it('/api/me отдаёт carouselStudio=true при включённом флаге', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: authed(userA) });
    expect((me.json() as { carouselStudio?: boolean }).carouselStudio).toBe(true);
  });

  it('аноним → 401; список пустой у нового юзера; паки отдаются', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/carousel/projects' })).statusCode).toBe(401);
    const list = await app.inject({ method: 'GET', url: '/api/carousel/projects', headers: authed(userB) });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { carousels: unknown[] }).carousels).toEqual([]);
    const packs = await app.inject({ method: 'GET', url: '/api/carousel/packs', headers: authed(userA) });
    expect((packs.json() as { packs: Array<{ id: string; scenes: unknown[] }> }).packs[0]?.id).toBe('miami');
  });

  it('создание: чужая модель → 404, мутация без CSRF → 403, ок-путь создаёт draft', async () => {
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/carousel/projects',
      headers: { cookie: userA.cookie },
      payload: { modelId: model.modelId, variantId: model.variantId },
    });
    expect(noCsrf.statusCode).toBe(403);

    const foreign = await app.inject({
      method: 'POST',
      url: '/api/carousel/projects',
      headers: authed(userB),
      payload: { modelId: model.modelId, variantId: model.variantId },
    });
    expect(foreign.statusCode).toBe(404);

    const ok = await app.inject({
      method: 'POST',
      url: '/api/carousel/projects',
      headers: authed(userA),
      payload: { modelId: model.modelId, variantId: model.variantId, slideCount: 4, title: 'Тест' },
    });
    expect(ok.statusCode).toBe(200);
    const carousel = (ok.json() as { carousel: { id: string; status: string; slideCount: number } }).carousel;
    expect(carousel.status).toBe('draft');
    expect(carousel.slideCount).toBe(4);
  });

  it('тенантность: чужая карусель → 404 на GET/DELETE/generate/quote', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/carousel/projects',
      headers: authed(userA),
      payload: { modelId: model.modelId, variantId: model.variantId },
    });
    const id = (created.json() as { carousel: { id: string } }).carousel.id;
    for (const [method, url] of [
      ['GET', `/api/carousel/projects/${id}`],
      ['DELETE', `/api/carousel/projects/${id}`],
      ['POST', `/api/carousel/projects/${id}/generate`],
      ['GET', `/api/carousel/projects/${id}/quote`],
    ] as const) {
      const res = await app.inject({ method, url, headers: authed(userB) });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it('generate: без storyboard → 409; ок ставит hold+generating; повтор → 409; бедный → 402 с shortfall', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/carousel/projects',
      headers: authed(userA),
      payload: { modelId: model.modelId, variantId: model.variantId },
    });
    const id = (created.json() as { carousel: { id: string } }).carousel.id;

    const early = await app.inject({ method: 'POST', url: `/api/carousel/projects/${id}/generate`, headers: authed(userA) });
    expect(early.statusCode).toBe(409);

    getDb().prepare(`UPDATE carousel_projects SET storyboard_json=?, status='storyboard' WHERE id=?`).run(STORYBOARD, id);
    const ok = await app.inject({ method: 'POST', url: `/api/carousel/projects/${id}/generate`, headers: authed(userA) });
    expect(ok.statusCode).toBe(200);
    const row = getDb().prepare(`SELECT status, hold_id, run_id FROM carousel_projects WHERE id=?`).get(id) as {
      status: string;
      hold_id: string;
      run_id: string;
    };
    expect(row.status).toBe('generating');
    expect(row.hold_id).toBeTruthy();

    const again = await app.inject({ method: 'POST', url: `/api/carousel/projects/${id}/generate`, headers: authed(userA) });
    expect(again.statusCode).toBe(409);

    // Бедный юзер со своей моделью и раскадровкой.
    const poor = await login(app, 2003, 'Бедный');
    const pm = seedModelFor(poor.userId);
    const pc = await app.inject({
      method: 'POST',
      url: '/api/carousel/projects',
      headers: authed(poor),
      payload: { modelId: pm.modelId, variantId: pm.variantId },
    });
    const pid = (pc.json() as { carousel: { id: string } }).carousel.id;
    getDb().prepare(`UPDATE carousel_projects SET storyboard_json=?, status='storyboard' WHERE id=?`).run(STORYBOARD, pid);
    const denied = await app.inject({ method: 'POST', url: `/api/carousel/projects/${pid}/generate`, headers: authed(poor) });
    expect(denied.statusCode).toBe(402);
    const body = denied.json() as { shortfallUsd: number; needUsd: number };
    expect(body.shortfallUsd).toBeGreaterThan(0);
    expect(body.needUsd).toBeGreaterThan(0);
  });

  it('DELETE: generating → 409; draft → ok; file-роут отдаёт слайд и режет травёрсал', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/carousel/projects',
      headers: authed(userA),
      payload: { modelId: model.modelId, variantId: model.variantId },
    });
    const id = (created.json() as { carousel: { id: string } }).carousel.id;
    getDb().prepare(`UPDATE carousel_projects SET status='generating' WHERE id=?`).run(id);
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/carousel/projects/${id}`, headers: authed(userA) })).statusCode,
    ).toBe(409);
    getDb().prepare(`UPDATE carousel_projects SET status='draft' WHERE id=?`).run(id);

    ensureCarouselDirs(id);
    fs.writeFileSync(path.join(carouselSlidesDir(id), 'slide_01.png'), Buffer.alloc(16));
    const file = await app.inject({ method: 'GET', url: `/api/carousel/${id}/file/slide_01.png`, headers: authed(userA) });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    const trav = await app.inject({ method: 'GET', url: `/api/carousel/${id}/file/..%2Fsecret.txt`, headers: authed(userA) });
    expect(trav.statusCode).toBe(404);

    expect(
      (await app.inject({ method: 'DELETE', url: `/api/carousel/projects/${id}`, headers: authed(userA) })).statusCode,
    ).toBe(200);
    expect(fs.existsSync(carouselSlidesDir(id))).toBe(false);
  });
});
