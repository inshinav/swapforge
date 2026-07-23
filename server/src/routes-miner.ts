// Reference Miner API (SPEC §3/§9): подборки, майнинг-раны (дневной лимит + hold),
// лента PatternCards, thumb-кэш. Auth+CSRF — глобальным default-deny; за фича-флагом.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getDb } from './db';
import { config } from './config';
import { consumeDailyLimit } from './limits';
import { minerQuoteUsd, startMiningRun } from './engine/miner/run';
import { HoldConflictError, InsufficientCreditsError } from './engine/carousel/billing';
import { priceCredits } from './billing/credits';
import { safeMinerThumbPath } from './storage';
import type { CollectionInfo, MiningRunInfo, PatternCardInfo } from '../../shared/carousel';

function bad(reply: FastifyReply, code: number, msg: string) {
  return reply.code(code).send({ error: msg });
}

function hiddenFrom(req: FastifyRequest, reply: FastifyReply): boolean {
  if (config.carouselOwnerOnly && req.user!.role !== 'owner') {
    void bad(reply, 404, 'Не найдено');
    return true;
  }
  return false;
}

const USERNAME_RE = /^[a-z0-9._]{1,30}$/;

interface CollectionRow {
  id: string;
  user_id: string;
  name: string;
  seed_json: string;
  status: string;
  created_at: string;
}

function getOwnedCollection(userId: string, id: string): CollectionRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM collections WHERE id=? AND user_id=?`)
    .get(id, userId) as CollectionRow | undefined;
}

function toCollectionInfo(row: CollectionRow): CollectionInfo {
  const count = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM pattern_cards WHERE collection_id=? AND archived=0`)
    .get(row.id) as { c: number };
  return { id: row.id, name: row.name, status: row.status, cardCount: count.c, createdAt: row.created_at };
}

export function registerMinerRoutes(app: FastifyInstance): void {
  app.get('/api/miner/collections', async (req, reply) => {
    if (hiddenFrom(req, reply)) return;
    const rows = getDb()
      .prepare(`SELECT * FROM collections WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 50`)
      .all(req.user!.id) as unknown as CollectionRow[];
    return { collections: rows.map(toCollectionInfo) };
  });

  app.post('/api/miner/collections', async (req, reply) => {
    if (hiddenFrom(req, reply)) return;
    const body = (req.body ?? {}) as { name?: string; usernames?: string[]; limit?: number };
    const name = (body.name ?? '').trim();
    if (!name) return bad(reply, 422, 'Дай подборке имя');
    const usernames = (body.usernames ?? []).map((u) => u.trim().toLowerCase().replace(/^@/, ''));
    if (usernames.length < 1 || usernames.length > 10) {
      return bad(reply, 422, 'Укажи от 1 до 10 аккаунтов-источников');
    }
    for (const u of usernames) {
      if (!USERNAME_RE.test(u)) return bad(reply, 422, `Неверный username: ${u}`);
    }
    const limit = Math.max(10, Math.min(200, Math.round(body.limit ?? 100)));
    const id = randomUUID();
    getDb()
      .prepare(`INSERT INTO collections (id, user_id, name, seed_json) VALUES (?, ?, ?, ?)`)
      .run(id, req.user!.id, name.slice(0, 120), JSON.stringify({ usernames, limit }));
    return { collection: toCollectionInfo(getOwnedCollection(req.user!.id, id)!) };
  });

  app.delete('/api/miner/collections/:id', async (req, reply) => {
    if (hiddenFrom(req, reply)) return;
    const { id } = req.params as { id: string };
    const row = getOwnedCollection(req.user!.id, id);
    if (!row) return bad(reply, 404, 'Подборка не найдена');
    const active = getDb()
      .prepare(
        `SELECT COUNT(*) AS c FROM mining_runs WHERE collection_id=? AND status IN ('queued','running','filtering','vision')`,
      )
      .get(id) as { c: number };
    if (active.c > 0) return bad(reply, 409, 'Дождись окончания майнинга');
    getDb().prepare(`DELETE FROM collections WHERE id=?`).run(id);
    fs.rmSync(path.join(config.dataDir, 'miner', id), { recursive: true, force: true });
    return { ok: true };
  });

  app.get('/api/miner/quote', async (req, reply) => {
    if (hiddenFrom(req, reply)) return;
    const q = (req.query ?? {}) as { limit?: string };
    const limit = Math.max(10, Math.min(200, Number(q.limit) || 100));
    const usd = minerQuoteUsd(limit);
    return { priceUsd: usd === null ? null : priceCredits(usd) / 100 };
  });

  app.post('/api/miner/collections/:id/mine', async (req, reply) => {
    if (hiddenFrom(req, reply)) return;
    const { id } = req.params as { id: string };
    const row = getOwnedCollection(req.user!.id, id);
    if (!row) return bad(reply, 404, 'Подборка не найдена');
    const active = getDb()
      .prepare(
        `SELECT COUNT(*) AS c FROM mining_runs WHERE collection_id=? AND status IN ('queued','running','filtering','vision')`,
      )
      .get(id) as { c: number };
    if (active.c > 0) return bad(reply, 409, 'Майнинг этой подборки уже идёт');
    if (req.user!.role !== 'owner') {
      const gate = consumeDailyLimit(req.user!.id, 'miner', config.limitMinerPerDay);
      if (!gate.allowed) {
        return bad(reply, 429, `Дневной лимит майнинга исчерпан (${config.limitMinerPerDay}) — возвращайся завтра`);
      }
    }
    const seed = JSON.parse(row.seed_json) as { usernames: string[]; limit: number };
    try {
      const runId = startMiningRun(id, req.user!.id, seed);
      return { runId };
    } catch (e) {
      if (e instanceof HoldConflictError) return bad(reply, 409, e.message);
      if (e instanceof InsufficientCreditsError) {
        return reply.code(402).send({
          error: e.message,
          shortfallUsd: Math.ceil(e.needCredits - e.availableCredits) / 100,
        });
      }
      throw e;
    }
  });

  app.get('/api/miner/collections/:id', async (req, reply) => {
    if (hiddenFrom(req, reply)) return;
    const { id } = req.params as { id: string };
    const row = getOwnedCollection(req.user!.id, id);
    if (!row) return bad(reply, 404, 'Подборка не найдена');
    const runs = getDb()
      .prepare(`SELECT * FROM mining_runs WHERE collection_id=? ORDER BY created_at DESC, rowid DESC LIMIT 5`)
      .all(id) as Array<{
      id: string;
      collection_id: string;
      status: string;
      stats_json: string | null;
      error: string | null;
      created_at: string;
    }>;
    const cards = getDb()
      .prepare(`SELECT * FROM pattern_cards WHERE collection_id=? AND archived=0 ORDER BY created_at DESC, rowid DESC LIMIT 100`)
      .all(id) as Array<{
      id: string;
      source_url: string;
      author: string;
      virality_json: string;
      structure_json: string;
      thumb_file: string | null;
      liked: number;
      archived: number;
    }>;
    const runInfos: MiningRunInfo[] = runs.map((r) => ({
      id: r.id,
      collectionId: r.collection_id,
      status: r.status as MiningRunInfo['status'],
      stats: r.stats_json ? (JSON.parse(r.stats_json) as MiningRunInfo['stats']) : null,
      error: r.error,
      createdAt: r.created_at,
    }));
    const cardInfos: PatternCardInfo[] = cards.map((c) => ({
      id: c.id,
      sourceUrl: c.source_url,
      platform: 'instagram',
      author: c.author,
      virality: JSON.parse(c.virality_json) as PatternCardInfo['virality'],
      structure: JSON.parse(c.structure_json) as PatternCardInfo['structure'],
      thumbFile: c.thumb_file,
      liked: c.liked === 1,
      archived: c.archived === 1,
    }));
    return { collection: toCollectionInfo(row), runs: runInfos, cards: cardInfos };
  });

  app.patch('/api/miner/cards/:cardId', async (req, reply) => {
    if (hiddenFrom(req, reply)) return;
    const { cardId } = req.params as { cardId: string };
    const owned = getDb()
      .prepare(
        `SELECT pc.id FROM pattern_cards pc JOIN collections c ON c.id=pc.collection_id
          WHERE pc.id=? AND c.user_id=?`,
      )
      .get(cardId, req.user!.id);
    if (!owned) return bad(reply, 404, 'Карточка не найдена');
    const body = (req.body ?? {}) as { liked?: boolean; archived?: boolean };
    if (typeof body.liked === 'boolean') {
      getDb().prepare(`UPDATE pattern_cards SET liked=? WHERE id=?`).run(body.liked ? 1 : 0, cardId);
    }
    if (typeof body.archived === 'boolean') {
      getDb().prepare(`UPDATE pattern_cards SET archived=? WHERE id=?`).run(body.archived ? 1 : 0, cardId);
    }
    return { ok: true };
  });

  app.get('/api/miner/collections/:id/thumb/:file', async (req, reply) => {
    if (hiddenFrom(req, reply)) return;
    const { id, file } = req.params as { id: string; file: string };
    if (!getOwnedCollection(req.user!.id, id)) return bad(reply, 404, 'Не найдено');
    const full = safeMinerThumbPath(id, file);
    if (!full) return bad(reply, 404, 'Файл не найден');
    reply.header('Cache-Control', 'private, max-age=86400');
    reply.type('image/jpeg');
    return reply.send(fs.createReadStream(full));
  });
}
