import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config';

let db: DatabaseSync | null = null;

/** Идемпотентное добавление колонки — микромиграции без фреймворка. */
export function ensureColumn(d: DatabaseSync, table: string, column: string, ddl: string): void {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

/** Вся схема (v1 + v2) идемпотентно; вызывается на каждом старте и из тестов. */
export function applySchema(d: DatabaseSync): void {
  d.exec(`
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

    -- v2: рендеры WaveSpeed. Статус рендера живёт ТОЛЬКО здесь (projects.status не трогаем).
    CREATE TABLE IF NOT EXISTS generations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'uploading_assets',
      ws_prediction_id TEXT,
      ws_assets_json TEXT,
      params_json TEXT NOT NULL DEFAULT '{}',
      file TEXT,
      bytes INTEGER NOT NULL DEFAULT 0,
      render_purged INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      cost_est_json TEXT,
      cost_actual_usd REAL,
      cost_source TEXT,
      balance_before_usd REAL,
      rating INTEGER,
      artifacts_json TEXT NOT NULL DEFAULT '[]',
      notes TEXT NOT NULL DEFAULT '',
      feedback_id TEXT,
      retry_of TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      submitted_at TEXT,
      finished_at TEXT
    );

    -- v2: учёт LLM-расхода. Без FK: месячные суммы должны переживать удаление проекта.
    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      generation_id TEXT,
      task TEXT NOT NULL,
      model TEXT NOT NULL,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL,
      price_date TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- v2: last-known-good живых тарифов (litellm-манифест / запись каталога WaveSpeed).
    CREATE TABLE IF NOT EXISTS pricing_cache (
      source TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_refs_project ON refs(project_id, idx);
    CREATE INDEX IF NOT EXISTS idx_prompts_project ON prompts(project_id, version);
    CREATE INDEX IF NOT EXISTS idx_feedback_project ON feedback(project_id, version);
    CREATE INDEX IF NOT EXISTS idx_generations_project ON generations(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_generations_status ON generations(status);
    CREATE INDEX IF NOT EXISTS idx_usage_project ON usage_events(project_id);
    CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_events(created_at);
  `);

  // Микромиграции v1 → v2
  ensureColumn(d, 'projects', 'flow', `flow TEXT NOT NULL DEFAULT 'manual'`);
  ensureColumn(d, 'projects', 'flags_json', `flags_json TEXT`);
  // формат как у datetime('now') — сравнивается строково с usage_events.created_at
  ensureColumn(d, 'projects', 'flow_started_at', `flow_started_at TEXT`);
  // фактические длительности локальных стадий: {storyboard: сек, analyze: …} — для степпера
  ensureColumn(d, 'projects', 'stage_times_json', `stage_times_json TEXT`);
  ensureColumn(d, 'prompts', 'flags_json', `flags_json TEXT`);
  ensureColumn(d, 'refs', 'role_source', `role_source TEXT NOT NULL DEFAULT 'manual'`);
  ensureColumn(d, 'refs', 'auto_note', `auto_note TEXT NOT NULL DEFAULT ''`);
}

export function getDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(config.dataDir, { recursive: true });
  db = new DatabaseSync(path.join(config.dataDir, 'swapforge.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
  `);
  applySchema(db);
  return db;
}

/** После рестарта: джобы, прерванные на середине, помечаем ошибкой с понятным текстом. */
export function resetInterruptedJobs(): void {
  const d = getDb();
  const interrupted: Record<string, string> = {
    storyboarding: 'uploaded',
    analyzing: 'storyboarded',
    generating: 'analyzed',
    startframing: 'complete',
  };
  for (const [busy, fallback] of Object.entries(interrupted)) {
    d.prepare(
      `UPDATE projects SET status = ?, error = 'Задача прервана перезапуском сервиса — запусти шаг ещё раз' WHERE status = ?`,
    ).run(fallback, busy);
  }
}
