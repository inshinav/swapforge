import path from 'node:path';
import fs from 'node:fs';
import { config } from './config';
import { getDb } from './db';

export function projectDir(id: string): string {
  return path.join(config.dataDir, 'projects', id);
}
export function framesDir(id: string): string {
  return path.join(projectDir(id), 'frames');
}
export function refsDir(id: string): string {
  return path.join(projectDir(id), 'refs');
}

export function ensureProjectDirs(id: string): void {
  fs.mkdirSync(framesDir(id), { recursive: true });
  fs.mkdirSync(refsDir(id), { recursive: true });
}

function dirSize(dir: string): number {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else {
      try {
        total += fs.statSync(p).size;
      } catch {
        /* файл мог исчезнуть между readdir и stat */
      }
    }
  }
  return total;
}

let usageCache: { at: number; bytes: number } | null = null;
export function dataUsageBytes(force = false): number {
  if (!force && usageCache && Date.now() - usageCache.at < 60_000) return usageCache.bytes;
  const bytes = dirSize(config.dataDir);
  usageCache = { at: Date.now(), bytes };
  return bytes;
}

/**
 * Ротация: при превышении капа удаляем source-видео самых старых проектов
 * (кадры/рефы/анализ/промты остаются — они лёгкие и нужны для few-shot).
 */
export function enforceStorageCap(): { purged: string[] } {
  const purged: string[] = [];
  let usage = dataUsageBytes(true);
  if (usage <= config.storageCapBytes) return { purged };

  const db = getDb();
  const candidates = db
    .prepare(
      `SELECT id, video_file, video_bytes FROM projects
       WHERE video_purged = 0 AND video_file IS NOT NULL
         AND status NOT IN ('storyboarding', 'analyzing', 'generating')
       ORDER BY created_at ASC`,
    )
    .all() as Array<{ id: string; video_file: string; video_bytes: number }>;

  for (const c of candidates) {
    if (usage <= config.storageCapBytes) break;
    const file = path.join(projectDir(c.id), c.video_file);
    fs.rmSync(file, { force: true });
    db.prepare(`UPDATE projects SET video_purged = 1 WHERE id = ?`).run(c.id);
    usage -= c.video_bytes;
    purged.push(c.id);
  }
  usageCache = null;
  return { purged };
}

export function deleteProjectFiles(id: string): void {
  fs.rmSync(projectDir(id), { recursive: true, force: true });
  usageCache = null;
}

/** Безопасное имя файла внутри каталога проекта (без путей от пользователя). */
export function safeMediaPath(projectId: string, sub: 'frames' | 'refs' | '.', file: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(file) || file.includes('..')) return null;
  const base = sub === '.' ? projectDir(projectId) : path.join(projectDir(projectId), sub);
  const full = path.join(base, file);
  if (!full.startsWith(projectDir(projectId))) return null;
  return fs.existsSync(full) ? full : null;
}
