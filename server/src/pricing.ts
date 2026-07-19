// Живые тарифы — жёсткое правило: никаких зашитых цен в коде.
// WaveSpeed: формула из их каталога моделей (JSONata) + живой баланс.
// OpenAI: автообновляемый litellm-манифест (официального прайс-API у OpenAI нет).
// Везде лестница: live → память → last-known-good (pricing_cache в БД, с видимой датой) → null.
import jsonata from 'jsonata';
import { getDb } from './db';
import { config, modelChainFor } from './config';
import { wavespeed, type WaveSpeed, type WsModelEntry } from './wavespeed';
import { remainingStages, snapshotProject, type ProjectRowLike, type StageName } from './engine/orchestrator';
import { planVideoSegments, type VideoSegmentPlan } from './engine/segments';
import type { EstimateInfo, EstimateTaskRow, FrameInfo, VideoMeta } from '../../shared/api-types';
import type { Analysis } from '../../shared/analysis';

export type UsageTask = 'video_analysis' | 'prompt_pair' | 'start_frame' | 'classify_ref' | 'describe_ref';

const STAGE_TASK: Partial<Record<StageName, UsageTask>> = {
  analyze: 'video_analysis',
  generate: 'prompt_pair',
  startframe: 'start_frame',
};

/**
 * Сид-эмпирика токенов на задачу (из journald [llm-usage], 15.07.2026). Это НЕ тариф:
 * прогноз объёма, самокорректируется скользящим средним по usage_events.
 */
export const SEED_TOKENS: Record<UsageTask, { tin: number; tout: number }> = {
  video_analysis: { tin: 35_000, tout: 2_000 },
  prompt_pair: { tin: 11_000, tout: 1_400 },
  start_frame: { tin: 3_400, tout: 5_700 },
  classify_ref: { tin: 1_000, tout: 60 },
  // одна high-detail картинка листа + компактная RU-нота на выходе
  describe_ref: { tin: 2_500, tout: 250 },
};

function taskModel(task: UsageTask): string {
  if (task === 'start_frame') return config.openaiImageModel;
  if (task === 'video_analysis') return modelChainFor('analyze')[0]!;
  if (task === 'classify_ref') return modelChainFor('classify')[0]!;
  if (task === 'describe_ref') return modelChainFor('describe')[0]!;
  return modelChainFor('generate')[0]!;
}

export interface ModelPrice {
  inPerM: number;
  outPerM: number;
  date: string;
  source: 'override' | 'live' | 'cache';
}

interface LitellmEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  [k: string]: unknown;
}

const mem: {
  litellm: { data: Record<string, LitellmEntry>; fetchedAt: string; at: number } | null;
  ws: { entry: WsModelEntry; fetchedAt: string; at: number } | null;
  balance: { usd: number; at: number } | null;
} = { litellm: null, ws: null, balance: null };

/** Тестовый сброс кэшей в памяти. */
export function _resetPricingMemory(): void {
  mem.litellm = null;
  mem.ws = null;
  mem.balance = null;
}

const nowIso = (): string => new Date().toISOString();

function ourModels(): string[] {
  return [
    ...new Set([
      ...modelChainFor('analyze'),
      ...modelChainFor('generate'),
      ...modelChainFor('classify'),
      config.openaiImageModel,
    ]),
  ];
}

function cacheGet(source: string): { payload: unknown; fetchedAt: string } | null {
  const row = getDb()
    .prepare(`SELECT payload_json, fetched_at FROM pricing_cache WHERE source = ?`)
    .get(source) as { payload_json: string; fetched_at: string } | undefined;
  if (!row) return null;
  try {
    return { payload: JSON.parse(row.payload_json), fetchedAt: row.fetched_at };
  } catch {
    return null;
  }
}

function cachePut(source: string, payload: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO pricing_cache (source, payload_json, fetched_at) VALUES (?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET payload_json = excluded.payload_json, fetched_at = excluded.fetched_at`,
    )
    .run(source, JSON.stringify(payload), nowIso());
}

// ── OpenAI: litellm-манифест ────────────────────────────────────────────────

function loadLitellmFromDb(): void {
  if (mem.litellm) return;
  const c = cacheGet('litellm');
  // at: 0 → считается протухшим, при первом же ensureLitellmFresh попробуем обновить
  if (c) mem.litellm = { data: c.payload as Record<string, LitellmEntry>, fetchedAt: c.fetchedAt, at: 0 };
}

export async function ensureLitellmFresh(fetchImpl: typeof fetch = fetch): Promise<void> {
  loadLitellmFromDb();
  if (mem.litellm && Date.now() - mem.litellm.at < config.pricingLitellmTtlMs) return;
  try {
    const res = await fetchImpl(config.litellmPricesUrl, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const all = (await res.json()) as Record<string, LitellmEntry>;
    const filtered: Record<string, LitellmEntry> = {};
    for (const m of ourModels()) if (all[m]) filtered[m] = all[m];
    if (Object.keys(filtered).length === 0) throw new Error('в манифесте нет ни одной нашей модели');
    mem.litellm = { data: filtered, fetchedAt: nowIso(), at: Date.now() };
    cachePut('litellm', filtered);
  } catch (e) {
    console.warn(`[pricing] litellm-манифест недоступен: ${e instanceof Error ? e.message : e}`);
    // не дёргаем сеть на каждый вызов; дата fetchedAt остаётся старой → UI покажет stale
    if (mem.litellm) mem.litellm.at = Date.now();
  }
}

/** Синхронная цена модели из кэшей (для recordUsage): override → память → БД. */
export function priceForCached(model: string): ModelPrice | null {
  if (config.pricingOverrides) {
    try {
      const o = JSON.parse(config.pricingOverrides) as Record<
        string,
        { inPerM?: number; outPerM?: number }
      >;
      const e = o[model];
      if (e && typeof e.inPerM === 'number' && typeof e.outPerM === 'number') {
        return { inPerM: e.inPerM, outPerM: e.outPerM, date: 'override', source: 'override' };
      }
    } catch {
      /* кривой PRICING_OVERRIDES — игнорируем */
    }
  }
  loadLitellmFromDb();
  const entry = mem.litellm?.data[model];
  if (
    entry &&
    typeof entry.input_cost_per_token === 'number' &&
    typeof entry.output_cost_per_token === 'number'
  ) {
    return {
      inPerM: entry.input_cost_per_token * 1e6,
      outPerM: entry.output_cost_per_token * 1e6,
      date: mem.litellm!.fetchedAt,
      source: mem.litellm!.at > 0 ? 'live' : 'cache',
    };
  }
  return null;
}

// ── WaveSpeed: формула тарифа + баланс ──────────────────────────────────────

async function getWsTariff(ws: WaveSpeed = wavespeed): Promise<{ entry: WsModelEntry; fetchedAt: string } | null> {
  if (mem.ws && Date.now() - mem.ws.at < config.pricingWsTtlMs) {
    return { entry: mem.ws.entry, fetchedAt: mem.ws.fetchedAt };
  }
  try {
    const entry = await ws.fetchModelEntry(config.seedanceEndpoint);
    const slim: WsModelEntry = {
      model_id: entry.model_id,
      base_price: entry.base_price,
      formula: entry.formula,
    };
    mem.ws = { entry: slim, fetchedAt: nowIso(), at: Date.now() };
    cachePut('wavespeed_model', slim);
    return { entry: slim, fetchedAt: mem.ws.fetchedAt };
  } catch (e) {
    console.warn(`[pricing] каталог WaveSpeed недоступен: ${e instanceof Error ? e.message : e}`);
    if (mem.ws) {
      mem.ws.at = Date.now();
      return { entry: mem.ws.entry, fetchedAt: mem.ws.fetchedAt };
    }
    const c = cacheGet('wavespeed_model');
    if (c) {
      mem.ws = { entry: c.payload as WsModelEntry, fetchedAt: c.fetchedAt, at: Date.now() };
      return { entry: mem.ws.entry, fetchedAt: c.fetchedAt };
    }
    return null;
  }
}

/**
 * Считает цену рендера ЖИВОЙ формулой WaveSpeed (JSONata, µ$ → $).
 * get_duration_v3 — их серверная функция длительности видео; биндим наш ffprobe.
 */
export async function evalSeedanceFormula(
  formula: string,
  durationSec: number,
  resolution: string,
  explicitDuration?: number,
): Promise<number> {
  const expr = jsonata(formula);
  // Формула зовёт get_duration_v3(video) без $-префикса — это значение из контекста данных,
  // а не зарегистрированная функция; биндим её прямо в evaluation context.
  const ctx: Record<string, unknown> = {
    resolution,
    video: 'video.mp4',
    get_duration_v3: () => durationSec,
  };
  if (explicitDuration !== undefined) ctx.duration = explicitDuration;
  const out: unknown = await expr.evaluate(ctx);
  const micro =
    typeof out === 'number' ? out : (out as { total_price?: unknown } | null)?.total_price;
  if (typeof micro !== 'number' || !Number.isFinite(micro)) {
    throw new Error('формула вернула не число');
  }
  const usd = micro / 1e6;
  if (usd <= 0 || usd >= 100) throw new Error(`цена $${usd.toFixed(2)} вне санити-границ`);
  return usd;
}

/** Биллинг-секунды по правилам Seedance: вход clamp 2..15 + выход (auto = входу, clamp 4..15). */
export function billedSecondsOf(durationSec: number): { input: number; output: number } {
  return {
    input: Math.max(2, Math.ceil(Math.min(durationSec, 15))),
    output: Math.max(4, Math.min(15, Math.ceil(durationSec))),
  };
}

export interface WsEstimatePart {
  usd: number | null;
  billedSeconds: number;
  perSecondUsd: number | null;
  priceDate: string | null;
  unavailableReason: string | null;
}

export async function estimateRender(durationSec: number, ws: WaveSpeed = wavespeed): Promise<WsEstimatePart> {
  const t = await getWsTariff(ws);
  const b = billedSecondsOf(durationSec);
  const billed = b.input + b.output;
  if (!t?.entry.formula) {
    return {
      usd: null,
      billedSeconds: billed,
      perSecondUsd: null,
      priceDate: t?.fetchedAt ?? null,
      unavailableReason: 'живой тариф WaveSpeed недоступен',
    };
  }
  try {
    const usd = await evalSeedanceFormula(t.entry.formula, durationSec, config.seedanceResolution);
    return {
      usd,
      billedSeconds: billed,
      perSecondUsd: usd / billed,
      priceDate: t.fetchedAt,
      unavailableReason: null,
    };
  } catch (e) {
    return {
      usd: null,
      billedSeconds: billed,
      perSecondUsd: null,
      priceDate: t.fetchedAt,
      unavailableReason: `сбой формулы тарифа: ${e instanceof Error ? e.message : e}`,
    };
  }
}

/** Полная цена исходника любой длины: сумма реальных Seedance-задач по кускам <=15с. */
export async function estimateVideoRender(
  durationSec: number,
  ws: WaveSpeed = wavespeed,
  plan: VideoSegmentPlan[] = planVideoSegments(durationSec),
): Promise<WsEstimatePart> {
  const durations = plan.map((segment) => Math.round((segment.endSec - segment.startSec) * 100) / 100);
  const parts: WsEstimatePart[] = [];
  // Первый вызов прогревает live/LKG тариф; последовательность не создаёт N одинаковых
  // запросов в каталог при холодном старте длинного ролика.
  for (const duration of durations) parts.push(await estimateRender(duration, ws));
  const unavailable = parts.find((p) => p.usd === null || p.unavailableReason);
  const billedSeconds = parts.reduce((sum, p) => sum + p.billedSeconds, 0);
  const usd = unavailable ? null : parts.reduce((sum, p) => sum + (p.usd ?? 0), 0);
  return {
    usd,
    billedSeconds,
    perSecondUsd: usd === null || billedSeconds === 0 ? null : usd / billedSeconds,
    priceDate: parts.map((p) => p.priceDate).find(Boolean) ?? null,
    unavailableReason: unavailable?.unavailableReason ?? null,
  };
}

export async function getBalanceCached(ws: WaveSpeed = wavespeed, force = false): Promise<number | null> {
  if (!force && mem.balance && Date.now() - mem.balance.at < 60_000) return mem.balance.usd;
  try {
    const usd = await ws.getBalance();
    mem.balance = { usd, at: Date.now() };
    return usd;
  } catch (e) {
    console.warn(`[pricing] баланс WaveSpeed недоступен: ${e instanceof Error ? e.message : e}`);
    return mem.balance?.usd ?? null;
  }
}

export function pricingDates(): { litellm: string | null; wavespeed: string | null } {
  loadLitellmFromDb();
  const wsDate = mem.ws?.fetchedAt ?? cacheGet('wavespeed_model')?.fetchedAt ?? null;
  return { litellm: mem.litellm?.fetchedAt ?? null, wavespeed: wsDate };
}

// ── Оценщик ─────────────────────────────────────────────────────────────────

/** Прогноз токенов: скользящее среднее последних 10 реальных прогонов, сид — эмпирика. */
export function forecastTokens(task: UsageTask): {
  tokensIn: number;
  tokensOut: number;
  basis: 'history' | 'seed';
} {
  const rows = getDb()
    .prepare(
      `SELECT tokens_in, tokens_out FROM usage_events WHERE task = ? ORDER BY created_at DESC, rowid DESC LIMIT 10`,
    )
    .all(task) as Array<{ tokens_in: number; tokens_out: number }>;
  if (rows.length >= 3) {
    return {
      tokensIn: Math.round(rows.reduce((s, r) => s + r.tokens_in, 0) / rows.length),
      tokensOut: Math.round(rows.reduce((s, r) => s + r.tokens_out, 0) / rows.length),
      basis: 'history',
    };
  }
  const seed = SEED_TOKENS[task];
  return { tokensIn: seed.tin, tokensOut: seed.tout, basis: 'seed' };
}

export interface EstimateProjectRow extends ProjectRowLike {
  meta_json: string | null;
  video_purged: number;
}

/** Смета до запуска: только НЕДОСТАЮЩИЕ стадии (повторный прогон = почти чистый WaveSpeed). */
export async function buildEstimate(project: EstimateProjectRow, ws: WaveSpeed = wavespeed): Promise<EstimateInfo> {
  await ensureLitellmFresh();
  const snap = snapshotProject(project);
  const stages = remainingStages(snap);
  const warnings: string[] = [];

  const perTask: EstimateTaskRow[] = [];
  for (const s of stages) {
    const task = STAGE_TASK[s];
    if (!task) continue;
    const f = forecastTokens(task);
    const model = taskModel(task);
    const price = priceForCached(model);
    const usd = price ? (f.tokensIn * price.inPerM + f.tokensOut * price.outPerM) / 1e6 : null;
    if (!price) warnings.push(`нет тарифа для ${model} — цену этой задачи покажу после прогона`);
    perTask.push({ task, model, tokensIn: f.tokensIn, tokensOut: f.tokensOut, usd, basis: f.basis });
  }
  const meta = project.meta_json ? (JSON.parse(project.meta_json) as VideoMeta) : null;
  const analysis = project.analysis_json ? (JSON.parse(project.analysis_json) as Analysis) : null;
  const frames = project.frames_json ? (JSON.parse(project.frames_json) as FrameInfo[]) : [];
  // Это тот же план, который использует рендер. Продолжения получают точный кадр
  // предыдущей готовой части, поэтому повторная платная перерисовка GPT Image не нужна.
  const segmentPlan = meta ? planVideoSegments(meta.durationSec, analysis, frames) : [];
  const known = perTask.filter((r) => r.usd !== null);
  const openaiUsd =
    perTask.length === 0 ? 0 : known.length > 0 ? known.reduce((s, r) => s + (r.usd ?? 0), 0) : null;

  let wsPart: WsEstimatePart;
  if (!meta) {
    wsPart = {
      usd: null,
      billedSeconds: 0,
      perSecondUsd: null,
      priceDate: null,
      unavailableReason: 'нет метаданных видео',
    };
  } else {
    wsPart = await estimateVideoRender(meta.durationSec, ws, segmentPlan);
    const count = segmentPlan.length;
    if (count > 1) warnings.push(`длинный исходник будет бесшовно собран из ${count} частей`);
  }
  if (wsPart.unavailableReason) warnings.push(`оценка WaveSpeed недоступна: ${wsPart.unavailableReason}`);
  if (project.video_purged === 1) {
    warnings.push('исходник очищен ротацией — рендер невозможен, залей ролик заново');
  }

  const balanceUsd = await getBalanceCached(ws);
  if (balanceUsd === null) warnings.push('баланс WaveSpeed недоступен');
  else if (wsPart.usd !== null && wsPart.usd > balanceUsd - 0.05) {
    warnings.push(
      `не хватает баланса WaveSpeed: нужно ≈$${wsPart.usd.toFixed(2)}, на счету $${balanceUsd.toFixed(2)} — пополни`,
    );
  }

  const dates = pricingDates();
  if (dates.litellm && Date.now() - Date.parse(dates.litellm) > 7 * 24 * 3_600_000) {
    warnings.push(`тарифы OpenAI от ${dates.litellm.slice(0, 10)} (обновить не удалось)`);
  }

  const totalUsd = wsPart.usd === null ? null : wsPart.usd + (openaiUsd ?? 0);
  return {
    stages,
    openai: { perTask, usd: openaiUsd, priceDate: dates.litellm },
    wavespeed: { ...wsPart, resolution: config.seedanceResolution },
    totalUsd,
    approximate: openaiUsd === null || perTask.some((r) => r.usd === null),
    balanceUsd,
    warnings,
  };
}

/** Прогрев кэшей на старте сервиса (fire-and-forget). */
export async function warmPricing(): Promise<void> {
  await ensureLitellmFresh();
  await getWsTariff().catch(() => null);
  await getBalanceCached().catch(() => null);
}
