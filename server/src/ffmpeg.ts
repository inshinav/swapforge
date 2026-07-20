import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import type { VideoMeta, FrameInfo } from '../../shared/api-types';

function run(
  cmd: string,
  args: string[],
  timeoutMs = 180_000,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '';
    let err = '';
    const to = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error(`${cmd}: таймаут ${timeoutMs / 1000}с`));
    }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => {
      clearTimeout(to);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(to);
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new Error(`${cmd} завершился с кодом ${code}: ${err.slice(-600)}`));
    });
  });
}

export async function ffmpegAvailable(): Promise<boolean> {
  try {
    await run('ffmpeg', ['-version'], 8000);
    return true;
  } catch {
    return false;
  }
}

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}

/** 1080x1920 → "9:16"; экзотика прижимается к ближайшему стандартному AR при ошибке <3%. */
export function reduceAspect(w: number, h: number): string {
  if (!w || !h) return '9:16';
  const g = gcd(w, h);
  const std: [number, number][] = [
    [9, 16], [16, 9], [1, 1], [4, 5], [5, 4], [3, 4], [4, 3], [2, 3], [3, 2], [21, 9],
  ];
  let best: [number, number] = [w / g, h / g];
  let bestErr = Infinity;
  for (const [sw, sh] of std) {
    const err = Math.abs(w / h - sw / sh) / (w / h);
    if (err < bestErr) {
      bestErr = err;
      best = [sw, sh];
    }
  }
  return bestErr < 0.03 ? `${best[0]}:${best[1]}` : `${w / g}:${h / g}`;
}

interface ProbeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  duration?: string;
  r_frame_rate?: string;
  side_data_list?: Array<{ rotation?: number }>;
  tags?: { rotate?: string };
}

/** iPhone и камеры пишут портрет как 1920x1080 + rotation-мета — учитываем её. */
export function rotationOf(v: ProbeStream): number {
  const side = v.side_data_list?.find((s) => typeof s.rotation === 'number')?.rotation;
  const tag = v.tags?.rotate !== undefined ? Number(v.tags.rotate) : undefined;
  const rot = side ?? tag ?? 0;
  return Number.isFinite(rot) ? ((Math.round(rot) % 360) + 360) % 360 : 0;
}

export async function probe(file: string): Promise<VideoMeta> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format', '-show_streams',
    file,
  ]);
  const j = JSON.parse(stdout) as {
    format?: { duration?: string; size?: string };
    streams?: ProbeStream[];
  };
  const v = (j.streams ?? []).find((s) => s.codec_type === 'video');
  if (!v || !v.width || !v.height) throw new Error('В файле нет видеопотока — это точно ролик?');
  const durationSec = Number(j.format?.duration ?? v.duration ?? 0);
  const [num = 0, den = 1] = String(v.r_frame_rate ?? '0/1').split('/').map(Number);
  const fps = den ? Math.round((num / den) * 100) / 100 : 0;
  const swap = rotationOf(v) % 180 === 90;
  const width = swap ? v.height : v.width;
  const height = swap ? v.width : v.height;
  return {
    durationSec: Math.round(durationSec * 100) / 100,
    width,
    height,
    fps,
    aspect: reduceAspect(width, height),
    sizeBytes: Number(j.format?.size ?? fs.statSync(file).size),
  };
}

const SCALE_ANALYSIS = "scale=w='min(1024,iw)':h='min(1024,ih)':force_original_aspect_ratio=decrease";
const SCALE_FIRST = "scale=w='min(1536,iw)':h='min(1536,ih)':force_original_aspect_ratio=decrease";
const SCENE_THRESHOLD = 0.3;
const GRID_FPS = 2;
const MAX_SCENE_FRAMES = 12;

/**
 * Раскадровка: первый кадр (hi-res) + кадры на границах сцен + равномерная сетка 2 fps.
 * Дедуп сетки возле сценовых кадров, общий кап maxFrames (first + scene неприкосновенны).
 */
export async function storyboard(
  videoFile: string,
  framesDir: string,
  durationSec: number,
  maxFrames: number,
): Promise<FrameInfo[]> {
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });

  // 1) Первый кадр в высоком разрешении — основа старт-кадра
  await run('ffmpeg', ['-y', '-i', videoFile, '-vf', SCALE_FIRST, '-frames:v', '1', '-q:v', '2',
    path.join(framesDir, 'first.jpg')]);

  // 2) Кадры смен сцен + таймстемпы из showinfo
  const sceneTimes: number[] = [];
  try {
    const sceneOut = await run('ffmpeg', [
      '-y', '-i', videoFile,
      '-vf', `select='gt(scene,${SCENE_THRESHOLD})',showinfo,${SCALE_ANALYSIS}`,
      '-fps_mode', 'vfr', '-q:v', '3',
      path.join(framesDir, 'scene_%03d.jpg'),
    ]);
    for (const m of sceneOut.stderr.matchAll(/pts_time:([0-9.]+)/g)) {
      sceneTimes.push(Number(m[1]));
    }
  } catch {
    // Scene detection is best-effort. The first frame + time grid below are sufficient
    // for analysis when a clip has no cuts or this optional filter cannot emit a frame.
    for (const file of fs.readdirSync(framesDir)) {
      if (file.startsWith('scene_')) fs.rmSync(path.join(framesDir, file), { force: true });
    }
  }
  let scenes: FrameInfo[] = sceneTimes.map((t, i) => ({
    file: `scene_${String(i + 1).padStart(3, '0')}.jpg`,
    t: Math.round(t * 100) / 100,
    kind: 'scene' as const,
  }));
  if (scenes.length > MAX_SCENE_FRAMES) {
    const dropped = scenes.slice(MAX_SCENE_FRAMES);
    scenes = scenes.slice(0, MAX_SCENE_FRAMES);
    for (const d of dropped) fs.rmSync(path.join(framesDir, d.file), { force: true });
  }

  // 3) Равномерная сетка
  await run('ffmpeg', [
    '-y', '-i', videoFile,
    '-vf', `fps=${GRID_FPS},${SCALE_ANALYSIS}`,
    '-q:v', '3',
    path.join(framesDir, 'grid_%04d.jpg'),
  ]);
  const gridFiles = fs
    .readdirSync(framesDir)
    .filter((f) => f.startsWith('grid_'))
    .sort();
  let grid: FrameInfo[] = gridFiles.map((file, i) => ({
    file,
    t: Math.round((i / GRID_FPS) * 100) / 100,
    kind: 'grid' as const,
  }));

  // Дедуп: сетка рядом со сценовым кадром (±0.35с) или с первым кадром не нужна
  const anchors = [0, ...scenes.map((s) => s.t)];
  const removed = new Set<string>();
  grid = grid.filter((g) => {
    const near = anchors.some((a) => Math.abs(a - g.t) < 0.35);
    if (near) removed.add(g.file);
    return !near;
  });

  // Кап: first + scenes неприкосновенны, сетку прореживаем равномерно
  const budget = Math.max(4, maxFrames - 1 - scenes.length);
  if (grid.length > budget) {
    const kept: FrameInfo[] = [];
    for (let i = 0; i < budget; i++) {
      const idx = Math.round((i * (grid.length - 1)) / Math.max(1, budget - 1));
      const item = grid[idx];
      if (item && !kept.includes(item)) kept.push(item);
    }
    for (const g of grid) if (!kept.includes(g)) removed.add(g.file);
    grid = kept;
  }
  for (const f of removed) fs.rmSync(path.join(framesDir, f), { force: true });

  const frames: FrameInfo[] = [
    { file: 'first.jpg', t: 0, kind: 'first' as const },
    ...scenes,
    ...grid,
  ].sort((a, b) => a.t - b.t || (a.kind === 'first' ? -1 : 1));

  if (durationSec > 0 && frames.length < 2) {
    throw new Error('Не удалось извлечь кадры — файл повреждён или формат не поддерживается');
  }
  return frames;
}

/** Точный source-frame для начала следующего сегмента (не зависит от keyframe исходника). */
export async function extractFrameAt(videoFile: string, atSec: number, outputFile: string): Promise<void> {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  await run('ffmpeg', [
    '-y', '-ss', Math.max(0, atSec).toFixed(3), '-i', videoFile,
    '-vf', SCALE_FIRST, '-frames:v', '1', '-q:v', '2', outputFile,
  ]);
}

/** Кадрово-точная нарезка; re-encode нужен, чтобы каждый кусок действительно начинался с anchor. */
export async function cutVideoSegment(
  videoFile: string,
  outputFile: string,
  startSec: number,
  endSec: number,
): Promise<void> {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  await run(
    'ffmpeg',
    [
      '-y', '-ss', Math.max(0, startSec).toFixed(3), '-i', videoFile,
      '-t', Math.max(0.1, endSec - startSec).toFixed(3),
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outputFile,
    ],
    10 * 60_000,
  );
}

async function mediaShape(file: string): Promise<{ duration: number; hasAudio: boolean }> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ]);
  const j = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; duration?: string }>;
  };
  const video = j.streams?.find((s) => s.codec_type === 'video');
  return {
    duration: Number(j.format?.duration ?? video?.duration ?? 0),
    hasAudio: !!j.streams?.some((s) => s.codec_type === 'audio'),
  };
}

export interface ContinuityValidationPoint {
  atSec: number;
  frameFile: string;
}

export interface FinalMediaValidation {
  ok: true;
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
  decoded: true;
  continuity: Array<{ atSec: number; ssim: number }>;
  warnings: string[];
}

async function frameSsim(videoFile: string, point: ContinuityValidationPoint, tempDir: string): Promise<number> {
  const actual = path.join(tempDir, `seam-${point.atSec.toFixed(3).replace('.', '-')}.png`);
  await extractFrameAt(videoFile, point.atSec, actual);
  const normalize = 'scale=320:320:force_original_aspect_ratio=decrease,pad=320:320:(ow-iw)/2:(oh-ih)/2:black';
  const { stderr } = await run('ffmpeg', [
    '-v', 'info', '-i', actual, '-i', point.frameFile,
    '-lavfi', `[0:v]${normalize}[a];[1:v]${normalize}[b];[a][b]ssim`,
    '-f', 'null', '-',
  ]);
  const match = /All:([0-9.]+)/.exec(stderr);
  const value = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(value)) throw new Error(`Не удалось проверить continuity-кадр на ${point.atSec.toFixed(2)}с`);
  return Math.round(value * 10_000) / 10_000;
}

/** Technical gate before a generation can become done and settle its hold. */
export async function validateRenderedVideo(
  file: string,
  options: {
    expectedDurationSec: number;
    expectAudio: boolean;
    continuity?: ContinuityValidationPoint[];
  },
): Promise<FinalMediaValidation> {
  const meta = await probe(file);
  const shape = await mediaShape(file);
  const durationTolerance = Math.max(0.75, options.expectedDurationSec * 0.05);
  if (
    !Number.isFinite(meta.durationSec) ||
    meta.durationSec < Math.max(0.1, options.expectedDurationSec - durationTolerance) ||
    meta.durationSec > options.expectedDurationSec + Math.max(2, options.expectedDurationSec * 0.1)
  ) {
    throw new Error(
      `Результат имеет неверную длительность: ${meta.durationSec.toFixed(2)}с вместо ≈${options.expectedDurationSec.toFixed(2)}с`,
    );
  }
  if (options.expectAudio && !shape.hasAudio) {
    throw new Error('В результате нет аудиодорожки, хотя звук был включён');
  }
  await run('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'null', '-'], 20 * 60_000);

  const continuity: FinalMediaValidation['continuity'] = [];
  const warnings: string[] = [];
  const tempDir = fs.mkdtempSync(path.join(path.dirname(file), '.validate-'));
  try {
    for (const point of options.continuity ?? []) {
      if (!fs.existsSync(point.frameFile)) throw new Error('Continuity-кадр исчез до финальной проверки');
      const ssim = await frameSsim(file, point, tempDir);
      continuity.push({ atSec: Math.round(point.atSec * 1000) / 1000, ssim });
      if (ssim < 0.9) warnings.push(`Возможный визуальный шов на ${point.atSec.toFixed(2)}с (SSIM ${ssim})`);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  return {
    ok: true,
    durationSec: meta.durationSec,
    width: meta.width,
    height: meta.height,
    hasAudio: shape.hasAudio,
    decoded: true,
    continuity,
    warnings,
  };
}

/**
 * Склеивает части по точному continuity-кадру. Визуальный dissolve намеренно не
 * используется: он создаёт двойные лица и контуры. У предыдущей части отрезается
 * overlap-хвост, а первый кадр следующей принудительно заменяется извлечённым из неё
 * anchor. Звук соединяется коротким acrossfade; при отсутствии звука берётся исходник.
 */
export async function stitchVideoSegments(
  segmentFiles: string[],
  outputFile: string,
  overlapSec: number,
  sourceAudioFile?: string,
  continuityFrames: Array<string | null> = [],
  continuityCutSeconds: Array<number | null> = [],
): Promise<number> {
  if (segmentFiles.length === 0) throw new Error('Нет сегментов для склейки');
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  if (segmentFiles.length === 1) {
    fs.copyFileSync(segmentFiles[0]!, outputFile);
    return fs.statSync(outputFile).size;
  }

  const shapes = await Promise.all(segmentFiles.map(mediaShape));
  const allHaveAudio = shapes.every((s) => s.hasAudio);
  const inputs = segmentFiles.flatMap((f) => ['-i', f]);
  const sourceAudioInput = !allHaveAudio && sourceAudioFile ? segmentFiles.length : null;
  if (sourceAudioInput !== null) inputs.push('-i', sourceAudioFile!);

  const anchorInputs = new Map<number, number>();
  let nextInput = segmentFiles.length + (sourceAudioInput === null ? 0 : 1);
  for (let i = 1; i < segmentFiles.length; i++) {
    const anchor = continuityFrames[i];
    if (!anchor) continue;
    inputs.push('-loop', '1', '-framerate', '30', '-i', anchor);
    anchorInputs.set(i, nextInput++);
  }

  const seams = segmentFiles.slice(1).map((_, index) =>
    Math.max(0.15, Math.min(overlapSec, shapes[index]!.duration / 3, shapes[index + 1]!.duration / 3)),
  );

  const filters: string[] = [];
  const frameDuration = 1 / 30;
  for (let i = 0; i < segmentFiles.length; i++) {
    filters.push(
      `[${i}:v]fps=30,scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1,settb=AVTB,setpts=PTS-STARTPTS[vn${i}]`,
    );
    const anchorInput = anchorInputs.get(i);
    if (anchorInput !== undefined) {
      filters.push(
        `[${anchorInput}:v]fps=30,scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1,settb=AVTB,trim=duration=${frameDuration.toFixed(6)},setpts=PTS-STARTPTS[anchor${i}]`,
        `[vn${i}]trim=start=${frameDuration.toFixed(6)},setpts=PTS-STARTPTS[tail${i}]`,
        `[anchor${i}][tail${i}]concat=n=2:v=1:a=0[v${i}]`,
      );
    } else {
      filters.push(`[vn${i}]null[v${i}]`);
    }
    if (allHaveAudio) filters.push(`[${i}:a]aresample=async=1:first_pts=0[a${i}]`);
  }

  const videoInputs: string[] = [];
  for (let i = 0; i < segmentFiles.length; i++) {
    const keepDuration = i < segmentFiles.length - 1
      ? Math.max(0.1, continuityCutSeconds[i + 1] ?? shapes[i]!.duration - seams[i]!)
      : shapes[i]!.duration;
    filters.push(`[v${i}]trim=duration=${keepDuration.toFixed(6)},setpts=PTS-STARTPTS[vc${i}]`);
    videoInputs.push(`[vc${i}]`);
  }
  filters.push(`${videoInputs.join('')}concat=n=${segmentFiles.length}:v=1:a=0[vout]`);

  let audioLabel = 'a0';
  const mergedDuration = shapes.reduce((sum, shape) => sum + shape.duration, 0) - seams.reduce((sum, seam) => sum + seam, 0);
  for (let i = 1; i < segmentFiles.length; i++) {
    if (allHaveAudio) {
      const nextAudio = `ax${i}`;
      filters.push(`[${audioLabel}][a${i}]acrossfade=d=${seams[i - 1]!.toFixed(3)}:c1=tri:c2=tri[${nextAudio}]`);
      audioLabel = nextAudio;
    }
  }

  const args = [
    '-y', ...inputs, '-filter_complex', filters.join(';'), '-map', '[vout]',
  ];
  if (allHaveAudio) args.push('-map', `[${audioLabel}]`);
  else if (sourceAudioInput !== null) args.push('-map', `${sourceAudioInput}:a:0?`, '-t', mergedDuration.toFixed(3));
  args.push(
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', outputFile,
  );
  await run('ffmpeg', args, 20 * 60_000);
  return fs.statSync(outputFile).size;
}
