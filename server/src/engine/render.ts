// Жизненный цикл рендера WaveSpeed: загрузка ассетов → сабмит → поллинг → скачивание → done.
// Всё вне серийной CPU-очереди (это удалённые ожидания). Статус живёт в generations.status.
// Рестарт-безопасно: submitted/rendering/downloading возобновляются по ws_prediction_id.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import { config } from '../config';
import { wavespeed, type WaveSpeed, type WsPrediction } from '../wavespeed';
import { estimateRender } from '../pricing';
import { enforceStorageCap, projectDir, refsDir, rendersDir, startDir } from '../storage';
import { parseFlags, type FlowFlags } from './orchestrator';
import type { VideoMeta } from '../../../shared/api-types';

/** Ошибка с HTTP-статусом для роутов (409 = гейт, 404 = нет объекта). */
export class RenderGateError extends Error {
  httpStatus: number;
  constructor(httpStatus: number, message: string) {
    super(message);
    this.name = 'RenderGateError';
    this.httpStatus = httpStatus;
  }
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

const ASSET_FRESH_MS = 6 * 24 * 3_600_000; // WaveSpeed хранит 7 дней; берём с запасом

function db() {
  return getDb();
}

function loadGen(genId: string): GenRow | undefined {
  return db().prepare(`SELECT * FROM generations WHERE id = ?`).get(genId) as GenRow | undefined;
}

/** Единственный активный рендер на весь сервис: и дельта баланса честная, и двойной траты нет. */
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

function markFailed(genId: string, msg: string): void {
  stopPoller(genId);
  db()
    .prepare(
      `UPDATE generations SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ? AND status != 'done'`,
    )
    .run(msg.slice(0, 500), genId);
}

/** Человеческая формулировка причин WaveSpeed. */
function ruWsFailure(raw: string): string {
  const s = (raw || '').slice(0, 300);
  if (/nsfw|content policy|moderation/i.test(s)) return `WaveSpeed отклонил контент модерацией: ${s}`;
  if (/balance|insufficient|credit/i.test(s)) return `Не хватило баланса WaveSpeed: ${s}`;
  return s ? `WaveSpeed: ${s}` : 'WaveSpeed сообщил об ошибке без деталей';
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
}

/**
 * Создаёт генерацию и запускает detached-цепочку (upload → submit → poll → download).
 * Бросает RenderGateError при нарушении гейтов — строка генерации при этом НЕ создаётся.
 */
export function startRender(projectId: string, version: number, opts: StartRenderOpts = {}): string {
  const ws = opts.ws ?? wavespeed;
  const d = db();

  if (activeGeneration()) {
    throw new RenderGateError(409, 'Уже идёт другой рендер — дождись его окончания');
  }
  const p = d.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId) as
    | {
        id: string;
        video_file: string | null;
        video_purged: number;
        meta_json: string | null;
        flags_json: string | null;
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
  d.prepare(
    `INSERT INTO generations (id, project_id, version, status, params_json, retry_of)
     VALUES (?, ?, ?, 'uploading_assets', ?, ?)`,
  ).run(genId, projectId, version, JSON.stringify(params), opts.retryOf ?? null);

  // Смета на момент запуска — снапшотом в строку (фиксирует ожидание против факта)
  void (async () => {
    try {
      const meta = JSON.parse(p.meta_json!) as VideoMeta;
      const est = await estimateRender(meta.durationSec, ws);
      db()
        .prepare(`UPDATE generations SET cost_est_json = ? WHERE id = ?`)
        .run(JSON.stringify({ wavespeedUsd: est.usd, billedSeconds: est.billedSeconds }), genId);
    } catch {
      /* смета вторична */
    }
  })();

  void runUploadAndSubmit(genId, ws, opts.pollBaseMs).catch((e) => {
    markFailed(genId, e instanceof Error ? e.message : String(e));
  });
  return genId;
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

async function runUploadAndSubmit(genId: string, ws: WaveSpeed, pollBaseMs?: number): Promise<void> {
  const d = db();
  const gen = loadGen(genId);
  if (!gen) return;
  const projectId = gen.project_id;
  const p = d
    .prepare(`SELECT video_file, flags_json FROM projects WHERE id = ?`)
    .get(projectId) as { video_file: string | null; flags_json: string | null } | undefined;
  if (!p?.video_file) throw new Error('Исходник недоступен');

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
  if (balanceBefore !== null) {
    try {
      const metaRow = d
        .prepare(`SELECT meta_json FROM projects WHERE id = ?`)
        .get(projectId) as { meta_json: string | null } | undefined;
      if (metaRow?.meta_json) {
        const est = await estimateRender((JSON.parse(metaRow.meta_json) as VideoMeta).durationSec, ws);
        if (est.usd !== null && est.usd > balanceBefore - 0.05) {
          markFailed(
            genId,
            `Не хватает баланса WaveSpeed: рендер ≈ $${est.usd.toFixed(2)}, на счету $${balanceBefore.toFixed(2)} — пополни и нажми «Повторить рендер»`,
          );
          return;
        }
      }
    } catch {
      /* смета вторична — не блокируем */
    }
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

    if (r.status === 'failed') {
      markFailed(genId, ruWsFailure(r.error));
      return;
    }
    if (r.status === 'completed') {
      try {
        await completeFromResult(gen, r, ws);
      } catch (e) {
        markFailed(
          genId,
          `Скачивание результата сорвалось: ${e instanceof Error ? e.message.slice(0, 200) : e} — нажми «Проверить ещё раз»`,
        );
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

    const cost = await captureCost(gen, r, ws);
    const nsfw = extractNsfw(r.raw);
    d.prepare(
      `UPDATE generations SET status = 'done', file = ?, bytes = ?, error = NULL,
          cost_actual_usd = ?, cost_source = ?, finished_at = datetime('now'),
          notes = CASE WHEN notes = '' AND ? != '' THEN ? ELSE notes END
        WHERE id = ?`,
    ).run(file, bytes, cost.usd, cost.source, nsfw, nsfw, gen.id);
    enforceStorageCap();
    console.log(
      `[render] done gen=${gen.id} bytes=${bytes} cost=$${cost.usd ?? '?'} source=${cost.source ?? '-'}`,
    );
  } catch (e) {
    // Не оставляем генерацию висеть в downloading (recheck на ней вернул бы ложный done):
    // финал сорвался → failed, задача у WaveSpeed жива — recheck доберёт
    markFailed(
      gen.id,
      `Скачивание результата сорвалось: ${e instanceof Error ? e.message.slice(0, 200) : e} — нажми «Проверить ещё раз»`,
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
  // 2) дельта баланса (надёжна: рендер-конкурентность = 1)
  if (typeof gen.balance_before_usd === 'number') {
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
      const e = await estimateRender(m.durationSec, ws);
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
    .prepare(`SELECT id FROM generations WHERE status IN ('submitted','rendering')`)
    .all() as Array<{ id: string }>;
  for (const row of rows) attachPoller(row.id, ws);
  if (failed || rows.length) {
    console.log(`[render] resume: поллеров=${rows.length}, прерванных аплоадов=${failed}`);
  }
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
    if (r.status === 'completed') {
      await completeFromResult(gen, r, ws); // деньги спасены: результат уже оплачен
      return gen.id;
    }
    if (r.status !== 'failed') {
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
  if (!gen.ws_prediction_id) throw new RenderGateError(409, 'У этой генерации нет id задачи WaveSpeed');
  const r = await ws.pollResult(gen.ws_prediction_id);
  if (r.status === 'completed') {
    await completeFromResult(gen, r, ws);
    return 'done';
  }
  if (r.status === 'failed') {
    markFailed(genId, ruWsFailure(r.error));
    return 'failed';
  }
  // всё ещё в работе на стороне WaveSpeed
  const other = activeGeneration();
  if (other && other.id !== genId) {
    throw new RenderGateError(409, 'Задача ещё рендерится у WaveSpeed, но сейчас идёт другой рендер — проверь позже');
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
