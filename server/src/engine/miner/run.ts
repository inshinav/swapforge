// Mining run (SPEC §3/§7): hold → Apify актор (персист run-id, рестарт-безопасно) →
// virality-фильтр → vision-PatternCards → settle факта. Провал = полный возврат.
// seed v1 = только аккаунты (profile-scrape несёт followersCount).
import { randomUUID } from 'node:crypto';
import { getDb } from '../../db';
import { config } from '../../config';
import { apify, type Apify } from '../../apify';
import { placeCarouselHold } from '../carousel/billing';
import { priceCredits, releaseHold, settleHold } from '../../billing/credits';
import { forecastTokens, priceForCached, taskModel } from '../../pricing';
import { normalizeProfileItems, viralityFilter } from './virality';
import { createPatternCard, downloadThumb } from './patterns';
import type { LlmClient } from '../../llm/provider';

export const IG_PROFILE_ACTOR = 'apify/instagram-profile-scraper';

export interface MinerDeps {
  apifyClient?: Apify;
  llm?: LlmClient;
  thumbFetch?: typeof fetch;
  pollMs?: number;
}

let testDeps: MinerDeps | null = null;
export function setMinerDepsForTests(deps: MinerDeps | null): void {
  testDeps = deps;
}

const running = new Set<string>();
export async function waitMinerIdle(): Promise<void> {
  while (running.size > 0) await new Promise((r) => setTimeout(r, 5));
}

export interface MiningSeed {
  usernames: string[];
  limit: number;
}

function patternUsd(): number | null {
  const f = forecastTokens('carousel_pattern');
  const price = priceForCached(taskModel('carousel_pattern'));
  if (!price) return null;
  return (f.tokensIn * price.inPerM + f.tokensOut * price.outPerM) / 1e6;
}

/** Себестоимость рана: акторная часть (env-константа за 100 постов) + vision по топ-N. */
export function minerQuoteUsd(limit: number, topN = 20): number | null {
  const actorUsd = (config.minerRunCostUsdPer100 * Math.max(1, limit)) / 100;
  const perPattern = patternUsd();
  if (perPattern === null) return null;
  return actorUsd + perPattern * topN;
}

function setRun(id: string, fields: Record<string, unknown>): void {
  const keys = Object.keys(fields);
  getDb()
    .prepare(`UPDATE mining_runs SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=datetime('now') WHERE id=?`)
    .run(...keys.map((k) => fields[k] as never), id);
}

/**
 * Старт: строка mining_runs + hold (reused→409 наследуется из placeCarouselHold; scope =
 * mining_run id — не карусель, конфликтов с генерациями нет). Возвращает id рана.
 */
export function startMiningRun(collectionId: string, userId: string, seed: MiningSeed): string {
  const runId = randomUUID();
  const quote = minerQuoteUsd(seed.limit);
  if (quote === null) throw new Error('Точная смета майнинга временно недоступна — попробуй чуть позже');
  const db = getDb();
  db.prepare(
    `INSERT INTO mining_runs (id, collection_id, user_id, seed_json, status) VALUES (?, ?, ?, ?, 'queued')`,
  ).run(runId, collectionId, userId, JSON.stringify(seed));
  const isOwner = (db.prepare(`SELECT role FROM users WHERE id=?`).get(userId) as { role: string } | undefined)?.role === 'owner';
  if (!isOwner) {
    const holdId = placeCarouselHold(userId, runId, priceCredits(quote));
    setRun(runId, { hold_id: holdId });
  }
  running.add(runId);
  void executeRun(runId).finally(() => running.delete(runId));
  return runId;
}

async function executeRun(runId: string): Promise<void> {
  const db = getDb();
  const row = db
    .prepare(`SELECT collection_id, user_id, seed_json, apify_run_id, hold_id FROM mining_runs WHERE id=?`)
    .get(runId) as
    | { collection_id: string; user_id: string; seed_json: string; apify_run_id: string | null; hold_id: string | null }
    | undefined;
  if (!row) return;
  const client = testDeps?.apifyClient ?? apify;
  const pollMs = testDeps?.pollMs ?? 5000;
  try {
    const seed = JSON.parse(row.seed_json) as MiningSeed;
    let apifyRunId = row.apify_run_id;
    if (!apifyRunId) {
      setRun(runId, { status: 'running' });
      const started = await client.startActorRun(IG_PROFILE_ACTOR, {
        usernames: seed.usernames,
        resultsLimit: Math.min(200, seed.limit),
      });
      apifyRunId = started.runId;
      setRun(runId, { apify_run_id: apifyRunId }); // персист ДО поллинга — рестарт-безопасно
    }
    // Поллинг до терминала (бюджет 15 мин).
    const deadline = Date.now() + 15 * 60_000;
    let datasetId: string | null = null;
    for (;;) {
      const st = await client.getRun(apifyRunId);
      if (st.status === 'SUCCEEDED') {
        datasetId = st.defaultDatasetId;
        break;
      }
      if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(st.status)) {
        throw new Error(`Apify-ран завершился статусом ${st.status}`);
      }
      if (Date.now() > deadline) throw new Error('Apify-ран не уложился в 15 минут');
      await new Promise((r) => setTimeout(r, pollMs));
    }
    if (!datasetId) throw new Error('Apify не отдал датасет');

    setRun(runId, { status: 'filtering' });
    const items = await client.datasetItems<unknown>(datasetId, { limit: Math.min(200, seed.limit) });
    const posts = normalizeProfileItems(items);
    const top = viralityFilter(posts);

    setRun(runId, { status: 'vision' });
    let cards = 0;
    for (const post of top) {
      try {
        const thumbFile = post.thumbUrl
          ? await downloadThumb(row.collection_id, post.thumbUrl, testDeps?.thumbFetch)
          : null;
        await createPatternCard(
          { collectionId: row.collection_id, userId: row.user_id, opId: `mine-${runId}`, post, thumbFile },
          testDeps?.llm,
        );
        cards++;
      } catch (e) {
        console.warn(`[miner] карточка не создалась (${post.url}): ${e instanceof Error ? e.message.slice(0, 120) : e}`);
      }
    }
    const stats = { fetched: posts.length, passedFilter: top.length, cards };
    if (cards === 0 && top.length > 0) throw new Error('Ни одна карточка не собралась — vision недоступен');

    // Settle факта: акторная константа + LLM по атрибуции op-id; кап = hold.
    const llmFact = (
      db.prepare(`SELECT COALESCE(SUM(cost_usd),0) AS s FROM usage_events WHERE generation_id=?`).get(`mine-${runId}`) as {
        s: number;
      }
    ).s;
    const actorUsd = (config.minerRunCostUsdPer100 * Math.max(1, JSON.parse(row.seed_json).limit ?? 100)) / 100;
    const factUsd = actorUsd + llmFact;
    setRun(runId, { status: 'done', stats_json: JSON.stringify(stats), cost_usd: factUsd });
    if (row.hold_id) settleHold(row.hold_id, priceCredits(factUsd), `mine-${runId}`, 'списание по факту майнинга');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setRun(runId, { status: 'failed', error: msg.slice(0, 500) });
    if (row.hold_id) releaseHold(row.hold_id, 0, 'майнинг не удался — резерв возвращён');
  }
}

/** Бут: раны с apify_run_id докатываются, без него — честный fail+release. */
export function resumeMiningRuns(): void {
  const rows = getDb()
    .prepare(`SELECT id, apify_run_id, hold_id FROM mining_runs WHERE status IN ('queued','running','filtering','vision')`)
    .all() as Array<{ id: string; apify_run_id: string | null; hold_id: string | null }>;
  for (const r of rows) {
    if (r.apify_run_id) {
      running.add(r.id);
      void executeRun(r.id).finally(() => running.delete(r.id));
    } else {
      setRun(r.id, { status: 'failed', error: 'Прерван рестартом до старта актора' });
      if (r.hold_id) releaseHold(r.hold_id, 0, 'майнинг прерван рестартом — резерв возвращён');
    }
  }
  if (rows.length) console.log(`[miner] resume: ${rows.length} ранов`);
}
