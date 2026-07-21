// Reality Finish — адаптивный camera/UGC-финиш ПОСЛЕ основного рендера.
// Готовый ролик замеряется ffmpeg-ом (яркость/контраст/насыщенность/резкость/шум/
// клиппинг/кожа), под замер и выбранный режим строится детерминированная цепочка
// фильтров, которая применяется строго 1:1 по кадрам: движение, длительность, fps,
// разрешение, кадрирование и аудио (потоковая копия) не меняются; никакой тряски.
// Превью считается на коротком фрагменте из середины и кэшируется на диске.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db';
import { probe } from '../ffmpeg';
import { finishDir, rendersDir } from '../storage';
import type {
  FinishMode,
  FinishPreviewInfo,
  FinishStats,
  VideoMeta,
} from '../../../shared/api-types';

export const FINISH_MODES: readonly FinishMode[] = ['natural', 'phone', 'camera'] as const;

const PREVIEW_SECONDS = 2.4;
const ANALYSIS_TARGET_FRAMES = 16;
const ANALYSIS_TIMEOUT_MS = 4 * 60_000;
const PREVIEW_TIMEOUT_MS = 5 * 60_000;
const APPLY_TIMEOUT_MS = 25 * 60_000;
/** Доля «кожных» пикселей, после которой цвет кожи защищается от перекраски. */
const SKIN_GUARD = 0.12;

/** Ошибка с HTTP-статусом для роутов (как RenderGateError, без тяжёлых импортов). */
export class FinishGateError extends Error {
  httpStatus: number;
  constructor(httpStatus: number, message: string) {
    super(message);
    this.name = 'FinishGateError';
    this.httpStatus = httpStatus;
  }
}

// ── Состояние в generations.finish_json ─────────────────────────────────────

interface FinishJobState {
  status: 'processing' | 'done' | 'failed';
  mode: FinishMode;
  intensity: number;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  /** Фактическая цепочка фильтров — диагностика владельца. */
  filters?: string;
}

interface FinishAnalysis {
  stats: FinishStats;
  durationSec: number;
  at: string;
}

interface FinishJson {
  analysis?: FinishAnalysis;
  job?: FinishJobState;
}

function readFinishJson(genId: string): FinishJson {
  const row = getDb()
    .prepare(`SELECT finish_json FROM generations WHERE id = ?`)
    .get(genId) as { finish_json: string | null } | undefined;
  if (!row?.finish_json) return {};
  try {
    return JSON.parse(row.finish_json) as FinishJson;
  } catch {
    return {};
  }
}

/** Sync read-modify-write; строки нет — no-op (генерацию могли удалить мид-обработки). */
function patchFinishJson(genId: string, patch: (cur: FinishJson) => FinishJson): void {
  const d = getDb();
  const row = d.prepare(`SELECT finish_json FROM generations WHERE id = ?`).get(genId) as
    | { finish_json: string | null }
    | undefined;
  if (!row) return;
  let cur: FinishJson = {};
  try {
    cur = row.finish_json ? (JSON.parse(row.finish_json) as FinishJson) : {};
  } catch {
    /* повреждённый JSON заменяется */
  }
  d.prepare(`UPDATE generations SET finish_json = ? WHERE id = ?`).run(
    JSON.stringify(patch(cur)),
    genId,
  );
}

// ── Инструменты (сшиваемые в тестах) ────────────────────────────────────────

function execFfmpeg(args: string[], cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { cwd, windowsHide: true });
    let err = '';
    const to = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error(`ffmpeg: таймаут ${Math.round(timeoutMs / 1000)}с`));
    }, timeoutMs);
    p.stderr.on('data', (d) => {
      err += d;
      if (err.length > 65_536) err = err.slice(-32_768);
    });
    p.on('error', (e) => {
      clearTimeout(to);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(to);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg завершился с кодом ${code}: ${err.slice(-500)}`));
    });
  });
}

async function ffprobeHasAudio(file: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const p = spawn(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file],
      { windowsHide: true },
    );
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve(out.trim().length > 0);
      else reject(new Error(`ffprobe завершился с кодом ${code}: ${err.slice(-300)}`));
    });
  });
}

export interface FinishTools {
  exec: (args: string[], cwd: string, timeoutMs: number) => Promise<void>;
  probeVideo: (file: string) => Promise<VideoMeta>;
  hasAudio: (file: string) => Promise<boolean>;
  measure: (file: string, durationSec: number, scratchDir: string) => Promise<FinishStats>;
}

const realTools: FinishTools = {
  exec: execFfmpeg,
  probeVideo: probe,
  hasAudio: ffprobeHasAudio,
  measure: measureVideoStats,
};
let tools: FinishTools = { ...realTools };

/** Тестовый шов: подменить ffmpeg/ffprobe/замер; null — вернуть реальные. */
export function _setFinishToolsForTests(overrides: Partial<FinishTools> | null): void {
  tools = overrides ? { ...realTools, ...overrides } : { ...realTools };
}

// ── Замер ролика ────────────────────────────────────────────────────────────

/** Среднее значение metadata-ключа по всем кадрам печати signalstats. */
export function meanOfStatKey(text: string, key: string): number | null {
  const re = new RegExp(`lavfi\\.signalstats\\.${key}=([0-9.eE+-]+)`, 'g');
  let sum = 0;
  let n = 0;
  for (const m of text.matchAll(re)) {
    const v = Number(m[1]);
    if (Number.isFinite(v)) {
      sum += v;
      n++;
    }
  }
  return n > 0 ? sum / n : null;
}

const r4 = (v: number) => Math.round(v * 10_000) / 10_000;

/**
 * Один декод — шесть статистических веток:
 * базовая signalstats (яркость/контраст/насыщенность), маски пережжённых светов и
 * проваленных теней, Собель (резкость), residual после блюра (шум/текстура),
 * YCbCr-маска кожи. Каждая ветка печатает metadata в свой файл в scratchDir.
 */
async function measureVideoStats(
  file: string,
  durationSec: number,
  scratchDir: string,
): Promise<FinishStats> {
  const fps = Math.min(8, Math.max(0.2, ANALYSIS_TARGET_FRAMES / Math.max(durationSec, 0.1)));
  const graph = [
    `[0:v]fps=${fps.toFixed(4)},format=yuv420p,split=5[b0][b1][b2][b3][b4]`,
    `[b0]signalstats,metadata=print:file=basic.txt[o0]`,
    `[b1]lutyuv=y='if(gte(val,234),255,0)':u=128:v=128,signalstats,metadata=print:file=hi.txt[o1]`,
    `[b2]lutyuv=y='if(lte(val,18),255,0)':u=128:v=128,signalstats,metadata=print:file=lo.txt[o2]`,
    `[b3]format=gray,split[s1][n1]`,
    `[s1]sobel,signalstats,metadata=print:file=sharp.txt[o3]`,
    `[n1]split[n2][n3]`,
    `[n2]gblur=sigma=1.2[nb]`,
    `[n3][nb]blend=all_mode=difference,signalstats,metadata=print:file=noise.txt[o4]`,
    `[b4]scale=iw/2:ih/2,format=yuv444p,geq=lum='255*between(cb(X,Y),77,127)*between(cr(X,Y),133,173)':cb=128:cr=128,signalstats,metadata=print:file=skin.txt[o5]`,
  ].join(';');
  await tools.exec(
    [
      '-y', '-i', file,
      '-filter_complex', graph,
      '-map', '[o0]', '-map', '[o1]', '-map', '[o2]', '-map', '[o3]', '-map', '[o4]', '-map', '[o5]',
      '-f', 'null', '-',
    ],
    scratchDir,
    ANALYSIS_TIMEOUT_MS,
  );
  const read = (name: string) => {
    try {
      return fs.readFileSync(path.join(scratchDir, name), 'utf8');
    } catch {
      return '';
    }
  };
  const basic = read('basic.txt');
  const sampledFrames = (basic.match(/^frame:/gm) ?? []).length;
  if (sampledFrames === 0) {
    throw new Error('Не удалось замерить ролик — ffmpeg не вернул статистику кадров');
  }
  const yavg = meanOfStatKey(basic, 'YAVG') ?? 128;
  const ylow = meanOfStatKey(basic, 'YLOW') ?? 32;
  const yhigh = meanOfStatKey(basic, 'YHIGH') ?? 224;
  const satavg = meanOfStatKey(basic, 'SATAVG') ?? 30;
  return {
    brightness: r4(yavg / 255),
    contrast: r4(Math.max(0, yhigh - ylow) / 255),
    saturation: r4(satavg / 112),
    sharpness: r4((meanOfStatKey(read('sharp.txt'), 'YAVG') ?? 0) / 255),
    noise: r4((meanOfStatKey(read('noise.txt'), 'YAVG') ?? 0) / 255),
    clippedHighlights: r4((meanOfStatKey(read('hi.txt'), 'YAVG') ?? 0) / 255),
    crushedShadows: r4((meanOfStatKey(read('lo.txt'), 'YAVG') ?? 0) / 255),
    skin: r4((meanOfStatKey(read('skin.txt'), 'YAVG') ?? 0) / 255),
    sampledFrames,
  };
}

/**
 * Замер кэшируется в finish_json (файл done-рендера иммутабелен → замер вечен).
 * Параллельные вызовы по одной генерации (превью двух режимов, превью+apply)
 * дедуплятся in-flight промисом: один декод, никаких коллизий scratch-каталога.
 */
const inflightAnalysis = new Map<string, Promise<FinishAnalysis>>();

async function ensureFinishAnalysis(
  projectId: string,
  genId: string,
  renderFile: string,
): Promise<FinishAnalysis> {
  const cached = readFinishJson(genId).analysis;
  if (cached?.stats && cached.stats.sampledFrames > 0) return cached;
  const running = inflightAnalysis.get(genId);
  if (running) return running;
  const job = (async () => {
    const meta = await tools.probeVideo(renderFile);
    const scratch = path.join(finishDir(projectId), `.an-${genId}-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(scratch, { recursive: true });
    try {
      const stats = await tools.measure(renderFile, meta.durationSec, scratch);
      const analysis: FinishAnalysis = {
        stats,
        durationSec: meta.durationSec,
        at: new Date().toISOString(),
      };
      patchFinishJson(genId, (cur) => ({ ...cur, analysis }));
      return analysis;
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  })();
  inflightAnalysis.set(genId, job);
  try {
    return await job;
  } finally {
    inflightAnalysis.delete(genId);
  }
}

// ── Расчёт плана обработки (чистая функция) ─────────────────────────────────

export interface FinishPlanParams {
  /** ffmpeg noise strength (0–100) по плоскостям. */
  grain: { luma: number; chroma: number };
  /** unsharp luma_amount (0 = не точим). */
  sharpen: number;
  /** gblur sigma (0 = не смягчаем). */
  blurSigma: number;
  eq: { contrast: number; brightness: number; saturation: number };
  /** colorbalance: rm=+w, bm=−w (тепло в средних тонах). */
  warmth: number;
  /** curves master points или null. */
  curves: string | null;
  crf: number;
}

export interface FinishPlan {
  params: FinishPlanParams;
  /** Готовое значение для -vf. */
  filters: string;
  /** RU-заметки: какие адаптации сработали под замер этого ролика. */
  notes: string[];
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const clamp01 = (v: number) => clamp(v, 0, 1);
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function bucketIntensity(raw: number): number {
  const v = Number.isFinite(raw) ? raw : 0.7;
  return clamp(Math.round(v * 10) / 10, 0.1, 1);
}

/**
 * Детерминированный план фильтров под режим и интенсивность с адаптацией под замер:
 * — зерно гасится, если высокочастотный шум уже есть;
 * — насыщенность тянется к целевой, а не «плюс всегда» (сочный ролик не перекрашиваем);
 * — при проваленных тенях яркость не опускается (наоборот, чуть приподнимается);
 * — резкость не добавляется уже резкому видео;
 * — при заметной доле кожи капается прибавка насыщенности и тепла.
 */
export function computeFinishPlan(stats: FinishStats, mode: FinishMode, intensityRaw: number): FinishPlan {
  const k = bucketIntensity(intensityRaw);
  const notes: string[] = [];

  const noiseDamp = clamp01(1 - stats.noise / 0.035);
  const grainScale = 0.15 + 0.85 * noiseDamp;
  if (noiseDamp < 0.55) notes.push('зерно ослаблено — в ролике уже есть шум/текстура');

  const satDelta = (target: number, gain: number, min: number, max: number, skinCap: number): number => {
    let d = clamp((target - stats.saturation) * gain, min, max);
    if (d < -0.005) notes.push('насыщенность слегка приглушена — ролик уже сочный');
    if (stats.skin > SKIN_GUARD && d > skinCap) {
      d = skinCap;
      notes.push('прибавка цвета ограничена — бережём тон кожи');
    }
    return d * k;
  };

  const brightnessNudge = (lift: number, drop: number): number => {
    if (stats.crushedShadows > 0.02) {
      notes.push('тени уже проваленные — не затемняем, чуть приподнимаем');
      return r3(Math.min(lift, 0.012) * k);
    }
    if (stats.brightness > 0.62 && stats.clippedHighlights < 0.05) return r3(-drop * k);
    if (stats.brightness < 0.32) return r3(lift * k);
    return 0;
  };

  const contrastToward = (base: number): number => {
    let target = base;
    if (stats.contrast > 0.65) {
      target = Math.min(base, 1.01);
      notes.push('контраст почти не трогаем — он уже высокий');
    } else if (stats.crushedShadows > 0.02) {
      target = Math.min(base, 1.02);
    } else if (stats.contrast < 0.4) {
      target = base + 0.01;
    }
    return r3(1 + (target - 1) * k);
  };

  const sharpenAmount = (base: number, keepFloor: number): number => {
    const damp = clamp01(1 - (stats.sharpness - 0.05) / 0.1);
    if (damp < 0.35 && base > 0) notes.push('резкость почти не добавляем — видео уже резкое');
    return r2(base * k * Math.max(keepFloor, damp));
  };

  const curvesPoints = (lift: number, rolloff: number): string | null => {
    if (lift <= 0.001 && rolloff <= 0.001) return null;
    const l = r3(clamp(lift, 0, 0.05));
    const h1 = r3(0.85 - 0.05 * clamp01(rolloff));
    const h2 = r3(1 - 0.08 * clamp01(rolloff));
    return `0/${l} 0.5/0.5 0.85/${h1} 1/${h2}`;
  };

  const params: FinishPlanParams = {
    grain: { luma: 0, chroma: 0 },
    sharpen: 0,
    blurSigma: 0,
    eq: { contrast: 1, brightness: 0, saturation: 1 },
    warmth: 0,
    curves: null,
    crf: 18,
  };

  if (mode === 'natural') {
    params.grain = { luma: r2(6 * k * grainScale), chroma: r2(1.5 * k * grainScale) };
    params.sharpen = sharpenAmount(0.3, 0.1);
    params.eq = {
      contrast: contrastToward(1.02),
      brightness: brightnessNudge(0.015, 0.015),
      saturation: r3(1 + satDelta(0.32, 0.6, -0.06, 0.05, 0.03)),
    };
    if (stats.clippedHighlights > 0.04) {
      params.curves = curvesPoints(0, 0.5 * k);
      notes.push('света мягко скруглены — есть пережжённые участки');
    }
  } else if (mode === 'phone') {
    params.grain = { luma: r2(10 * k * grainScale), chroma: r2(4 * k * grainScale) };
    params.sharpen = sharpenAmount(0.9, 0.4);
    params.eq = {
      contrast: contrastToward(1.05),
      brightness: brightnessNudge(0.015, 0.012),
      saturation: r3(1 + satDelta(0.38, 0.8, -0.05, 0.1, 0.05)),
    };
    if (stats.clippedHighlights > 0.03) {
      params.curves = curvesPoints(0, 0.6 * k);
      notes.push('света мягко скруглены — есть пережжённые участки');
    }
    params.crf = 19 + Math.round(5 * k);
  } else {
    params.grain = { luma: r2(12 * k * grainScale), chroma: r2(2.5 * k * grainScale) };
    const soft = clamp01((stats.sharpness - 0.035) / 0.05);
    const sigma = r2(0.35 * k * soft);
    params.blurSigma = sigma >= 0.05 ? sigma : 0;
    if (params.blurSigma === 0 && stats.sharpness <= 0.035) {
      notes.push('цифровую резкость не смягчаем — видео и так мягкое');
    }
    params.eq = {
      contrast: contrastToward(1.03),
      brightness: brightnessNudge(0.015, 0.012),
      saturation: r3(1 + satDelta(0.36, 0.7, -0.06, 0.08, 0.04)),
    };
    const lift = stats.crushedShadows > 0.02 ? 0.035 * k : 0.025 * k;
    const rolloff = (stats.clippedHighlights > 0.03 ? 0.85 : 0.6) * k;
    params.curves = curvesPoints(lift, rolloff);
    let warmth = 0.05 * k;
    if (stats.skin > SKIN_GUARD) {
      warmth /= 2;
      notes.push('тепло цвета ополовинено — бережём тон кожи');
    }
    params.warmth = r3(warmth);
  }

  const chain: string[] = [];
  const { eq } = params;
  if (Math.abs(eq.contrast - 1) > 0.001 || Math.abs(eq.brightness) > 0.001 || Math.abs(eq.saturation - 1) > 0.001) {
    chain.push(`eq=contrast=${r3(eq.contrast)}:brightness=${r3(eq.brightness)}:saturation=${r3(eq.saturation)}`);
  }
  if (params.curves) chain.push(`curves=master='${params.curves}'`);
  if (params.warmth > 0.001) chain.push(`colorbalance=rm=${params.warmth}:bm=${-params.warmth}`);
  if (params.blurSigma >= 0.05) chain.push(`gblur=sigma=${params.blurSigma}`);
  if (params.sharpen >= 0.03) chain.push(`unsharp=lx=5:ly=5:la=${params.sharpen}`);
  if (params.grain.luma >= 0.3) {
    const c = params.grain.chroma >= 0.3 ? params.grain.chroma : 0;
    chain.push(`noise=c0s=${params.grain.luma}:c0f=t+u:c1s=${c}:c1f=t+u:c2s=${c}:c2f=t+u`);
  }
  return {
    params,
    filters: chain.length > 0 ? chain.join(',') : 'null',
    notes: [...new Set(notes)],
  };
}

// ── Превью на фрагменте ─────────────────────────────────────────────────────

function previewNames(genId: string, mode: FinishMode, k: number): { before: string; after: string } {
  return {
    before: `fp_${genId}_orig.mp4`,
    after: `fp_${genId}_${mode}_${Math.round(k * 100)}.mp4`,
  };
}

export function previewCached(projectId: string, genId: string, mode: FinishMode, intensityRaw: number): boolean {
  const k = bucketIntensity(intensityRaw);
  const names = previewNames(genId, mode, k);
  const dir = finishDir(projectId);
  return (
    fs.existsSync(path.join(dir, names.before)) &&
    fs.existsSync(path.join(dir, names.after)) &&
    !!readFinishJson(genId).analysis
  );
}

/** Такое же превью уже строится — второй запрос присоединится, юнит лимита не тратим. */
export function previewInflight(genId: string, mode: FinishMode, intensityRaw: number): boolean {
  return inflightPreviews.has(`${genId}:${mode}:${bucketIntensity(intensityRaw)}`);
}

function fragmentWindow(durationSec: number): { start: number; len: number } {
  const len = Math.min(PREVIEW_SECONDS, Math.max(0.5, durationSec));
  const start = Math.max(0, durationSec / 2 - len / 2);
  return { start: Math.round(start * 1000) / 1000, len: Math.round(len * 1000) / 1000 };
}

function previewEncodeArgs(
  renderFile: string,
  start: number,
  len: number,
  filters: string,
  crf: number,
  outFile: string,
): string[] {
  return [
    '-y',
    '-ss', start.toFixed(3), '-t', len.toFixed(3), '-i', renderFile,
    '-vf', filters,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart',
    outFile,
  ];
}

/** Простой лимитер параллельности (превью — максимум 2 ffmpeg одновременно). */
function makeLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((res) => queue.push(res));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}
const previewLimit = makeLimiter(2);
const inflightPreviews = new Map<string, Promise<FinishPreviewInfo>>();

export async function buildFinishPreview(
  projectId: string,
  genId: string,
  renderFileName: string,
  mode: FinishMode,
  intensityRaw: number,
): Promise<FinishPreviewInfo> {
  const k = bucketIntensity(intensityRaw);
  const inflightKey = `${genId}:${mode}:${k}`;
  const running = inflightPreviews.get(inflightKey);
  if (running) return running;
  const job = previewLimit(async () => {
    const renderFile = path.join(rendersDir(projectId), renderFileName);
    if (!fs.existsSync(renderFile)) {
      throw new FinishGateError(409, 'Файл рендера недоступен — возможно, очищен ротацией');
    }
    const analysis = await ensureFinishAnalysis(projectId, genId, renderFile);
    const plan = computeFinishPlan(analysis.stats, mode, k);
    const { start, len } = fragmentWindow(analysis.durationSec);
    const dir = finishDir(projectId);
    fs.mkdirSync(dir, { recursive: true });
    const names = previewNames(genId, mode, k);
    // Атомарная публикация: энкод в уникальный tmp + rename. Иначе два параллельных
    // превью разных режимов после TTL-свипа писали бы общий before-файл одновременно
    // и оставляли битый mp4, который existsSync дальше считал бы валидным кэшем.
    const encodeTo = async (target: string, filters: string, crf: number) => {
      if (fs.existsSync(target)) return;
      const tmp = `${target}.tmp-${randomUUID().slice(0, 8)}.mp4`;
      try {
        await tools.exec(previewEncodeArgs(renderFile, start, len, filters, crf, tmp), dir, PREVIEW_TIMEOUT_MS);
        fs.renameSync(tmp, target);
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        throw e;
      }
    };
    await encodeTo(path.join(dir, names.before), 'null', 18);
    await encodeTo(path.join(dir, names.after), plan.filters, plan.params.crf);
    return {
      mode,
      intensity: k,
      before: names.before,
      after: names.after,
      stats: analysis.stats,
      notes: plan.notes,
      fragmentStartSec: start,
      fragmentDurationSec: len,
    };
  });
  inflightPreviews.set(inflightKey, job);
  try {
    return await job;
  } finally {
    inflightPreviews.delete(inflightKey);
  }
}

// ── Применение ко всему ролику ──────────────────────────────────────────────

const applying = new Set<string>();
let applyChain: Promise<void> = Promise.resolve();

export function finishBusy(genId: string): boolean {
  if (applying.has(genId)) return true;
  return readFinishJson(genId).job?.status === 'processing';
}

/** У проекта есть идущая обработка — удаление проекта из-под ffmpeg запрещаем. */
export function projectHasActiveFinish(projectId: string): boolean {
  const rows = getDb()
    .prepare(
      `SELECT id FROM generations WHERE project_id = ? AND finish_json LIKE '%"status":"processing"%'`,
    )
    .all(projectId) as Array<{ id: string }>;
  return rows.some((row) => finishBusy(row.id));
}

/**
 * Сколько обработок пользователя сейчас в серийной очереди/работе. Очередь одна на
 * всех — без пер-юзерного капа один тенант мог бы заставить остальных ждать часами.
 */
export function activeFinishCountForUser(userId: string): number {
  const rows = getDb()
    .prepare(
      `SELECT id FROM generations WHERE user_id = ? AND finish_json LIKE '%"status":"processing"%'`,
    )
    .all(userId) as Array<{ id: string }>;
  return rows.filter((row) => finishBusy(row.id)).length;
}

/** Обработка идёт последовательно (общий CPU); ждать завершения — в тестах. */
export function _waitFinishIdleForTests(): Promise<void> {
  return applyChain;
}

export function finishedFileName(genId: string): string {
  return `gen_${genId}_finish.mp4`;
}

/**
 * Ставит обработку всего ролика в серийную очередь и сразу возвращает управление.
 * Прогресс виден через generations.finish_json (DTO GenerationRow.finish).
 */
export function startFinishApply(
  projectId: string,
  genId: string,
  renderFileName: string,
  mode: FinishMode,
  intensityRaw: number,
): void {
  const k = bucketIntensity(intensityRaw);
  if (finishBusy(genId)) throw new FinishGateError(409, 'Обработка этого ролика уже идёт — дождись');
  applying.add(genId);
  const d = getDb();
  // Прежний результат замещается: файл удаляем сразу, чтобы done-состояние не
  // указывало на файл другого режима, пока новый рендерится.
  const prev = d.prepare(`SELECT finish_file FROM generations WHERE id = ?`).get(genId) as
    | { finish_file: string | null }
    | undefined;
  if (prev?.finish_file) {
    fs.rmSync(path.join(rendersDir(projectId), prev.finish_file), { force: true });
  }
  d.prepare(`UPDATE generations SET finish_file = NULL WHERE id = ?`).run(genId);
  patchFinishJson(genId, (cur) => ({
    ...cur,
    job: { status: 'processing', mode, intensity: k, startedAt: new Date().toISOString() },
  }));
  applyChain = applyChain
    .then(() => runFinishApply(projectId, genId, renderFileName, mode, k))
    .catch((e) => {
      markFinishFailed(projectId, genId, e instanceof Error ? e.message : String(e));
    })
    .finally(() => {
      applying.delete(genId);
    });
}

function markFinishFailed(projectId: string, genId: string, msg: string): void {
  console.error(`[finish] gen=${genId}: ${msg}`);
  fs.rmSync(path.join(finishDir(projectId), `tmp_${genId}.mp4`), { force: true });
  patchFinishJson(genId, (cur) =>
    cur.job
      ? {
          ...cur,
          job: {
            ...cur.job,
            status: 'failed',
            error: msg.slice(0, 300),
            finishedAt: new Date().toISOString(),
          },
        }
      : cur,
  );
}

/** Контракт «обработка ничего не меняет, кроме внешнего вида» — проверяется, а не предполагается. */
async function validateFinishOutput(src: VideoMeta, outFile: string, srcFile: string): Promise<void> {
  const out = await tools.probeVideo(outFile);
  if (out.width !== src.width || out.height !== src.height) {
    throw new Error(`Обработка изменила разрешение (${out.width}x${out.height} вместо ${src.width}x${src.height})`);
  }
  if (Math.abs(out.durationSec - src.durationSec) > 0.25) {
    throw new Error(
      `Обработка изменила длительность (${out.durationSec.toFixed(2)}с вместо ${src.durationSec.toFixed(2)}с)`,
    );
  }
  if (src.fps > 0 && out.fps > 0 && Math.abs(out.fps - src.fps) > 0.11) {
    throw new Error(`Обработка изменила частоту кадров (${out.fps} вместо ${src.fps})`);
  }
  const [srcAudio, outAudio] = await Promise.all([tools.hasAudio(srcFile), tools.hasAudio(outFile)]);
  if (srcAudio !== outAudio) {
    throw new Error('Обработка затронула аудиодорожку — результат отклонён');
  }
}

async function runFinishApply(
  projectId: string,
  genId: string,
  renderFileName: string,
  mode: FinishMode,
  k: number,
): Promise<void> {
  const job = readFinishJson(genId).job;
  if (!job || job.status !== 'processing') return; // удалили/отменили, пока ждали очередь
  const renderFile = path.join(rendersDir(projectId), renderFileName);
  if (!fs.existsSync(renderFile)) throw new Error('Исходный рендер исчез — обработать нечего');
  const analysis = await ensureFinishAnalysis(projectId, genId, renderFile);
  const plan = computeFinishPlan(analysis.stats, mode, k);
  const dir = finishDir(projectId);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `tmp_${genId}.mp4`);
  fs.rmSync(tmp, { force: true });
  try {
    await tools.exec(
      [
        '-y', '-i', renderFile,
        '-vf', plan.filters,
        '-map', '0:v:0', '-map', '0:a:0?',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', String(plan.params.crf), '-pix_fmt', 'yuv420p',
        '-fps_mode', 'passthrough',
        '-c:a', 'copy', '-movflags', '+faststart',
        tmp,
      ],
      dir,
      APPLY_TIMEOUT_MS,
    );
    const srcMeta = await tools.probeVideo(renderFile);
    await validateFinishOutput(srcMeta, tmp, renderFile);
    const fileName = finishedFileName(genId);
    fs.renameSync(tmp, path.join(rendersDir(projectId), fileName));
    const flipped = getDb()
      .prepare(`UPDATE generations SET finish_file = ? WHERE id = ?`)
      .run(fileName, genId);
    if (Number(flipped.changes) === 0) {
      // Генерацию удалили мид-обработки — файл-сирота не должен пережить уборку.
      fs.rmSync(path.join(rendersDir(projectId), fileName), { force: true });
      return;
    }
    patchFinishJson(genId, (cur) => ({
      ...cur,
      job: {
        status: 'done',
        mode,
        intensity: k,
        startedAt: cur.job?.startedAt,
        finishedAt: new Date().toISOString(),
        filters: plan.filters,
      },
    }));
    console.log(`[finish] done gen=${genId} mode=${mode} k=${k} filters=${plan.filters}`);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** Убрать обработку: файл удаляется, замер остаётся (кэш пригоден для нового захода). */
export function removeFinish(projectId: string, genId: string): void {
  if (finishBusy(genId)) throw new FinishGateError(409, 'Обработка ещё идёт — дождись завершения');
  const d = getDb();
  const row = d.prepare(`SELECT finish_file FROM generations WHERE id = ?`).get(genId) as
    | { finish_file: string | null }
    | undefined;
  if (row?.finish_file) fs.rmSync(path.join(rendersDir(projectId), row.finish_file), { force: true });
  d.prepare(`UPDATE generations SET finish_file = NULL WHERE id = ?`).run(genId);
  patchFinishJson(genId, (cur) => ({ analysis: cur.analysis }));
}

/** Boot recovery: процесс — единственный обработчик, повисшие processing честно валим. */
export function resumeFinishJobs(): number {
  const d = getDb();
  const rows = d
    .prepare(`SELECT id FROM generations WHERE finish_json LIKE '%"status":"processing"%'`)
    .all() as Array<{ id: string }>;
  let failed = 0;
  for (const row of rows) {
    const job = readFinishJson(row.id).job;
    if (job?.status !== 'processing') continue;
    patchFinishJson(row.id, (cur) =>
      cur.job
        ? {
            ...cur,
            job: {
              ...cur.job,
              status: 'failed',
              error: 'Обработка прервана перезапуском сервиса — запусти Reality Finish ещё раз',
              finishedAt: new Date().toISOString(),
            },
          }
        : cur,
    );
    failed++;
  }
  if (failed) console.log(`[finish] resume: прерванных обработок помечено failed: ${failed}`);
  return failed;
}
