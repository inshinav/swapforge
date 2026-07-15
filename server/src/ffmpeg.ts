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

export async function probe(file: string): Promise<VideoMeta> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format', '-show_streams',
    file,
  ]);
  const j = JSON.parse(stdout) as {
    format?: { duration?: string; size?: string };
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      duration?: string;
      r_frame_rate?: string;
    }>;
  };
  const v = (j.streams ?? []).find((s) => s.codec_type === 'video');
  if (!v || !v.width || !v.height) throw new Error('В файле нет видеопотока — это точно ролик?');
  const durationSec = Number(j.format?.duration ?? v.duration ?? 0);
  const [num = 0, den = 1] = String(v.r_frame_rate ?? '0/1').split('/').map(Number);
  const fps = den ? Math.round((num / den) * 100) / 100 : 0;
  return {
    durationSec: Math.round(durationSec * 100) / 100,
    width: v.width,
    height: v.height,
    fps,
    aspect: reduceAspect(v.width, v.height),
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
  const sceneOut = await run('ffmpeg', [
    '-y', '-i', videoFile,
    '-vf', `select='gt(scene,${SCENE_THRESHOLD})',showinfo,${SCALE_ANALYSIS}`,
    '-fps_mode', 'vfr', '-q:v', '3',
    path.join(framesDir, 'scene_%03d.jpg'),
  ]);
  const sceneTimes: number[] = [];
  for (const m of sceneOut.stderr.matchAll(/pts_time:([0-9.]+)/g)) {
    sceneTimes.push(Number(m[1]));
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
