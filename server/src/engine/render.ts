// Жизненный цикл рендера WaveSpeed: загрузка ассетов → сабмит → поллинг → скачивание → done.
// Всё вне серийной CPU-очереди (это удалённые ожидания). Статус живёт в generations.status.
// Рестарт-безопасно: submitted/rendering/downloading возобновляются по ws_prediction_id.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import { config } from '../config';
import { wavespeed, type WaveSpeed, type WsPrediction } from '../wavespeed';
import { buildEstimate, estimateRender, estimateVideoRender } from '../pricing';
import { enforceStorageCap, projectDir, refsDir, rendersDir, startDir } from '../storage';
import {
  cutVideoSegment,
  extractFrameAt,
  stitchVideoSegments,
  validateRenderedVideo,
  type ContinuityValidationPoint,
  type FinalMediaValidation,
} from '../ffmpeg';
import { parseFlags, type FlowFlags } from './orchestrator';
import { planVideoSegments, SEAM_OVERLAP_SECONDS, type VideoSegmentPlan } from './segments';
import { attachHoldGeneration, openHoldForProject, placeHold, priceCredits } from '../billing/credits';
import { requireActiveAttempt } from '../billing/attempts';
import {
  forceReleaseProjectHold,
  isMeteredUserId,
  releaseFlowHoldOnFailure,
  settleProjectHold,
} from '../billing/flow';
import type { FrameInfo, RefInfo, VideoMeta } from '../../../shared/api-types';
import type { Analysis } from '../../../shared/analysis';

/** Ошибка с HTTP-статусом для роутов (409 = гейт, 404 = нет объекта). */
export class RenderGateError extends Error {
  httpStatus: number;
  constructor(httpStatus: number, message: string) {
    super(message);
    this.name = 'RenderGateError';
    this.httpStatus = httpStatus;
  }
}

class MediaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaValidationError';
  }
}

type RenderValidator = typeof validateRenderedVideo;
const testValidator: RenderValidator = async (_file, options) => ({
  ok: true,
  durationSec: options.expectedDurationSec,
  width: 720,
  height: 1280,
  hasAudio: options.expectAudio,
  decoded: true,
  continuity: [],
  warnings: [],
});
let renderValidator: RenderValidator = process.env.NODE_ENV === 'test' ? testValidator : validateRenderedVideo;

/** Test-only fault injection for the done/settle boundary. */
export function _setRenderValidator(validator: RenderValidator | null): void {
  renderValidator = validator ?? (process.env.NODE_ENV === 'test' ? testValidator : validateRenderedVideo);
}

export const ACTIVE_GEN_STATUSES = ['uploading_assets', 'submitted', 'rendering', 'downloading'];

interface GenRow {
  id: string;
  project_id: string;
  version: number;
  status: string;
  ws_prediction_id: string | null;
  ws_assets_json: string | null;
  params_json: string;
  file: string | null;
  bytes: number;
  error: string | null;
  cost_est_json: string | null;
  balance_before_usd: number | null;
  retry_of: string | null;
  submitted_at: string | null;
  segments_json: string | null;
  segment_count: number;
  segment_done: number;
}

interface AssetRef {
  url: string;
  at: string; // ISO загрузки
}
interface Assets {
  video?: AssetRef;
  start?: AssetRef;
  refs?: Record<string, AssetRef>; // refId → url
}

type LongSegmentStatus = 'planned' | 'prepared' | 'submitted' | 'done' | 'failed';
interface LongSegmentState extends VideoSegmentPlan {
  status: LongSegmentStatus;
  sourceFile?: string;
  anchorFile?: string;
  startFile?: string;
  videoUrl?: string;
  startUrl?: string;
  predictionId?: string;
  submittedAt?: string;
  outputFile?: string;
  costUsd?: number | null;
  costSource?: string | null;
  nsfw?: string;
}

interface LongRenderState {
  version: 1;
  overlapSec: number;
  segments: LongSegmentState[];
}

const ASSET_FRESH_MS = 6 * 24 * 3_600_000; // WaveSpeed хранит 7 дней; берём с запасом

function db() {
  return getDb();
}

function loadGen(genId: string): GenRow | undefined {
  return db().prepare(`SELECT * FROM generations WHERE id = ?`).get(genId) as GenRow | undefined;
}

/** Последний активный рендер (диагностика/обратная совместимость тестов). */
export function activeGeneration(): { id: string; project_id: string } | null {
  const row = db()
    .prepare(
      `SELECT id, project_id FROM generations
        WHERE status IN ('uploading_assets','submitted','rendering','downloading')
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get() as { id: string; project_id: string } | undefined;
  return row ?? null;
}

export function activeGenerationCount(): number {
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS c FROM generations
        WHERE status IN ('uploading_assets','submitted','rendering','downloading')`,
    )
    .get() as { c: number };
  return row.c;
}

export function projectHasActiveGeneration(projectId: string): boolean {
  const row = db()
    .prepare(
      `SELECT 1 FROM generations WHERE project_id = ?
        AND status IN ('uploading_assets','submitted','rendering','downloading') LIMIT 1`,
    )
    .get(projectId);
  return !!row;
}

function freshAssets(json: string | null): Assets {
  if (!json) return {};
  try {
    const raw = JSON.parse(json) as Assets;
    const ok = (a?: AssetRef) =>
      a && Date.now() - Date.parse(a.at) < ASSET_FRESH_MS ? a : undefined;
    const refs: Record<string, AssetRef> = {};
    for (const [k, v] of Object.entries(raw.refs ?? {})) {
      const f = ok(v);
      if (f) refs[k] = f;
    }
    return { video: ok(raw.video), start: ok(raw.start), refs };
  } catch {
    return {};
  }
}

function saveAssets(genId: string, assets: Assets): void {
  db()
    .prepare(`UPDATE generations SET ws_assets_json = ? WHERE id = ?`)
    .run(JSON.stringify(assets), genId);
}

function parseLongState(json: string | null): LongRenderState | null {
  if (!json) return null;
  try {
    const state = JSON.parse(json) as LongRenderState;
    return state?.version === 1 && Array.isArray(state.segments) && state.segments.length > 1
      ? state
      : null;
  } catch {
    return null;
  }
}

function saveLongState(genId: string, state: LongRenderState): void {
  const done = state.segments.filter((s) => s.status === 'done').length;
  db()
    .prepare(`UPDATE generations SET segments_json = ?, segment_count = ?, segment_done = ? WHERE id = ?`)
    .run(JSON.stringify(state), state.segments.length, done, genId);
}

function markFailed(genId: string, msg: string, opts: { wsTerminal?: boolean; releaseHold?: boolean } = {}): void {
  stopPoller(genId);
  db()
    .prepare(
      `UPDATE generations SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ? AND status != 'done'`,
    )
    .run(msg.slice(0, 500), genId);
  // Кредиты. Резерв возвращаем сразу в двух случаях:
  // - задача НЕ была сабмитнута (нет prediction_id — WaveSpeed не бильнёт);
  // - WaveSpeed сам сказал failed (wsTerminal) — задача мертва, добирать нечего.
  // Иначе (таймаут/сеть при живом prediction_id) hold держим: recheck может добрать
  // готовый ролик, и списание обязано состояться (гвард внутри release-функции).
  const gen = loadGen(genId);
  if (!gen) return;
  if (opts.releaseHold) {
    forceReleaseProjectHold(gen.project_id, genId, 'технически невалидный результат');
  } else if (!gen.ws_prediction_id) {
    releaseFlowHoldOnFailure(gen.project_id, genId, 'рендер не стартовал у WaveSpeed');
  } else if (opts.wsTerminal) {
    // WS сам сказал failed — задача мертва, recoverable-гвард не применим: форс-релиз
    // (prediction_id сохраняем: retry делает защитный пре-полл, диагностика цела)
    forceReleaseProjectHold(gen.project_id, genId, 'WaveSpeed отклонил задачу');
  }
  promoteNext(); // слот освободился — очередь едет дальше
}

/** Человеческая формулировка причин WaveSpeed. */
function ruWsFailure(raw: string): string {
  const s = (raw || '').slice(0, 300);
  if (/nsfw|content policy|moderation/i.test(s)) return `WaveSpeed отклонил контент модерацией: ${s}`;
  if (/balance|insufficient|credit/i.test(s)) return `Не хватило баланса WaveSpeed: ${s}`;
  return s ? `WaveSpeed: ${s}` : 'WaveSpeed сообщил об ошибке без деталей';
}

type NormalizedWsState = 'completed' | 'failed' | 'cancelled' | 'timeout' | 'pending';

function wsState(status: string): NormalizedWsState {
  const value = status.trim().toLowerCase();
  if (value === 'completed' || value === 'succeeded' || value === 'success') return 'completed';
  if (value === 'failed' || value === 'error') return 'failed';
  if (value === 'cancelled' || value === 'canceled') return 'cancelled';
  if (value === 'timeout' || value === 'timed_out' || value === 'expired') return 'timeout';
  return 'pending';
}

function terminalWsMessage(result: WsPrediction): string | null {
  const state = wsState(result.status);
  if (state === 'failed') return ruWsFailure(result.error);
  if (state === 'cancelled') return 'WaveSpeed отменил задачу';
  if (state === 'timeout') return 'WaveSpeed завершил задачу по таймауту';
  return null;
}

/** Последний старт-кадр нужной версии (файл с самым свежим таймстампом в имени). */
export function latestStartFrame(projectId: string, version: number): string | null {
  try {
    const files = fs
      .readdirSync(startDir(projectId))
      .filter((f) => new RegExp(`^start_v${version}_[A-Za-z0-9-]+\\.png$`).test(f))
      .sort((a, b) => b.localeCompare(a));
    return files[0] ?? null;
  } catch {
    return null;
  }
}

export interface StartRenderOpts {
  ws?: WaveSpeed;
  retryOf?: string;
  /** Явные флаги (для ручного рендера старой версии); по умолчанию — флаги проекта. */
  pollBaseMs?: number;
  /** Только для интеграционных тестов длинного конвейера. */
  _longHooks?: LongRenderHooks;
}

export interface LongRenderHooks {
  cut?: typeof cutVideoSegment;
  extract?: typeof extractFrameAt;
  stitch?: typeof stitchVideoSegments;
}

/**
 * Создаёт генерацию. Свободный глобальный слот → detached-цепочка сразу
 * (upload → submit → poll → download); занятый → status='queued', FIFO-продвижение
 * promoteNext() по освобождению слота. Число параллельных удалённых рендеров
 * задаётся RENDER_CONCURRENCY (по умолчанию 3).
 * Бросает RenderGateError при нарушении гейтов — строка генерации при этом НЕ создаётся.
 */
export function startRender(projectId: string, version: number, opts: StartRenderOpts = {}): string {
  const ws = opts.ws ?? wavespeed;
  const d = db();

  // Один проект — одна задача: активная ИЛИ очередная
  const projectPending = d
    .prepare(
      `SELECT 1 FROM generations WHERE project_id = ?
        AND status IN ('queued','uploading_assets','submitted','rendering','downloading') LIMIT 1`,
    )
    .get(projectId);
  if (projectPending) {
    throw new RenderGateError(409, 'Рендер этого проекта уже идёт или стоит в очереди — дождись');
  }
  const p = d.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId) as
    | {
        id: string;
        user_id: string | null;
        video_file: string | null;
        video_purged: number;
        meta_json: string | null;
        flags_json: string | null;
        analysis_json: string | null;
        frames_json: string | null;
      }
    | undefined;
  if (!p) throw new RenderGateError(404, 'Проект не найден');
  if (!p.video_file || p.video_purged === 1) {
    throw new RenderGateError(409, 'Исходник очищен ротацией — залей ролик заново');
  }
  if (!p.meta_json) throw new RenderGateError(409, 'Нет метаданных видео');
  const promptRow = d
    .prepare(
      `SELECT text FROM prompts WHERE project_id = ? AND version = ? AND kind = 'video' LIMIT 1`,
    )
    .get(projectId, version) as { text: string } | undefined;
  if (!promptRow) throw new RenderGateError(409, 'Нет промтов этой версии — сгенерируй промты');
  if (!latestStartFrame(projectId, version)) {
    throw new RenderGateError(409, 'Нет стартового кадра этой версии — сгенерируй кадр');
  }
  if (!config.wavespeedApiKey) {
    throw new RenderGateError(503, 'WAVESPEED_API_KEY не настроен на сервере');
  }
  requireActiveAttempt({ projectId });

  // Кап очереди не-владельца: не даём одному юзеру забить FIFO
  if (p.user_id && isMeteredUserId(p.user_id)) {
    const queued = d
      .prepare(`SELECT COUNT(*) AS c FROM generations WHERE user_id = ? AND status = 'queued'`)
      .get(p.user_id) as { c: number };
    if (queued.c >= config.userQueueCap) {
      throw new RenderGateError(
        409,
        `В очереди уже ${queued.c} твоих рендера — дождись их завершения или отмени лишний`,
      );
    }
  }

  const flags = parseFlags(p.flags_json);
  const generateAudio = parseGenerateAudio(p.flags_json);
  const genId = randomUUID();
  const params = {
    endpoint: config.seedanceEndpoint,
    resolution: config.seedanceResolution,
    aspect_ratio: '9:16',
    duration: null as number | null, // авто из входа (кламп 4–15)
    generate_audio: generateAudio,
    enable_web_search: false,
    flags,
  };
  // Проверка слота и INSERT — синхронный блок без await: event-loop-атомарно,
  // двух uploading_assets не родится. 'queued' НЕ входит в ACTIVE_GEN_STATUSES.
  const slotBusy = activeGenerationCount() >= config.renderConcurrency;
  d.prepare(
    `INSERT INTO generations (id, project_id, version, status, params_json, retry_of, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    genId,
    projectId,
    version,
    slotBusy ? 'queued' : 'uploading_assets',
    JSON.stringify(params),
    opts.retryOf ?? null,
    p.user_id,
  );

  // Retry длинного ролика переиспользует уже оплаченные/скачанные части. Только
  // терминально упавший текущий кусок сбрасывается для нового сабмита.
  if (opts.retryOf) {
    const priorLong = parseLongState(loadGen(opts.retryOf)?.segments_json ?? null);
    if (priorLong) {
      for (const segment of priorLong.segments) {
        if (segment.status === 'failed' || (segment.status === 'submitted' && !segment.outputFile)) {
          const hasContinuityFrame = segment.index === 0 ? !!segment.startFile : !!segment.anchorFile;
          segment.status = segment.sourceFile && hasContinuityFrame ? 'prepared' : 'planned';
          delete segment.predictionId;
          delete segment.submittedAt;
          delete segment.videoUrl;
          delete segment.startUrl;
        }
      }
      const priorWork = longWorkDir(projectId, opts.retryOf);
      const nextWork = longWorkDir(projectId, genId);
      if (fs.existsSync(priorWork)) {
        fs.mkdirSync(path.dirname(nextWork), { recursive: true });
        fs.cpSync(priorWork, nextWork, { recursive: true });
      }
      saveLongState(genId, priorLong);
    }
  }

  // Привязываем открытый резерв проекта к ЭТОЙ генерации сразу при создании: с этого
  // момента только её жизненный цикл может закрыть hold. Retry создаёт новый gen и
  // переклеивает hold на него → событие старого gen не тронет чужой резерв (F2).
  if (p.user_id && isMeteredUserId(p.user_id)) {
    const hold = openHoldForProject(projectId);
    if (hold) attachHoldGeneration(hold.id, genId);
  }

  // Смета на момент запуска — снапшотом в строку (фиксирует ожидание против факта)
  void (async () => {
    try {
      const meta = JSON.parse(p.meta_json!) as VideoMeta;
      const analysis = p.analysis_json ? (JSON.parse(p.analysis_json) as Analysis) : null;
      const frames = p.frames_json ? (JSON.parse(p.frames_json) as FrameInfo[]) : [];
      const est = await estimateVideoRender(meta.durationSec, ws, planVideoSegments(meta.durationSec, analysis, frames));
      db()
        .prepare(`UPDATE generations SET cost_est_json = ? WHERE id = ?`)
        .run(JSON.stringify({ wavespeedUsd: est.usd, billedSeconds: est.billedSeconds }), genId);
    } catch {
      /* смета вторична */
    }
  })();

  if (!slotBusy) {
    void runUploadAndSubmit(genId, ws, opts.pollBaseMs, opts._longHooks).catch((e) => {
      markFailed(genId, e instanceof Error ? e.message : String(e));
    });
  }
  return genId;
}

// ── FIFO-очередь рендеров ───────────────────────────────────────────────────

/** Позиция в очереди (1 = следующий); null, если генерация не queued. */
export function queuePositionOf(genId: string): number | null {
  const d = db();
  const gen = d
    .prepare(`SELECT created_at, rowid FROM generations WHERE id = ? AND status = 'queued'`)
    .get(genId) as { created_at: string; rowid: number } | undefined;
  if (!gen) return null;
  const ahead = d
    .prepare(
      `SELECT COUNT(*) AS c FROM generations WHERE status = 'queued'
        AND (created_at < ? OR (created_at = ? AND rowid < ?))`,
    )
    .get(gen.created_at, gen.created_at, gen.rowid) as { c: number };
  return ahead.c + 1;
}

/**
 * Продвижение очереди: если слот свободен — клейм старейшей queued-задачи в
 * BEGIN IMMEDIATE (interleave двух промоутов невозможен) и запуск detached-цепочки.
 * Зовётся из финалов рендера (done/failed), отмены и бута.
 */
export function promoteNext(ws: WaveSpeed = wavespeed, pollBaseMs?: number): void {
  const d = db();
  const claimed: string[] = [];
  d.exec('BEGIN IMMEDIATE');
  try {
    const openSlots = Math.max(0, config.renderConcurrency - activeGenerationCount());
    const next = d
      .prepare(`SELECT id FROM generations WHERE status = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT ?`)
      .all(openSlots) as Array<{ id: string }>;
    for (const row of next) {
      const changed = d
        .prepare(`UPDATE generations SET status = 'uploading_assets' WHERE id = ? AND status = 'queued'`)
        .run(row.id);
      if (Number(changed.changes) > 0) claimed.push(row.id);
    }
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    console.error('[queue] promoteNext упал:', e instanceof Error ? e.message : e);
    return;
  }
  for (const id of claimed) {
    console.log(`[queue] продвигаю gen=${id}`);
    void runUploadAndSubmit(id, ws, pollBaseMs).catch((e) => {
      markFailed(id, e instanceof Error ? e.message : String(e));
    });
  }
}

/** Отмена своей queued-задачи: строка → failed «отменено», резерв возвращается. */
export function cancelQueued(genId: string): boolean {
  const d = db();
  const res = d
    .prepare(
      `UPDATE generations SET status = 'failed', error = 'Отменено из очереди', finished_at = datetime('now')
        WHERE id = ? AND status = 'queued'`,
    )
    .run(genId);
  if (Number(res.changes) === 0) return false;
  const gen = loadGen(genId);
  if (gen) forceReleaseProjectHold(gen.project_id, genId, 'рендер отменён из очереди');
  return true;
}

/** Каскад при удалении проекта: его queued-задачи отменяются (hold освобождает delete-путь). */
export function cancelQueuedForProject(projectId: string): void {
  db()
    .prepare(
      `UPDATE generations SET status = 'failed', error = 'Проект удалён', finished_at = datetime('now')
        WHERE project_id = ? AND status = 'queued'`,
    )
    .run(projectId);
}

/** Звук по умолчанию — нативная генерация (решение Alex); false = дорожка исходника. */
export function parseGenerateAudio(flagsJson: string | null | undefined): boolean {
  if (!flagsJson) return true;
  try {
    const v = (JSON.parse(flagsJson) as { generateAudio?: unknown }).generateAudio;
    return v === undefined ? true : !!v;
  } catch {
    return true;
  }
}

async function validateAndPersistResult(
  genId: string,
  file: string,
  options: Parameters<RenderValidator>[1],
): Promise<FinalMediaValidation> {
  try {
    const validation = await renderValidator(file, options);
    db().prepare(`UPDATE generations SET validation_json=? WHERE id=?`).run(JSON.stringify(validation), genId);
    return validation;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db()
      .prepare(`UPDATE generations SET validation_json=? WHERE id=?`)
      .run(JSON.stringify({ ok: false, error: message.slice(0, 500) }), genId);
    throw new MediaValidationError(`Результат не прошёл техническую проверку: ${message}`);
  }
}

async function runUploadAndSubmit(
  genId: string,
  ws: WaveSpeed,
  pollBaseMs?: number,
  longHooks?: LongRenderHooks,
): Promise<void> {
  const d = db();
  const gen = loadGen(genId);
  if (!gen) return;
  const projectId = gen.project_id;
  const p = d
    .prepare(`SELECT video_file, flags_json, user_id, meta_json, analysis_json, frames_json FROM projects WHERE id = ?`)
    .get(projectId) as
    | {
        video_file: string | null;
        flags_json: string | null;
        user_id: string | null;
        meta_json: string | null;
        analysis_json: string | null;
        frames_json: string | null;
      }
    | undefined;
  if (!p?.video_file) throw new Error('Исходник недоступен');
  const meta = p.meta_json ? (JSON.parse(p.meta_json) as VideoMeta) : null;
  const analysis = p.analysis_json ? (JSON.parse(p.analysis_json) as Analysis) : null;
  const frames = p.frames_json ? (JSON.parse(p.frames_json) as FrameInfo[]) : [];
  const renderPlan = meta ? planVideoSegments(meta.durationSec, analysis, frames) : [];
  // Не-владелец платит кредитами; тексты денежных отказов для него — без USD оператора
  const metered = isMeteredUserId(p.user_id);

  const refs = d
    .prepare(`SELECT id, idx, role, file, note FROM refs WHERE project_id = ? ORDER BY idx ASC`)
    .all(projectId) as Array<{ id: string; idx: number; role: string; file: string; note: string }>;

  // Гвард по деньгам ЗДЕСЬ, а не только в /swap: авто-ре-рендер после iterate и ручной
  // POST /generations обходят роут свапа. Один и тот же замер баланса идёт и в гвард,
  // и в balance_before (дельта фактического списания).
  let balanceBefore: number | null = null;
  try {
    balanceBefore = await ws.getBalance();
  } catch {
    /* без баланса гварда нет — останется формула для факта */
  }
  let renderEstUsd: number | null = null;
  try {
    if (meta) {
      renderEstUsd = (await estimateVideoRender(meta.durationSec, ws, renderPlan)).usd;
    }
  } catch {
    /* смета вторична — не блокируем */
  }
  if (balanceBefore !== null && renderEstUsd !== null && renderEstUsd > balanceBefore - 0.05) {
    markFailed(
      genId,
      metered
        ? 'Рендер временно недоступен — попробуй позже, деньги не списаны'
        : `Не хватает баланса WaveSpeed: рендер ≈ $${renderEstUsd.toFixed(2)}, на счету $${balanceBefore.toFixed(2)} — пополни и нажми «Повторить рендер»`,
    );
    return;
  }

  // Кредитный гейт не-владельца: реюз открытого hold-а проекта (/swap уже поставил его
  // на весь флоу; retry/manual-пути приходят сюда без hold-а → рендер-hold по смете).
  if (metered) {
    let holdId = openHoldForProject(projectId)?.id ?? null;
    if (!holdId) {
      let userEstimateUsd = renderEstUsd;
      try {
        const fullEstimate = await buildEstimate(
          {
            id: projectId,
            frames_json: p.frames_json,
            analysis_json: p.analysis_json,
            flags_json: p.flags_json,
            meta_json: p.meta_json,
            video_purged: 0,
          },
          ws,
        );
        userEstimateUsd = fullEstimate.totalUsd;
      } catch {
        /* ниже fail-closed по доступности сметы */
      }
      if (userEstimateUsd === null) {
        markFailed(genId, 'Цена временно недоступна — попробуй чуть позже, деньги не списаны');
        return;
      }
      const res = placeHold(p.user_id!, projectId, priceCredits(userEstimateUsd));
      if (!res.ok) {
        markFailed(
          genId,
          `Нужно $${(res.needCredits / 100).toFixed(2)}, на балансе $${(res.availableCredits / 100).toFixed(2)} — пополни баланс и повтори рендер`,
        );
        return;
      }
      holdId = res.holdId;
    }
    attachHoldGeneration(holdId, genId);
  }

  if (meta && meta.durationSec > 15) {
    try {
      await runLongVideo(
        genId,
        ws,
        {
          ...p,
          video_file: p.video_file,
          meta,
          analysis,
          frames,
        },
        refs as RefInfo[],
        pollBaseMs,
        longHooks,
      );
    } catch (e) {
      const terminal = e instanceof LongWsFailure && e.terminal;
      markFailed(genId, e instanceof Error ? e.message : String(e), {
        wsTerminal: terminal,
        releaseHold: e instanceof MediaValidationError,
      });
    }
    return;
  }

  // Переиспользуем свежие URL (ретрай после сбоя не перезаливает сотни мегабайт)
  const prior = gen.retry_of ? loadGen(gen.retry_of) : undefined;
  const assets: Assets = { refs: {}, ...freshAssets(prior?.ws_assets_json ?? gen.ws_assets_json) };
  assets.refs ??= {};

  if (!assets.video) {
    const url = await ws.uploadBinary(path.join(projectDir(projectId), p.video_file));
    assets.video = { url, at: new Date().toISOString() };
    saveAssets(genId, assets);
  }
  const startFile = latestStartFrame(projectId, gen.version);
  if (!startFile) throw new Error('Стартовый кадр исчез — сгенерируй его заново');
  if (!assets.start) {
    const url = await ws.uploadBinary(path.join(startDir(projectId), startFile));
    assets.start = { url, at: new Date().toISOString() };
    saveAssets(genId, assets);
  }
  // максимум 9 reference_images с учётом старт-кадра → рефов не больше 8
  const usableRefs = refs.slice(0, 8);
  for (const r of usableRefs) {
    if (assets.refs[r.id]) continue;
    const url = await ws.uploadBinary(path.join(refsDir(projectId), r.file));
    assets.refs[r.id] = { url, at: new Date().toISOString() };
    saveAssets(genId, assets);
  }
  // Безусловно: полностью переиспользованный ретрай тоже должен нести ассеты на СВОЕЙ
  // строке, иначе ретрай-от-ретрая не найдёт URL и перезальёт сотни мегабайт заново
  saveAssets(genId, assets);

  // Баланс до сабмита — для фактического списания по дельте (замер из гварда выше)
  if (balanceBefore !== null) {
    d.prepare(`UPDATE generations SET balance_before_usd = ? WHERE id = ?`).run(balanceBefore, genId);
  }

  const promptRow = d
    .prepare(
      `SELECT text FROM prompts WHERE project_id = ? AND version = ? AND kind = 'video' LIMIT 1`,
    )
    .get(projectId, gen.version) as { text: string };
  const params = JSON.parse(gen.params_json) as {
    resolution: string;
    generate_audio: boolean;
  };

  // Пока грузились, генерацию могли отменить/пометить failed (рестарт, удаление) —
  // сабмит без этого гварда = деньги на задачу, которую никто не ждёт
  const fresh = loadGen(genId);
  if (!fresh || fresh.status !== 'uploading_assets') return;

  const predictionId = await ws.submitVideoEdit({
    prompt: promptRow.text,
    video: assets.video.url,
    reference_images: [assets.start.url, ...usableRefs.map((r) => assets.refs![r.id]!.url)],
    aspect_ratio: '9:16',
    resolution: params.resolution,
    generate_audio: params.generate_audio,
    enable_web_search: false,
  });
  // prediction_id пишем безусловно (recheck сможет добрать результат), статус — только
  // если генерацию не пометили failed во время сабмита
  d.prepare(`UPDATE generations SET ws_prediction_id = ? WHERE id = ?`).run(predictionId, genId);
  const flipped = d
    .prepare(
      `UPDATE generations SET status = 'submitted', submitted_at = datetime('now') WHERE id = ? AND status = 'uploading_assets'`,
    )
    .run(genId);
  if (Number(flipped.changes) === 0) {
    console.warn(`[render] gen=${genId} отменена во время сабмита — поллер не подключаю (recheck доберёт)`);
    return;
  }
  attachPoller(genId, ws, pollBaseMs);
}

class LongWsFailure extends Error {
  terminal: boolean;
  constructor(message: string, terminal = false) {
    super(message);
    this.name = 'LongWsFailure';
    this.terminal = terminal;
  }
}

const longRunners = new Set<string>();

function longWorkDir(projectId: string, genId: string): string {
  return path.join(projectDir(projectId), 'render-work', genId);
}

function longFile(projectId: string, genId: string, file: string): string {
  return path.join(longWorkDir(projectId, genId), file);
}

function continuationVideoPrompt(base: string, segment: LongSegmentState, count: number): string {
  return `${base}\n\nCONTINUITY ${segment.index + 1}/${count}: Start exactly on reference image 1. Keep the same face, body, outfit, key objects, contact points and lighting; no reset, morphing, duplicates or design drift.`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitLongPrediction(
  predictionId: string,
  submittedAt: string,
  ws: WaveSpeed,
  baseMs: number,
  resetBudget = false,
): Promise<WsPrediction> {
  let errors = 0;
  const parsedStarted = Date.parse(submittedAt);
  const started = resetBudget || !Number.isFinite(parsedStarted) ? Date.now() : parsedStarted;
  let polled = false;
  for (;;) {
    if (polled && Date.now() - started > config.renderPollBudgetMs) {
      throw new LongWsFailure(
        `Рендер части идёт дольше ${Math.round(config.renderPollBudgetMs / 60000)} мин — нажми «Проверить ещё раз»`,
      );
    }
    let result: WsPrediction;
    try {
      result = await ws.pollResult(predictionId);
      polled = true;
      errors = 0;
    } catch (e) {
      errors++;
      if (errors >= 5) {
        throw new LongWsFailure(
          `Сеть до WaveSpeed потеряна (${e instanceof Error ? e.message.slice(0, 120) : e}) — нажми «Проверить ещё раз»`,
        );
      }
      await delay(baseMs * 2);
      continue;
    }
    if (wsState(result.status) === 'completed') return result;
    const terminal = terminalWsMessage(result);
    if (terminal) throw new LongWsFailure(terminal, true);
    await delay(Date.now() - started > 120_000 ? baseMs * 2 : baseMs);
  }
}

async function predictionCost(
  durationSec: number,
  result: WsPrediction,
  ws: WaveSpeed,
): Promise<{ usd: number | null; source: string | null }> {
  const estimate = await estimateRender(durationSec, ws).catch(() => null);
  const sanityCap = estimate?.usd ? estimate.usd * 3 : 50;
  for (const key of ['cost', 'total_price', 'price', 'billing_amount']) {
    const value = (result.raw as Record<string, unknown>)[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      const usd = [value, value / 100, value / 1e6].find(
        (candidate) => candidate > 0.0005 && candidate <= sanityCap && candidate < 100,
      );
      if (usd !== undefined) return { usd: Math.round(usd * 10000) / 10000, source: 'api' };
    }
  }
  return estimate?.usd !== null && estimate?.usd !== undefined
    ? { usd: estimate.usd, source: 'formula' }
    : { usd: null, source: null };
}

async function runLongVideo(
  genId: string,
  ws: WaveSpeed,
  project: {
    video_file: string;
    flags_json: string | null;
    user_id: string | null;
    meta: VideoMeta;
    analysis: Analysis | null;
    frames: FrameInfo[];
  },
  refs: RefInfo[],
  pollBaseMs?: number,
  hooks: LongRenderHooks = {},
  resetPollBudget = false,
): Promise<void> {
  if (longRunners.has(genId)) return;
  longRunners.add(genId);
  const d = db();
  const gen = loadGen(genId);
  if (!gen) {
    longRunners.delete(genId);
    return;
  }
  const projectId = gen.project_id;
  const source = path.join(projectDir(projectId), project.video_file);
  const work = longWorkDir(projectId, genId);
  fs.mkdirSync(work, { recursive: true });

  try {
    let state = parseLongState(gen.segments_json);
    if (!state) {
      state = {
        version: 1,
        overlapSec: SEAM_OVERLAP_SECONDS,
        segments: planVideoSegments(project.meta.durationSec, project.analysis, project.frames).map((s) => ({
          ...s,
          status: 'planned',
        })),
      };
      saveLongState(genId, state);
    }

    const prompt = d
      .prepare(`SELECT text FROM prompts WHERE project_id = ? AND version = ? AND kind = 'video' LIMIT 1`)
      .get(projectId, gen.version) as { text: string } | undefined;
    const videoPrompt = prompt?.text;
    if (!videoPrompt) throw new LongWsFailure('Нет видеопромта для длинного рендера');

    const assets: Assets = { refs: {}, ...freshAssets(gen.ws_assets_json) };
    assets.refs ??= {};
    const usableRefs = refs.slice(0, 8);
    for (const ref of usableRefs) {
      if (!assets.refs[ref.id]) {
        const url = await ws.uploadBinary(path.join(refsDir(projectId), ref.file));
        assets.refs[ref.id] = { url, at: new Date().toISOString() };
        saveAssets(genId, assets);
      }
    }

    const originalStart = latestStartFrame(projectId, gen.version);
    if (!originalStart) throw new LongWsFailure('Стартовый кадр исчез — сгенерируй его заново');

    for (const segment of state.segments) {
      if (segment.status === 'done' && segment.outputFile && fs.existsSync(longFile(projectId, genId, segment.outputFile))) {
        continue;
      }
      if (segment.status === 'done') segment.status = 'planned';

      const number = String(segment.index + 1).padStart(2, '0');
      if (!segment.sourceFile || !fs.existsSync(longFile(projectId, genId, segment.sourceFile))) {
        segment.sourceFile = `segment_${number}_source.mp4`;
        await (hooks.cut ?? cutVideoSegment)(source, longFile(projectId, genId, segment.sourceFile), segment.startSec, segment.endSec);
      }

      if (segment.index === 0) {
        segment.startFile = originalStart;
      } else if (!segment.anchorFile || !fs.existsSync(longFile(projectId, genId, segment.anchorFile))) {
        segment.anchorFile = `segment_${number}_anchor.png`;
        const anchor = longFile(projectId, genId, segment.anchorFile);
        const previous = state.segments[segment.index - 1];
        const previousRender = previous?.outputFile
          ? longFile(projectId, genId, previous.outputFile)
          : null;
        if (!previous || !previousRender || !fs.existsSync(previousRender)) {
          throw new LongWsFailure('Не удалось получить готовую предыдущую часть для точного стыка');
        }
        // Anchor уже содержит готовый свап предыдущей части. Повторная генерация
        // GPT Image здесь вносила бы дрейф лица, одежды или формы важного объекта.
        await (hooks.extract ?? extractFrameAt)(
          previousRender,
          Math.max(0, segment.startSec - previous.startSec),
          anchor,
        );
      }
      segment.status = segment.predictionId ? 'submitted' : 'prepared';
      saveLongState(genId, state);

      let result: WsPrediction;
      if (segment.predictionId) {
        result = await waitLongPrediction(
          segment.predictionId,
          segment.submittedAt ?? new Date().toISOString(),
          ws,
          pollBaseMs ?? DEFAULT_POLL_BASE_MS,
          resetPollBudget,
        );
      } else {
        // URL сегментных ассетов намеренно обновляются перед каждым новым сабмитом:
        // retry через несколько дней не должен полагаться на истёкший CDN URL.
        segment.videoUrl = await ws.uploadBinary(longFile(projectId, genId, segment.sourceFile));
        const continuityFrame = segment.index === 0
          ? path.join(startDir(projectId), segment.startFile!)
          : longFile(projectId, genId, segment.anchorFile!);
        segment.startUrl = await ws.uploadBinary(continuityFrame);
        const fresh = loadGen(genId);
        if (!fresh || !ACTIVE_GEN_STATUSES.includes(fresh.status)) return;
        segment.predictionId = await ws.submitVideoEdit({
          prompt: continuationVideoPrompt(videoPrompt, segment, state.segments.length),
          video: segment.videoUrl,
          reference_images: [segment.startUrl, ...usableRefs.map((r) => assets.refs![r.id]!.url)],
          aspect_ratio: '9:16',
          resolution: config.seedanceResolution,
          generate_audio: parseGenerateAudio(project.flags_json),
          enable_web_search: false,
        });
        segment.submittedAt = new Date().toISOString();
        segment.status = 'submitted';
        d.prepare(
          `UPDATE generations SET ws_prediction_id = ?, status = 'submitted',
             submitted_at = COALESCE(submitted_at, datetime('now')) WHERE id = ?`,
        ).run(segment.predictionId, genId);
        saveLongState(genId, state);
        result = await waitLongPrediction(
          segment.predictionId,
          segment.submittedAt,
          ws,
          pollBaseMs ?? DEFAULT_POLL_BASE_MS,
          resetPollBudget,
        );
      }

      const output = result.outputs[0];
      if (!output) throw new LongWsFailure('WaveSpeed не вернул ссылку на результат части');
      d.prepare(`UPDATE generations SET status = 'downloading' WHERE id = ?`).run(genId);
      segment.outputFile = `segment_${number}_render.mp4`;
      await ws.downloadOutput(output, longFile(projectId, genId, segment.outputFile), config.renderMaxBytes);
      const cost = await predictionCost(segment.endSec - segment.startSec, result, ws);
      segment.costUsd = cost.usd;
      segment.costSource = cost.source;
      segment.nsfw = extractNsfw(result.raw);
      segment.status = 'done';
      saveLongState(genId, state);
      if (segment.index < state.segments.length - 1) {
        d.prepare(`UPDATE generations SET status = 'rendering' WHERE id = ?`).run(genId);
      }
    }

    const outputs = state.segments.map((s) => longFile(projectId, genId, s.outputFile!));
    const file = `gen_${genId}.mp4`;
    const dest = path.join(rendersDir(projectId), file);
    d.prepare(`UPDATE generations SET status = 'downloading' WHERE id = ?`).run(genId);
    const continuityFrames = state.segments.map((segment) =>
      segment.index === 0 || !segment.anchorFile ? null : longFile(projectId, genId, segment.anchorFile),
    );
    const continuityCutSeconds = state.segments.map((segment, index) =>
      index === 0 ? null : Math.max(0, segment.startSec - state.segments[index - 1]!.startSec),
    );
    const bytes = await (hooks.stitch ?? stitchVideoSegments)(
      outputs,
      dest,
      state.overlapSec,
      source,
      continuityFrames,
      continuityCutSeconds,
    );
    const continuity: ContinuityValidationPoint[] = [];
    let seamAt = 0;
    for (let index = 1; index < state.segments.length; index++) {
      const previous = state.segments[index - 1]!;
      seamAt += continuityCutSeconds[index] ?? Math.max(0.1, previous.endSec - previous.startSec - state.overlapSec);
      const frameFile = continuityFrames[index];
      if (frameFile) continuity.push({ atSec: seamAt, frameFile });
    }
    await validateAndPersistResult(genId, dest, {
      expectedDurationSec: project.meta.durationSec,
      expectAudio: parseGenerateAudio(project.flags_json),
      continuity,
    });
    const knownCosts = state.segments.map((s) => s.costUsd).filter((n): n is number => typeof n === 'number');
    const costUsd = knownCosts.length === state.segments.length
      ? Math.round(knownCosts.reduce((sum, n) => sum + n, 0) * 10000) / 10000
      : null;
    const sources = new Set(state.segments.map((s) => s.costSource).filter(Boolean));
    const costSource = sources.size === 1 ? ([...sources][0] ?? null) : knownCosts.length ? 'formula' : null;
    const nsfw = state.segments.map((s) => s.nsfw).filter(Boolean).join(' · ');
    d.prepare(
      `UPDATE generations SET status = 'done', file = ?, bytes = ?, error = NULL,
          cost_actual_usd = ?, cost_source = ?, segment_done = segment_count,
          finished_at = datetime('now'), notes = CASE WHEN notes = '' AND ? != '' THEN ? ELSE notes END
        WHERE id = ?`,
    ).run(file, bytes, costUsd, costSource, nsfw, nsfw, genId);
    settleProjectHold(projectId, genId, costUsd);
    fs.rmSync(work, { recursive: true, force: true });
    enforceStorageCap();
    console.log(`[render-long] done gen=${genId} segments=${state.segments.length} bytes=${bytes} cost=$${costUsd ?? '?'}`);
    promoteNext(ws);
  } catch (e) {
    const state = parseLongState(loadGen(genId)?.segments_json ?? null);
    if (e instanceof LongWsFailure && e.terminal && state) {
      const current = state.segments.find((s) => s.status === 'submitted');
      if (current) current.status = 'failed';
      saveLongState(genId, state);
    }
    throw e;
  } finally {
    longRunners.delete(genId);
  }
}

async function resumeLongVideo(
  genId: string,
  ws: WaveSpeed,
  pollBaseMs?: number,
  resetPollBudget = false,
): Promise<void> {
  const gen = loadGen(genId);
  if (!gen) return;
  const p = db()
    .prepare(`SELECT video_file, flags_json, user_id, meta_json, analysis_json, frames_json FROM projects WHERE id = ?`)
    .get(gen.project_id) as
    | {
        video_file: string | null;
        flags_json: string | null;
        user_id: string | null;
        meta_json: string | null;
        analysis_json: string | null;
        frames_json: string | null;
      }
    | undefined;
  if (!p?.video_file || !p.meta_json) throw new LongWsFailure('Исходник длинного ролика недоступен');
  const refs = db()
    .prepare(`SELECT id, idx, role, file, note FROM refs WHERE project_id = ? ORDER BY idx ASC`)
    .all(gen.project_id) as unknown as RefInfo[];
  await runLongVideo(
    genId,
    ws,
    {
      video_file: p.video_file,
      flags_json: p.flags_json,
      user_id: p.user_id,
      meta: JSON.parse(p.meta_json) as VideoMeta,
      analysis: p.analysis_json ? (JSON.parse(p.analysis_json) as Analysis) : null,
      frames: p.frames_json ? (JSON.parse(p.frames_json) as FrameInfo[]) : [],
    },
    refs,
    pollBaseMs,
    {},
    resetPollBudget,
  );
}

// ── Поллер ──────────────────────────────────────────────────────────────────

const pollers = new Map<string, NodeJS.Timeout>();

let DEFAULT_POLL_BASE_MS = 5000;
/** Тестовый рычаг: базовый интервал поллинга для всех путей (retry/recheck/resume). */
export function _setPollBaseMs(ms: number): void {
  DEFAULT_POLL_BASE_MS = ms;
}

function stopPoller(genId: string): void {
  const t = pollers.get(genId);
  if (t) clearTimeout(t);
  pollers.delete(genId);
}

/** 'YYYY-MM-DD HH:MM:SS' (sqlite, UTC) → ms epoch. */
function dbTimeMs(s: string | null): number {
  if (!s) return Date.now();
  const t = Date.parse(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? t : Date.now();
}

export function attachPoller(genId: string, ws: WaveSpeed = wavespeed, baseMs?: number): void {
  if (pollers.has(genId)) return;
  const base = baseMs ?? DEFAULT_POLL_BASE_MS;
  let consecutiveErrors = 0;

  const schedule = (ms: number) => {
    const t = setTimeout(tick, ms);
    // не держим процесс живым ради поллера (systemd перезапустит и resumeGenerations подхватит)
    if (typeof t.unref === 'function') t.unref();
    pollers.set(genId, t);
  };

  const tick = async () => {
    // запись в map НЕ удаляем на время тика: attachPoller во время in-flight опроса
    // должен видеть «поллер есть», иначе recheck порождает вторую параллельную цепочку
    const gen = loadGen(genId);
    if (!gen || !['submitted', 'rendering', 'downloading'].includes(gen.status)) {
      pollers.delete(genId);
      return;
    }
    if (!gen.ws_prediction_id) {
      markFailed(genId, 'Потерян id задачи WaveSpeed — запусти рендер заново');
      return;
    }
    const startedMs = dbTimeMs(gen.submitted_at);
    if (Date.now() - startedMs > config.renderPollBudgetMs) {
      markFailed(
        genId,
        `Рендер идёт дольше ${Math.round(config.renderPollBudgetMs / 60000)} мин — нажми «Проверить ещё раз» (задача не потеряна)`,
      );
      return;
    }
    let r: WsPrediction;
    try {
      r = await ws.pollResult(gen.ws_prediction_id);
      consecutiveErrors = 0;
    } catch (e) {
      consecutiveErrors++;
      if (consecutiveErrors >= 5) {
        markFailed(
          genId,
          `Сеть до WaveSpeed потеряна (${e instanceof Error ? e.message.slice(0, 120) : e}) — нажми «Проверить ещё раз»`,
        );
        return;
      }
      schedule(base * 2);
      return;
    }

    const terminalMessage = terminalWsMessage(r);
    if (terminalMessage) {
      markFailed(genId, terminalMessage, { wsTerminal: true });
      return;
    }
    if (wsState(r.status) === 'completed') {
      try {
        await completeFromResult(gen, r, ws);
      } catch {
        // completeFromResult already persisted the precise failure and hold policy.
      }
      return;
    }
    if (gen.status === 'submitted') {
      db().prepare(`UPDATE generations SET status = 'rendering' WHERE id = ?`).run(genId);
    }
    // после 2 минут поллим реже
    schedule(Date.now() - startedMs > 120_000 ? base * 2 : base);
  };

  schedule(base);
}

/** Общий финал для поллера, recheck и retry-восстановления: скачивание + фактическая стоимость + done. */
async function completeFromResult(gen: GenRow, r: WsPrediction, ws: WaveSpeed): Promise<void> {
  const d = db();
  const output = r.outputs[0];
  if (!output) throw new Error('WaveSpeed не вернул ссылку на результат');
  // Гвард от конкурентных финалов (поллер + recheck): в downloading переходит ровно одна
  // цепочка, остальные молча выходят — иначе два стрима пишут в один .part → битый mp4.
  // 'failed' в списке валиден: recheck/retry добирают результат после таймаута.
  const flipped = d
    .prepare(
      `UPDATE generations SET status = 'downloading' WHERE id = ? AND status IN ('submitted','rendering','failed')`,
    )
    .run(gen.id);
  if (Number(flipped.changes) === 0) return;
  stopPoller(gen.id);

  try {
    const file = `gen_${gen.id}.mp4`;
    const dest = path.join(rendersDir(gen.project_id), file);
    const bytes = await ws.downloadOutput(output, dest, config.renderMaxBytes);

    const project = d
      .prepare(`SELECT meta_json,flags_json FROM projects WHERE id=?`)
      .get(gen.project_id) as { meta_json: string | null; flags_json: string | null } | undefined;
    if (!project?.meta_json) throw new MediaValidationError('У проекта исчезли метаданные исходного видео');
    const meta = JSON.parse(project.meta_json) as VideoMeta;
    await validateAndPersistResult(gen.id, dest, {
      expectedDurationSec: meta.durationSec,
      expectAudio: parseGenerateAudio(project.flags_json),
    });

    const cost = await captureCost(gen, r, ws);
    const nsfw = extractNsfw(r.raw);
    d.prepare(
      `UPDATE generations SET status = 'done', file = ?, bytes = ?, error = NULL,
          cost_actual_usd = ?, cost_source = ?, finished_at = datetime('now'),
          notes = CASE WHEN notes = '' AND ? != '' THEN ? ELSE notes END
        WHERE id = ?`,
    ).run(file, bytes, cost.usd, cost.source, nsfw, nsfw, gen.id);
    // Кредиты: единый финал → честный settle по факту (cap = hold); владельцу — no-op
    settleProjectHold(gen.project_id, gen.id, cost.usd);
    enforceStorageCap();
    console.log(
      `[render] done gen=${gen.id} bytes=${bytes} cost=$${cost.usd ?? '?'} source=${cost.source ?? '-'}`,
    );
    promoteNext(ws); // слот освободился — очередь едет дальше
  } catch (e) {
    // Не оставляем генерацию висеть в downloading (recheck на ней вернул бы ложный done):
    // финал сорвался → failed, задача у WaveSpeed жива — recheck доберёт
    markFailed(
      gen.id,
      e instanceof MediaValidationError
        ? e.message
        : `Скачивание результата сорвалось: ${e instanceof Error ? e.message.slice(0, 200) : e} — нажми «Проверить ещё раз»`,
      { releaseHold: e instanceof MediaValidationError },
    );
    throw e;
  }
}

function extractNsfw(raw: Record<string, unknown>): string {
  const v = raw?.has_nsfw_contents;
  const flagged = Array.isArray(v) ? v.some(Boolean) : !!v;
  return flagged ? '⚠ WaveSpeed пометил результат как NSFW' : '';
}

/**
 * Фактическое списание: поле из result-ответа (если отдают) → дельта баланса → живая формула.
 * cost_source фиксирует, какой источник победил.
 */
async function captureCost(
  gen: GenRow,
  r: WsPrediction,
  ws: WaveSpeed,
): Promise<{ usd: number | null; source: string | null }> {
  const est = parseEst(gen.cost_est_json);
  // санити-окно как у дельты баланса: не даём неверной единице (центы/µ$) записать $60 вместо $0.60
  const sanityCap = est?.wavespeedUsd ? est.wavespeedUsd * 3 : 50;
  // 1) прямое поле в ответе (проверяем на смоке, какие поля реально отдают)
  for (const key of ['cost', 'total_price', 'price', 'billing_amount']) {
    const v = (r.raw as Record<string, unknown>)[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      // кандидаты единиц: USD → центы → µ$ (как в формуле каталога); берём первый в санити-окне
      const usd = [v, v / 100, v / 1e6].find((c) => c > 0.0005 && c <= sanityCap && c < 100);
      if (usd !== undefined) return { usd: Math.round(usd * 10000) / 10000, source: 'api' };
    }
  }
  // 2) дельта баланса валидна только в явно однопоточном режиме. При параллельных
  // рендерах она смешивает списания разных пользователей — тогда сразу идём к формуле.
  if (config.renderConcurrency === 1 && typeof gen.balance_before_usd === 'number') {
    try {
      const after = await ws.getBalance();
      const delta = gen.balance_before_usd - after;
      const cap = est?.wavespeedUsd ? est.wavespeedUsd * 3 : 50;
      if (delta > 0 && delta < cap) return { usd: Math.round(delta * 10000) / 10000, source: 'balance_delta' };
    } catch {
      /* переходим к формуле */
    }
  }
  // 3) формула по живому тарифу
  try {
    const meta = db()
      .prepare(`SELECT meta_json FROM projects WHERE id = ?`)
      .get(gen.project_id) as { meta_json: string | null } | undefined;
    if (meta?.meta_json) {
      const m = JSON.parse(meta.meta_json) as VideoMeta;
      const e = await estimateVideoRender(m.durationSec, ws);
      if (e.usd !== null) return { usd: e.usd, source: 'formula' };
    }
  } catch {
    /* совсем без цены */
  }
  return { usd: null, source: null };
}

function parseEst(json: string | null): { wavespeedUsd: number | null } | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as { wavespeedUsd: number | null };
  } catch {
    return null;
  }
}

// ── Возобновление, ретрай, ре-чек ───────────────────────────────────────────

/**
 * На буте: локально прерванные аплоады → failed (ретрай дёшев),
 * удалённые стадии → переподцепить поллер (деньги уже в работе — не терять).
 */
export function resumeGenerations(ws: WaveSpeed = wavespeed): { failed: number; resumed: number } {
  const d = db();
  const failed = d
    .prepare(
      `UPDATE generations SET status = 'failed', error = 'Загрузка прервана перезапуском сервиса — нажми «Повторить рендер»', finished_at = datetime('now')
        WHERE status = 'uploading_assets'`,
    )
    .run().changes;
  // Упавшие мид-скачивание — назад в rendering: активного стрима больше нет, а гвард
  // финала (status IN submitted/rendering/failed) иначе не пустил бы поллер к повтору
  d.prepare(`UPDATE generations SET status = 'rendering' WHERE status = 'downloading'`).run();
  const rows = d
    .prepare(`SELECT id, segments_json FROM generations WHERE status IN ('submitted','rendering')`)
    .all() as Array<{ id: string; segments_json: string | null }>;
  for (const row of rows) {
    if (parseLongState(row.segments_json)) {
      void resumeLongVideo(row.id, ws).catch((e) => {
        markFailed(row.id, e instanceof Error ? e.message : String(e), {
          wsTerminal: e instanceof LongWsFailure && e.terminal,
          releaseHold: e instanceof MediaValidationError,
        });
      });
    } else {
      attachPoller(row.id, ws);
    }
  }
  if (failed || rows.length) {
    console.log(`[render] resume: поллеров=${rows.length}, прерванных аплоадов=${failed}`);
  }
  // queued-строки переживают рестарт нетронутыми; если слот свободен — продвигаем
  promoteNext(ws);
  return { failed: Number(failed), resumed: rows.length };
}

/**
 * Новая генерация той же версии; свежие URL ассетов переиспользуются.
 * Если у неудавшейся генерации есть живой prediction_id — сперва опрашиваем WaveSpeed:
 * задача могла дорендериться (таймаут поллинга ≠ смерть задачи), и слепой повторный
 * сабмит = двойное списание за один результат.
 */
export async function retryGeneration(genId: string, ws: WaveSpeed = wavespeed): Promise<string> {
  const gen = loadGen(genId);
  if (!gen) throw new RenderGateError(404, 'Генерация не найдена');
  if (gen.status !== 'failed') throw new RenderGateError(409, 'Повторить можно только неудавшийся рендер');
  const longState = parseLongState(gen.segments_json);
  // Если все удалённые части уже готовы, упала только локальная склейка/диск. Не
  // создаём новый рендер и не рискуем повторным списанием — просто продолжаем финал.
  if (
    longState &&
    !longState.segments.some((s) => s.status === 'failed') &&
    (!!gen.ws_prediction_id || !!openHoldForProject(gen.project_id))
  ) {
    db().prepare(`UPDATE generations SET status = 'rendering', error = NULL, finished_at = NULL WHERE id = ?`).run(genId);
    void resumeLongVideo(genId, ws, undefined, true).catch((e) => {
      markFailed(genId, e instanceof Error ? e.message : String(e), {
        wsTerminal: e instanceof LongWsFailure && e.terminal,
        releaseHold: e instanceof MediaValidationError,
      });
    });
    return genId;
  }
  if (gen.ws_prediction_id) {
    let r: WsPrediction;
    try {
      r = await ws.pollResult(gen.ws_prediction_id);
    } catch {
      throw new RenderGateError(
        502,
        'Не удалось проверить статус прежней задачи у WaveSpeed — повторный сабмит вслепую рискует двойным списанием, попробуй через минуту',
      );
    }
    const state = wsState(r.status);
    if (state === 'completed') {
      await completeFromResult(gen, r, ws); // деньги спасены: результат уже оплачен
      return gen.id;
    }
    if (state === 'pending') {
      throw new RenderGateError(
        409,
        'Задача ещё рендерится у WaveSpeed — жми «Проверить ещё раз», повторный запуск списал бы деньги дважды',
      );
    }
  }
  return startRender(gen.project_id, gen.version, { ws, retryOf: genId });
}

/**
 * После таймаута/сети: одиночный ре-полл — если WaveSpeed уже дорендерил, деньги не сгорают.
 * Если ещё рендерится — переподцепляем поллер (при свободном слоте).
 */
export async function recheckGeneration(genId: string, ws: WaveSpeed = wavespeed): Promise<string> {
  const gen = loadGen(genId);
  if (!gen) throw new RenderGateError(404, 'Генерация не найдена');
  if (gen.status === 'done') return 'done';
  const longState = parseLongState(gen.segments_json);
  if (longState) {
    if (longState.segments.some((s) => s.status === 'failed')) return 'failed';
    if (!gen.ws_prediction_id) {
      throw new RenderGateError(409, 'Удалённая задача ещё не стартовала — используй «Повторить рендер»');
    }
    if (activeGenerationCount() >= config.renderConcurrency && !ACTIVE_GEN_STATUSES.includes(gen.status)) {
      throw new RenderGateError(409, 'Все слоты заняты другими рендерами — проверь чуть позже');
    }
    db().prepare(
      `UPDATE generations SET status = 'rendering', error = NULL, finished_at = NULL WHERE id = ?`,
    ).run(genId);
    void resumeLongVideo(genId, ws, undefined, true).catch((e) => {
      markFailed(genId, e instanceof Error ? e.message : String(e), {
        wsTerminal: e instanceof LongWsFailure && e.terminal,
        releaseHold: e instanceof MediaValidationError,
      });
    });
    return 'rendering';
  }
  if (!gen.ws_prediction_id) throw new RenderGateError(409, 'У этой генерации нет id задачи WaveSpeed');
  const r = await ws.pollResult(gen.ws_prediction_id);
  if (wsState(r.status) === 'completed') {
    await completeFromResult(gen, r, ws);
    return 'done';
  }
  const terminalMessage = terminalWsMessage(r);
  if (terminalMessage) {
    markFailed(genId, terminalMessage, { wsTerminal: true });
    return 'failed';
  }
  // всё ещё в работе на стороне WaveSpeed
  if (activeGenerationCount() >= config.renderConcurrency && !ACTIVE_GEN_STATUSES.includes(gen.status)) {
    throw new RenderGateError(409, 'Задача ещё рендерится у WaveSpeed, но все слоты заняты — проверь позже');
  }
  db()
    .prepare(
      `UPDATE generations SET status = 'rendering', error = NULL, finished_at = NULL, submitted_at = datetime('now') WHERE id = ?`,
    )
    .run(genId);
  attachPoller(genId, ws);
  return 'rendering';
}

export type { FlowFlags };
