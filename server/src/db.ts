import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config';

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(config.dataDir, { recursive: true });
  db = new DatabaseSync(path.join(config.dataDir, 'swapforge.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'uploaded',
      error TEXT,
      video_file TEXT,
      video_bytes INTEGER NOT NULL DEFAULT 0,
      video_purged INTEGER NOT NULL DEFAULT 0,
      meta_json TEXT,
      frames_json TEXT,
      analysis_json TEXT,
      tags_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS refs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      role TEXT NOT NULL,
      file TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS prompts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      kind TEXT NOT NULL,
      lang TEXT NOT NULL DEFAULT 'en',
      text TEXT NOT NULL,
      params_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      worked INTEGER NOT NULL,
      artifacts_json TEXT NOT NULL DEFAULT '[]',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_refs_project ON refs(project_id, idx);
    CREATE INDEX IF NOT EXISTS idx_prompts_project ON prompts(project_id, version);
    CREATE INDEX IF NOT EXISTS idx_feedback_project ON feedback(project_id, version);
  `);
  return db;
}

/** После рестарта: джобы, прерванные на середине, помечаем ошибкой с понятным текстом. */
export function resetInterruptedJobs(): void {
  const d = getDb();
  const interrupted: Record<string, string> = {
    storyboarding: 'uploaded',
    analyzing: 'storyboarded',
    generating: 'analyzed',
  };
  for (const [busy, fallback] of Object.entries(interrupted)) {
    d.prepare(
      `UPDATE projects SET status = ?, error = 'Задача прервана перезапуском сервиса — запусти шаг ещё раз' WHERE status = ?`,
    ).run(fallback, busy);
  }
}
