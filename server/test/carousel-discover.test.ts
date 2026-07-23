// P9 автоподбор: topAuthors (чистый), гейт collectionId (fail-closed + фикс vision-майнинга),
// auto/start (подборка+темы, микро-hold честный, бедный → 402 и подборка не остаётся),
// discovery-ран E2E на фейках (хэштеги → аккаунты → профили → карточки → settle).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-carousel-discover-'));
process.env.AUTH_DEV_BYPASS = '1';
process.env.CAROUSEL_STUDIO = '1';
process.env.MINER_RUN_COST_USD_PER_100 = '1';
process.env.PRICING_OVERRIDES = JSON.stringify({
  'gpt-image-2': { inPerM: 10, outPerM: 40 },
  'gpt-5.6-luna': { inPerM: 2, outPerM: 8 },
  'gpt-5.6-terra': { inPerM: 0.5, outPerM: 2 },
});

const { buildApp } = await import('../src/app');
const { getDb } = await import('../src/db');
const { BillingAttemptRequiredError, requireActiveAttempt } = await import('../src/billing/attempts');
const { creditBalance, grantPurchase, placeHold } = await import('../src/billing/credits');
const { topAuthors } = await import('../src/engine/miner/discover');
const { setCarouselLlmForTests } = await import('../src/engine/carousel/engines');
const { setMinerDepsForTests, waitMinerIdle } = await import('../src/engine/miner/run');
const { recordUsage } = await import('../src/usage');

import type { FastifyInstance } from 'fastify';
import type { StructuredRequest } from '../src/llm/provider';

const THEMES = {
  themes: [
    { label: 'Мото-девушка', hashtags: ['bikerlifestyle', 'motogirl'] },
    { label: 'Пляж Майами', hashtags: ['miamibeach', 'beachmodel'] },
    { label: 'Спортзал', hashtags: ['gymgirl', 'fitmodel'] },
  ],
};
const CARD = {
  hookType: 'mid-action candid',
  slideCount: 4,
  slideRoles: ['hook', 'context', 'payoff', 'cta'],
  composition: ['tight crop'],
  captionStyle: 'hook → story → CTA',
  whyItWorks: 'relatable',
  nicheTags: ['moto'],
};

function fakeLlm(userId: string) {
  return {
    name: () => 'fake',
    async structured(req: StructuredRequest) {
      recordUsage({
        projectId: req.meta?.projectId ?? req.meta?.carouselId ?? req.meta?.collectionId,
        generationId: req.meta?.generationId,
        userId,
        task: req.schemaName,
        model: 'gpt-5.6-luna',
        tokensIn: 200,
        tokensOut: 200,
      });
      if (req.schemaName === 'carousel_discover') return THEMES;
      if (req.schemaName === 'carousel_pattern') return CARD;
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
  const res = await app.inject({ method: 'POST', url: '/api/auth/dev-login', payload: { telegramId, name: 'D' } });
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

describe('miner: topAuthors', () => {
  it('агрегирует лайки по автору, чистит мусор, режет топ', () => {
    const items = [
      { ownerUsername: 'Anna_M', likesCount: 5000 },
      { ownerUsername: 'anna_m', likesCount: 3000 },
      { ownerUsername: 'bea.b', likesCount: 7000 },
      { ownerUsername: 'плохой', likesCount: 9999 },
      { ownerUsername: '', likesCount: 100 },
      { ownerUsername: 'cee', likesCount: 100 },
    ];
    expect(topAuthors(items, 2)).toEqual(['anna_m', 'bea.b']);
  });
});

describe('miner: гейт collectionId', () => {
  it('fail-closed: нет подборки/нет hold — отказ; своя open-hold — пропуск', () => {
    const userId = randomUUID();
    getDb()
      .prepare(`INSERT INTO users (id, telegram_id, tg_username) VALUES (?, ?, 'g')`)
      .run(userId, Math.floor(Math.random() * 1e9));
    grantPurchase(userId, 10_000, `seed-${randomUUID()}`, 'seed');
    expect(() => requireActiveAttempt({ collectionId: randomUUID() })).toThrow(BillingAttemptRequiredError);
    const collectionId = randomUUID();
    getDb()
      .prepare(`INSERT INTO collections (id, user_id, name) VALUES (?, ?, 'C')`)
      .run(collectionId, userId);
    expect(() => requireActiveAttempt({ collectionId })).toThrow(BillingAttemptRequiredError);
    const hold = placeHold(userId, collectionId, 100);
    if (!hold.ok) throw new Error('hold не встал');
    expect(requireActiveAttempt({ collectionId })).toBe(hold.holdId);
  });
});

describe('miner: автоподбор', () => {
  let app: FastifyInstance;
  let user: Creds;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    user = await login(app, 7001);
    grantPurchase(user.userId, 100_000, `seed-${randomUUID()}`, 'seed');
    setCarouselLlmForTests(fakeLlm(user.userId));
  });

  afterAll(async () => {
    setCarouselLlmForTests(null);
    await app.close();
  });

  it('auto/start: подборка + темы, микро-hold списан и закрыт', async () => {
    const before = creditBalance(user.userId);
    const res = await app.inject({ method: 'POST', url: '/api/miner/auto/start', headers: authed(user), payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { collectionId: string; themes: Array<{ label: string }> };
    expect(body.themes).toHaveLength(3);
    const after = creditBalance(user.userId);
    expect(after.held).toBe(0);
    expect(before.balance - after.balance).toBeGreaterThan(0);
    const col = getDb().prepare(`SELECT name FROM collections WHERE id=?`).get(body.collectionId) as { name: string };
    expect(col.name).toContain('Авто');
  });

  it('auto/start бедному юзеру → 402, подборка-огрызок не остаётся', async () => {
    const poor = await login(app, 7002);
    const countBefore = (getDb().prepare(`SELECT COUNT(*) AS c FROM collections`).get() as { c: number }).c;
    const res = await app.inject({ method: 'POST', url: '/api/miner/auto/start', headers: authed(poor), payload: {} });
    expect(res.statusCode).toBe(402);
    const countAfter = (getDb().prepare(`SELECT COUNT(*) AS c FROM collections`).get() as { c: number }).c;
    expect(countAfter).toBe(countBefore);
  });

  it('mine с хэштегами: discovery → профили → карточки → done, hold закрыт по факту', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/miner/auto/start', headers: authed(user), payload: {} });
    const { collectionId } = start.json() as { collectionId: string };

    const hashtagItems = [
      { ownerUsername: 'viral_girl', likesCount: 9000 },
      { ownerUsername: 'other_girl', likesCount: 4000 },
    ];
    const profileItems = [
      {
        username: 'viral_girl',
        followersCount: 80_000,
        latestPosts: [
          { type: 'Sidecar', url: 'https://ig/p/9', likesCount: 7000, commentsCount: 300, timestamp: '2026-07-20T00:00:00Z', displayUrl: 'https://cdn/t9.jpg', childPosts: [1, 2, 3] },
        ],
      },
    ];
    let hashtagRun = false;
    setMinerDepsForTests({
      apifyClient: {
        async startActorRun(actorId: string) {
          const isHashtag = actorId.includes('hashtag');
          if (isHashtag) hashtagRun = true;
          return { runId: isHashtag ? 'ht-run' : 'pf-run', defaultDatasetId: null };
        },
        async getRun(runId: string) {
          return { status: 'SUCCEEDED', defaultDatasetId: runId === 'ht-run' ? 'ds-ht' : 'ds-pf' };
        },
        async datasetItems(datasetId: string) {
          return datasetId === 'ds-ht' ? hashtagItems : profileItems;
        },
      } as never,
      llm: fakeLlm(user.userId),
      thumbFetch: (async () => new Response(Buffer.alloc(400), { status: 200 })) as unknown as typeof fetch,
      pollMs: 1,
    });

    const before = creditBalance(user.userId);
    const mine = await app.inject({
      method: 'POST',
      url: `/api/miner/collections/${collectionId}/mine`,
      headers: authed(user),
      payload: { hashtags: ['bikerlifestyle', 'motogirl'] },
    });
    expect(mine.statusCode).toBe(200);
    await waitMinerIdle();

    expect(hashtagRun).toBe(true);
    const run = getDb()
      .prepare(`SELECT status, stats_json, discover_run_id FROM mining_runs WHERE collection_id=? ORDER BY rowid DESC`)
      .get(collectionId) as { status: string; stats_json: string; discover_run_id: string };
    expect(run.status).toBe('done');
    expect(run.discover_run_id).toBe('ht-run');
    const stats = JSON.parse(run.stats_json) as { accounts: string[]; cards: number };
    expect(stats.accounts[0]).toBe('viral_girl');
    expect(stats.cards).toBe(1);
    const cards = getDb()
      .prepare(`SELECT COUNT(*) AS c FROM pattern_cards WHERE collection_id=?`)
      .get(collectionId) as { c: number };
    expect(cards.c).toBe(1);
    const after = creditBalance(user.userId);
    expect(after.held).toBe(0);
    expect(before.balance - after.balance).toBeGreaterThan(0);
    setMinerDepsForTests(null);
  });
});
