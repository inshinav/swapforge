import path from 'node:path';
import fs from 'node:fs';
import { config } from './config';
import { getDb } from './db';
import { isQueued } from './jobs';

export function projectDir(id: string): string {
  return path.join(config.dataDir, 'projects', id);
}
export function framesDir(id: string): string {
  return path.join(projectDir(id), 'frames');
}
export function refsDir(id: string): string {
  return path.join(projectDir(id), 'refs');
}
export function startDir(id: string): string {
  return path.join(projectDir(id), 'start');
}
export function rendersDir(id: string): string {
  return path.join(projectDir(id), 'renders');
}

export function ensureProjectDirs(id: string): void {
  fs.mkdirSync(framesDir(id), { recursive: true });
  fs.mkdirSync(refsDir(id), { recursive: true });
}

// ── v4: хранилище моделей пользователей ─────────────────────────────────────
// dataDir/models/<modelId>/refs/ — сиблинг projects/. Ротация enforceStorageCap
// структурно не заходит в models/ (её SQL целится только в project-исходники и
// рендеры): реф-листы — постоянный актив пользователя, не кэш.

export function modelDir(id: string): string {
  return path.join(config.dataDir, 'models', id);
}
export function modelRefsDir(id: string): string {
  return path.join(modelDir(id), 'refs');
}
export function ensureModelDirs(id: string): void {
  fs.mkdirSync(modelRefsDir(id), { recursive: true });
}
export function deleteModelFiles(id: string): void {
  fs.rmSync(modelDir(id), { recursive: true, force: true });
  usageCache = null;
}

/** Как safeMediaPath, но для файлов реф-листов модели. */
export function safeModelRefPath(modelId: string, file: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(file) || file.includes('..')) return null;
  const full = path.join(modelRefsDir(modelId), file);
  if (!full.startsWith(modelDir(modelId))) return null;
  try {
    return fs.statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
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
 * Ротация в два эшелона при превышении капа:
 * 1) source-видео самых старых проектов (кадры/рефы/анализ/промты остаются — лёгкие, кормят few-shot);
 *    проекты с активной генерацией пропускаем — исходник нужен для ретрая рендера;
 * 2) старые готовые рендеры, КРОМЕ помеченных 👍 (rating=1) и последнего done в каждом проекте.
 */
export function enforceStorageCap(): { purged: string[]; purgedRenders: string[] } {
  const purged: string[] = [];
  const purgedRenders: string[] = [];
  let usage = dataUsageBytes(true);
  if (usage <= config.storageCapBytes) return { purged, purgedRenders };

  const db = getDb();
  const candidates = db
    .prepare(
      `SELECT id, video_file, video_bytes FROM projects
       WHERE video_purged = 0 AND video_file IS NOT NULL
         AND status NOT IN ('storyboarding', 'analyzing', 'generating', 'startframing')
         AND id NOT IN (
           SELECT project_id FROM generations
            WHERE status IN ('queued','uploading_assets','submitted','rendering','downloading')
         )
       ORDER BY created_at ASC`,
    )
    .all() as Array<{ id: string; video_file: string; video_bytes: number }>;

  for (const c of candidates) {
    if (usage <= config.storageCapBytes) break;
    if (isQueued(c.id)) continue; // проект ждёт джобу — исходник ещё нужен
    const file = path.join(projectDir(c.id), c.video_file);
    fs.rmSync(file, { force: true });
    db.prepare(`UPDATE projects SET video_purged = 1 WHERE id = ?`).run(c.id);
    usage -= c.video_bytes;
    purged.push(c.id);
  }

  if (usage > config.storageCapBytes) {
    const renders = db
      .prepare(
        `SELECT g.id, g.project_id, g.file, g.bytes FROM generations g
          WHERE g.status = 'done' AND g.render_purged = 0 AND g.file IS NOT NULL
            AND COALESCE(g.rating, 0) != 1
            AND g.rowid NOT IN (
              SELECT MAX(rowid) FROM generations WHERE status = 'done' GROUP BY project_id
            )
          ORDER BY g.created_at ASC, g.rowid ASC`,
      )
      .all() as Array<{ id: string; project_id: string; file: string; bytes: number }>;
    for (const r of renders) {
      if (usage <= config.storageCapBytes) break;
      fs.rmSync(path.join(rendersDir(r.project_id), r.file), { force: true });
      db.prepare(`UPDATE generations SET render_purged = 1 WHERE id = ?`).run(r.id);
      usage -= r.bytes;
      purgedRenders.push(r.id);
    }
  }

  usageCache = null;
  return { purged, purgedRenders };
}

/** Подметает файлы рефов, осиротевшие после оборванных загрузок (их нет в БД). */
export function sweepOrphanRefFiles(): number {
  const db = getDb();
  const root = path.join(config.dataDir, 'projects');
  if (!fs.existsSync(root)) return 0;
  let removed = 0;
  for (const pid of fs.readdirSync(root)) {
    const rd = path.join(root, pid, 'refs');
    if (!fs.existsSync(rd)) continue;
    const known = new Set(
      (db.prepare(`SELECT file FROM refs WHERE project_id = ?`).all(pid) as Array<{ file: string }>).map(
        (r) => r.file,
      ),
    );
    for (const f of fs.readdirSync(rd)) {
      if (!known.has(f)) {
        fs.rmSync(path.join(rd, f), { force: true });
        removed++;
      }
    }
  }
  if (removed > 0) usageCache = null;
  return removed;
}

export interface StorageCleanupResult {
  purgedResults: string[];
  deletedProjects: string[];
  transientFiles: number;
}

/** Физически оставляет только последние 20 готовых роликов пользователя. */
export function enforceLatestResultLimit(userId?: string, keep = 20): string[] {
  const db = getDb();
  const users = userId
    ? [{ id: userId }]
    : (db.prepare(`SELECT id FROM users`).all() as Array<{ id: string }>);
  const purged: string[] = [];
  for (const user of users) {
    const results = db
      .prepare(
        `SELECT g.id, g.project_id, g.file
           FROM generations g JOIN projects p ON p.id=g.project_id
          WHERE p.user_id=? AND g.status='done' AND g.render_purged=0 AND g.file IS NOT NULL
          ORDER BY COALESCE(g.finished_at, g.created_at) DESC, g.rowid DESC`,
      )
      .all(user.id) as Array<{ id: string; project_id: string; file: string }>;
    for (const result of results.slice(Math.max(0, keep))) {
      fs.rmSync(path.join(rendersDir(result.project_id), result.file), { force: true });
      db.prepare(`UPDATE generations SET render_purged=1 WHERE id=?`).run(result.id);
      purged.push(result.id);
    }
  }
  if (purged.length) usageCache = null;
  return purged;
}

/** Удаляет проекты, которые уже не попадают в библиотеку (20 последних) и ничем не заняты. */
export function cleanupInvisibleProjects(userId?: string, keep = 20): string[] {
  const db = getDb();
  const users = userId
    ? [{ id: userId }]
    : (db.prepare(`SELECT id FROM users`).all() as Array<{ id: string }>);
  const deleted: string[] = [];
  for (const user of users) {
    const projects = db
      .prepare(`SELECT id FROM projects WHERE user_id=? ORDER BY created_at DESC, rowid DESC`)
      .all(user.id) as Array<{ id: string }>;
    for (const project of projects.slice(Math.max(0, keep))) {
      const protectedRow = db
        .prepare(
          `SELECT 1 WHERE EXISTS (
             SELECT 1 FROM jobs WHERE project_id=? AND status IN ('queued','running')
           ) OR EXISTS (
             SELECT 1 FROM generations WHERE project_id=?
              AND status IN ('queued','uploading_assets','submitted','rendering','downloading')
           ) OR EXISTS (
             SELECT 1 FROM credit_holds WHERE project_id=? AND status='open'
           )`,
        )
        .get(project.id, project.id, project.id);
      if (protectedRow) continue;
      db.prepare(`DELETE FROM projects WHERE id=?`).run(project.id);
      deleteProjectFiles(project.id);
      deleted.push(project.id);
    }
    if (deleted.length) invalidateUserUsage(user.id);
  }
  return deleted;
}

/** .part, orphan renders и старые terminal render-work не переживают уборку. */
export function sweepTransientProjectFiles(nowMs = Date.now()): number {
  const db = getDb();
  const root = path.join(config.dataDir, 'projects');
  if (!fs.existsSync(root)) return 0;
  let removed = 0;
  const removeParts = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) removeParts(full);
      else if (entry.name.endsWith('.part')) {
        fs.rmSync(full, { force: true });
        removed++;
      }
    }
  };
  removeParts(root);

  for (const projectId of fs.readdirSync(root)) {
    const renderRoot = rendersDir(projectId);
    if (fs.existsSync(renderRoot)) {
      const known = new Set(
        (db.prepare(`SELECT file FROM generations WHERE project_id=? AND file IS NOT NULL`).all(projectId) as Array<{ file: string }>).map(
          (row) => row.file,
        ),
      );
      for (const file of fs.readdirSync(renderRoot)) {
        if (!known.has(file)) {
          fs.rmSync(path.join(renderRoot, file), { force: true });
          removed++;
        }
      }
    }
    const workRoot = path.join(projectDir(projectId), 'render-work');
    if (!fs.existsSync(workRoot)) continue;
    for (const genId of fs.readdirSync(workRoot)) {
      const work = path.join(workRoot, genId);
      const row = db.prepare(`SELECT status, finished_at FROM generations WHERE id=? AND project_id=?`).get(genId, projectId) as
        | { status: string; finished_at: string | null }
        | undefined;
      const finishedMs = row?.finished_at ? Date.parse(`${row.finished_at.replace(' ', 'T')}Z`) : fs.statSync(work).mtimeMs;
      const removable = !row || row.status === 'done' || (row.status === 'failed' && nowMs - finishedMs >= 24 * 3_600_000);
      if (removable) {
        fs.rmSync(work, { recursive: true, force: true });
        removed++;
      }
    }
  }
  if (removed) usageCache = null;
  return removed;
}

export function cleanupStorageLifecycle(userId?: string): StorageCleanupResult {
  const purgedResults = enforceLatestResultLimit(userId);
  const deletedProjects = cleanupInvisibleProjects(userId);
  const transientFiles = sweepTransientProjectFiles();
  enforceStorageCap();
  return { purgedResults, deletedProjects, transientFiles };
}

export function deleteProjectFiles(id: string): void {
  fs.rmSync(projectDir(id), { recursive: true, force: true });
  usageCache = null;
}

// ── v4: персональный кап хранилища ──────────────────────────────────────────

const userUsageCache = new Map<string, { at: number; bytes: number }>();

/** Суммарный вес проектов + моделей пользователя (кэш 60с на юзера). */
export function userUsageBytes(userId: string, force = false): number {
  const hit = userUsageCache.get(userId);
  if (!force && hit && Date.now() - hit.at < 60_000) return hit.bytes;
  const db = getDb();
  let bytes = 0;
  const projects = db.prepare(`SELECT id FROM projects WHERE user_id = ?`).all(userId) as Array<{ id: string }>;
  for (const p of projects) bytes += dirSize(projectDir(p.id));
  const models = db.prepare(`SELECT id FROM models WHERE user_id = ?`).all(userId) as Array<{ id: string }>;
  for (const m of models) bytes += dirSize(modelDir(m.id));
  userUsageCache.set(userId, { at: Date.now(), bytes });
  return bytes;
}

/** Сброс кэша юзера после загрузок/удалений (следующий замер — честный). */
export function invalidateUserUsage(userId: string): void {
  userUsageCache.delete(userId);
}

/** Безопасное имя файла внутри каталога проекта (без путей от пользователя). */
export function safeMediaPath(
  projectId: string,
  sub: 'frames' | 'refs' | 'start' | 'renders' | '.',
  file: string,
): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(file) || file.includes('..')) return null;
  const base = sub === '.' ? projectDir(projectId) : path.join(projectDir(projectId), sub);
  const full = path.join(base, file);
  if (!full.startsWith(projectDir(projectId))) return null;
  try {
    return fs.statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}
