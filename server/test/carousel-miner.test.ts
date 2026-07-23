// Reference Miner (SPEC §3): virality-фильтр (таблица), нормализация профилей,
// mining run E2E на фейках (hold→актор→фильтр→карточки→settle; провал→возврат),
// легальные гарды (mined-пути в генерацию → reject; в карточке нет текста подписи).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-carousel-miner-'));
process.env.MINER_RUN_COST_USD_PER_100 = '1';
process.env.PRICING_OVERRIDES = JSON.stringify({
  'gpt-image-2': { inPerM: 10, outPerM: 40 },
  'gpt-5.6-luna': { inPerM: 2, outPerM: 8 },
  'gpt-5.6-terra': { inPerM: 0.5, outPerM: 2 },
});

const { getDb } = await import('../src/db');
const { engagementRate, normalizeProfileItems, viralityFilter } = await import('../src/engine/miner/virality');
const { assertNoMinedPaths, CarouselRunError } = await import('../src/engine/carousel/generate');
const { minerDir } = await import('../src/storage');
const { minerQuoteUsd, setMinerDepsForTests, startMiningRun, waitMinerIdle } = await import('../src/engine/miner/run');
const { creditBalance, grantPurchase } = await import('../src/billing/credits');
const { recordUsage } = await import('../src/usage');
const { PATTERN_CARD_JSON_SCHEMA } = await import('../../shared/carousel');

import type { MinedPost } from '../src/engine/miner/virality';
import type { StructuredRequest } from '../src/llm/provider';

const NOW = Date.parse('2026-07-23T00:00:00Z');

function post(over: Partial<MinedPost>): MinedPost {
  return {
    url: `https://instagram.com/p/${randomUUID().slice(0, 6)}`,
    type: 'carousel',
    likes: 5000,
    comments: 200,
    timestamp: '2026-07-01T00:00:00Z',
    ownerFollowers: 100_000,
    author: 'a',
    thumbUrl: 'https://cdn.example/t.jpg',
    slideCount: 5,
    ...over,
  };
}

describe('miner: virality-фильтр', () => {
  it('таблица кейсов: тип/лайки/свежесть/ER/topN', () => {
    const posts = [
      post({}), // проходит, ER 5.2%
      post({ type: 'video' }), // не тот тип
      post({ likes: 100, comments: 1 }), // мало лайков
      post({ timestamp: '2026-01-01T00:00:00Z' }), // старше 90 дней
      post({ ownerFollowers: 1_000_000 }), // ER 0.52% < 3%
      post({ ownerFollowers: 0 }), // нет подписчиков → ER 0
      post({ likes: 9000, comments: 1000 }), // проходит, ER 10%
    ];
    const res = viralityFilter(posts, { nowMs: NOW });
    expect(res).toHaveLength(2);
    expect(engagementRate(res[0]!)).toBeGreaterThan(engagementRate(res[1]!)); // сортировка по ER
    expect(viralityFilter(posts, { nowMs: NOW, topN: 1 })).toHaveLength(1);
  });

  it('нормализация профилей IG-скрейпера: битые элементы пропускаются', () => {
    const items = [
      {
        username: 'girl',
        followersCount: 50_000,
        latestPosts: [
          { type: 'Sidecar', url: 'u1', likesCount: 3000, commentsCount: 50, timestamp: '2026-07-10T00:00:00Z', displayUrl: 'd1', childPosts: [1, 2, 3] },
          { type: 'Video', url: 'u2', likesCount: 100, commentsCount: 5, timestamp: '2026-07-10T00:00:00Z' },
          { type: 'Image', url: null, timestamp: '2026-07-10T00:00:00Z' }, // битый
        ],
      },
      { garbage: true },
    ];
    const posts = normalizeProfileItems(items);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({ type: 'carousel', slideCount: 3, ownerFollowers: 50_000, author: 'girl' });
    expect(posts[1]?.type).toBe('video');
  });
});

describe('miner: легальные гарды', () => {
  it('mined-путь среди референсов генерации → CarouselRunError', () => {
    const evil = path.join(minerDir('col-1'), 'thumb_x.jpg');
    expect(() => assertNoMinedPaths([evil])).toThrow(CarouselRunError);
    expect(() => assertNoMinedPaths([path.join(process.env.DATA_DIR!, 'models', 'm', 'refs', 's.jpg')])).not.toThrow();
  });

  it('схема PatternCard не содержит полей с текстом подписи/контентом источника', () => {
    const keys = PATTERN_CARD_JSON_SCHEMA.required as readonly string[];
    expect(keys).not.toContain('caption');
    expect(keys).not.toContain('captionText');
    expect(keys).toContain('captionStyle'); // структура — да, текст — нет
  });
});

function seedUser(credits = 100_000): string {
  const id = randomUUID();
  getDb()
    .prepare(`INSERT INTO users (id, telegram_id, tg_username) VALUES (?, ?, ?)`)
    .run(id, Math.floor(Math.random() * 1e9), 'miner-user');
  grantPurchase(id, credits, `seed-${randomUUID()}`, 'seed');
  return id;
}

function seedCollection(userId: string): string {
  const id = randomUUID();
  getDb()
    .prepare(`INSERT INTO collections (id, user_id, name, seed_json) VALUES (?, ?, 'Girls', ?)`)
    .run(id, userId, JSON.stringify({ usernames: ['girl'], limit: 100 }));
  return id;
}

const fakeApify = (statuses: string[]) => ({
  async startActorRun() {
    return { runId: 'apify-run-1', defaultDatasetId: null };
  },
  async getRun() {
    return { status: statuses.length > 1 ? statuses.shift()! : statuses[0]!, defaultDatasetId: 'ds-1' };
  },
  async datasetItems() {
    return [
      {
        username: 'girl',
        followersCount: 100_000,
        latestPosts: [
          { type: 'Sidecar', url: 'https://ig/p/1', likesCount: 8000, commentsCount: 400, timestamp: '2026-07-15T00:00:00Z', displayUrl: 'https://cdn/t1.jpg', childPosts: [1, 2, 3, 4] },
          { type: 'Image', url: 'https://ig/p/2', likesCount: 5000, commentsCount: 100, timestamp: '2026-07-12T00:00:00Z', displayUrl: 'https://cdn/t2.jpg' },
        ],
      },
    ];
  },
});

const fakeLlm = (userId: string) => ({
  name: () => 'fake',
  async structured(req: StructuredRequest) {
    recordUsage({
      generationId: req.meta?.generationId,
      userId,
      task: req.schemaName,
      model: 'gpt-5.6-terra',
      tokensIn: 100,
      tokensOut: 100,
    });
    return {
      hookType: 'mid-action candid',
      slideCount: 4,
      slideRoles: ['hook', 'context', 'payoff', 'cta'],
      composition: ['tight crop'],
      captionStyle: 'hook → story → CTA',
      whyItWorks: 'relatable moment',
      nicheTags: ['lifestyle'],
    };
  },
});

const thumbFetch = (async () => new Response(Buffer.alloc(500), { status: 200 })) as unknown as typeof fetch;

describe('miner: mining run', () => {
  it('квота считается и растёт с лимитом', () => {
    const q100 = minerQuoteUsd(100);
    const q200 = minerQuoteUsd(200);
    expect(q100).not.toBeNull();
    expect(q200!).toBeGreaterThan(q100!);
  });

  it('happy: hold → актор → фильтр → 2 карточки → settle факта, hold закрыта', async () => {
    const userId = seedUser();
    const collectionId = seedCollection(userId);
    setMinerDepsForTests({
      apifyClient: fakeApify(['RUNNING', 'SUCCEEDED']) as never,
      llm: fakeLlm(userId),
      thumbFetch,
      pollMs: 1,
    });
    const before = creditBalance(userId);
    startMiningRun(collectionId, userId, { usernames: ['girl'], limit: 100 });
    await waitMinerIdle();
    const run = getDb()
      .prepare(`SELECT status, stats_json FROM mining_runs WHERE collection_id=?`)
      .get(collectionId) as { status: string; stats_json: string };
    expect(run.status).toBe('done');
    expect(JSON.parse(run.stats_json)).toMatchObject({ fetched: 2, passedFilter: 2, cards: 2 });
    const cards = getDb()
      .prepare(`SELECT COUNT(*) AS c FROM pattern_cards WHERE collection_id=?`)
      .get(collectionId) as { c: number };
    expect(cards.c).toBe(2);
    const after = creditBalance(userId);
    expect(after.held).toBe(0);
    expect(before.balance - after.balance).toBeGreaterThan(0); // факт списан
    setMinerDepsForTests(null);
  });

  it('актор упал → failed, полный возврат', async () => {
    const userId = seedUser();
    const collectionId = seedCollection(userId);
    setMinerDepsForTests({
      apifyClient: fakeApify(['FAILED']) as never,
      llm: fakeLlm(userId),
      thumbFetch,
      pollMs: 1,
    });
    const before = creditBalance(userId);
    startMiningRun(collectionId, userId, { usernames: ['girl'], limit: 100 });
    await waitMinerIdle();
    const run = getDb()
      .prepare(`SELECT status, error FROM mining_runs WHERE collection_id=?`)
      .get(collectionId) as { status: string; error: string };
    expect(run.status).toBe('failed');
    expect(run.error).toContain('FAILED');
    const after = creditBalance(userId);
    expect(after.balance).toBe(before.balance);
    expect(after.held).toBe(0);
    setMinerDepsForTests(null);
  });
});
