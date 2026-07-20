import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config';
import { runDataMigrations } from './migrations';

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

    -- v4: пользователи (вход через Telegram Login Widget; identity = telegram_id).
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      telegram_id INTEGER NOT NULL UNIQUE,
      tg_username TEXT NOT NULL DEFAULT '',
      tg_first_name TEXT NOT NULL DEFAULT '',
      tg_photo_url TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','owner')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at TEXT
    );

    -- v4: сессии — в БД только sha256 сырого токена, сам токен живёт в httpOnly-cookie.
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      last_seen_at TEXT
    );

    -- A signed Telegram Login Widget payload is a bearer credential. Remember its hash for
    -- the remainder of the freshness window so it cannot mint multiple independent sessions.
    CREATE TABLE IF NOT EXISTS telegram_login_replays (
      login_hash TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL,
      consumed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- v4: exactly-once миграции ДАННЫХ (backfill/сиды); DDL остаётся на applySchema.
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- v4: модели пользователей (персонажи). visibility заложена под будущую витрину,
    -- в v4 всегда 'private' — шаринга нет.
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT
    );

    -- Вариант образа (причёска/аутфит) = одна пресет-кнопка в «Кто в кадре?».
    CREATE TABLE IF NOT EXISTS model_variants (
      id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      hint TEXT NOT NULL DEFAULT '',
      idx INTEGER NOT NULL DEFAULT 0
    );

    -- Реф-листы модели. variant_id NULL = общий для всех вариантов (мотоцикл/объект).
    CREATE TABLE IF NOT EXISTS model_refs (
      id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
      variant_id TEXT REFERENCES model_variants(id) ON DELETE CASCADE,
      file TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('model','vehicle','object')),
      note TEXT NOT NULL DEFAULT '',
      auto_note TEXT NOT NULL DEFAULT '',
      idx INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_refs_project ON refs(project_id, idx);
    CREATE INDEX IF NOT EXISTS idx_prompts_project ON prompts(project_id, version);
    CREATE INDEX IF NOT EXISTS idx_feedback_project ON feedback(project_id, version);
    CREATE INDEX IF NOT EXISTS idx_generations_project ON generations(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_generations_status ON generations(status);
    CREATE INDEX IF NOT EXISTS idx_usage_project ON usage_events(project_id);
    CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_events(created_at);
    -- v4: кредиты. Леджер append-only (баланс = SUM), payment_ref UNIQUE даёт
    -- идемпотентность вебхука бесплатно. Холды отдельно: available = SUM(ledger) − open-холды.
    CREATE TABLE IF NOT EXISTS credit_ledger (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      delta_credits INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('purchase','charge','refund','adjust')),
      hold_id TEXT,
      generation_id TEXT,
      project_id TEXT,
      payment_ref TEXT,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- v4: дневные анти-абьюз счётчики (kind: projects/classify/describe/manual_llm).
    CREATE TABLE IF NOT EXISTS usage_counters (
      user_id TEXT NOT NULL,
      day TEXT NOT NULL,
      kind TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day, kind)
    );

    CREATE TABLE IF NOT EXISTS credit_holds (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      project_id TEXT NOT NULL,
      generation_id TEXT,
      credits INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','settled','released')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT
    );

    -- One durable record per confirmed user action. Quotes are immutable snapshots; only the
    -- lifecycle/link columns change after confirmation.
    CREATE TABLE IF NOT EXISTS flow_attempts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      action TEXT NOT NULL CHECK (action IN ('first','rerun','retry','iterate','classify','describe')),
      version INTEGER,
      source_generation_id TEXT,
      generation_id TEXT,
      hold_id TEXT,
      final_price_cents INTEGER,
      pricing_snapshot_json TEXT NOT NULL,
      ref_fingerprint TEXT NOT NULL,
      context_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'quoted' CHECK (status IN ('quoted','held','running','done','failed','cancelled')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS payment_intents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK (provider IN ('cryptopay','lavatop')),
      external_id TEXT,
      credits_cents INTEGER NOT NULL CHECK (credits_cents > 0),
      paid_currency TEXT NOT NULL,
      expected_paid_minor INTEGER NOT NULL CHECK (expected_paid_minor > 0),
      status TEXT NOT NULL DEFAULT 'creating'
        CHECK (status IN ('creating','pending','paid','credited','expired','cancelled','failed','quarantined')),
      pay_url TEXT,
      expires_at TEXT,
      reconcile_after TEXT NOT NULL DEFAULT (datetime('now')),
      reconcile_attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      paid_at TEXT,
      credited_at TEXT,
      UNIQUE (provider, external_id)
    );

    CREATE TABLE IF NOT EXISTS payment_events (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      event_hash TEXT NOT NULL UNIQUE,
      external_ref TEXT,
      intent_id TEXT REFERENCES payment_intents(id) ON DELETE SET NULL,
      source TEXT NOT NULL CHECK (source IN ('webhook','reconcile')),
      verified INTEGER NOT NULL DEFAULT 0,
      outcome TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      processed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_telegram_login_replays_expiry ON telegram_login_replays(expires_at);
    CREATE INDEX IF NOT EXISTS idx_models_user ON models(user_id);
    CREATE INDEX IF NOT EXISTS idx_model_variants_model ON model_variants(model_id, idx);
    CREATE INDEX IF NOT EXISTS idx_model_refs_model ON model_refs(model_id, idx);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_payment ON credit_ledger(payment_ref) WHERE payment_ref IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_ledger_user ON credit_ledger(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_holds_user_open ON credit_holds(user_id) WHERE status = 'open';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_holds_one_open_per_project ON credit_holds(project_id) WHERE status = 'open';
    CREATE INDEX IF NOT EXISTS idx_flow_attempts_user ON flow_attempts(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_flow_attempts_project ON flow_attempts(project_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_flow_attempts_active_project
      ON flow_attempts(project_id) WHERE status IN ('held','running');
    CREATE INDEX IF NOT EXISTS idx_payment_intents_user ON payment_intents(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_payment_intents_reconcile
      ON payment_intents(status, reconcile_after) WHERE status IN ('creating','pending','paid');
    CREATE INDEX IF NOT EXISTS idx_payment_events_intent ON payment_events(intent_id, created_at);
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

  // Микромиграции v2 → v4: владелец строки. projects — корень тенантности; на generations
  // и usage_events user_id денормализован (биллинг-запросы без join, ledger переживает
  // удаление проекта). NOT NULL не навешиваем: легаси-строки добирает m001-backfill.
  ensureColumn(d, 'projects', 'user_id', `user_id TEXT`);
  ensureColumn(d, 'generations', 'user_id', `user_id TEXT`);
  // Длинный рендер: чекпойнт плана/предиктов/локальных частей + прогресс для UI.
  ensureColumn(d, 'generations', 'segments_json', `segments_json TEXT`);
  ensureColumn(d, 'generations', 'segment_count', `segment_count INTEGER NOT NULL DEFAULT 1`);
  ensureColumn(d, 'generations', 'segment_done', `segment_done INTEGER NOT NULL DEFAULT 0`);
  ensureColumn(d, 'usage_events', 'user_id', `user_id TEXT`);
  // email покупателя (Lava.top требует в инвойсе; спрашиваем при первой оплате картой)
  ensureColumn(d, 'users', 'email', `email TEXT`);
  ensureColumn(d, 'credit_holds', 'attempt_id', `attempt_id TEXT`);
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_events(user_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_holds_attempt ON credit_holds(attempt_id) WHERE attempt_id IS NOT NULL;
  `);
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
  runDataMigrations(db, { ownerTelegramId: config.ownerTelegramId || null });
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
