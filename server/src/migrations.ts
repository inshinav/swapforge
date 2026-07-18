// Exactly-once миграции ДАННЫХ (не DDL — DDL живёт в applySchema идемпотентно).
// Каждая запускается ровно один раз, помечается в schema_migrations, катится в
// BEGIN IMMEDIATE (единый писатель SQLite: никакой другой запрос не вклинится).
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface DataMigrationOpts {
  /** telegram_id владельца из env; null (дев/тесты) = owner-миграции откладываются. */
  ownerTelegramId: string | null;
}

interface DataMigration {
  id: string;
  /** false = условия не готовы (нет env) — НЕ помечать применённой, попробуем на следующем буте. */
  up(d: DatabaseSync, opts: DataMigrationOpts): boolean;
}

/** Владелец: единственная строка role='owner'; создаётся до первого TG-входа. */
export function ensureOwnerUser(d: DatabaseSync, ownerTelegramId: string): string {
  const tgId = Number(ownerTelegramId);
  if (!Number.isFinite(tgId) || tgId <= 0) {
    throw new Error(`OWNER_TELEGRAM_ID должен быть числом, а не «${ownerTelegramId}»`);
  }
  const existing = d.prepare(`SELECT id FROM users WHERE telegram_id = ?`).get(tgId) as
    | { id: string }
    | undefined;
  if (existing) {
    d.prepare(`UPDATE users SET role = 'owner' WHERE id = ?`).run(existing.id);
    return existing.id;
  }
  const id = randomUUID();
  d.prepare(
    `INSERT INTO users (id, telegram_id, tg_first_name, role) VALUES (?, ?, 'Владелец', 'owner')`,
  ).run(id, tgId);
  return id;
}

const MIGRATIONS: DataMigration[] = [
  {
    // Все легаси-строки single-owner эпохи принадлежат владельцу. usage_events с
    // NULL project_id (история удалённых проектов) — тоже его: до v4 других юзеров не было.
    id: 'm001-owner-and-backfill',
    up(d, opts) {
      if (!opts.ownerTelegramId) return false;
      const ownerId = ensureOwnerUser(d, opts.ownerTelegramId);
      d.prepare(`UPDATE projects SET user_id = ? WHERE user_id IS NULL`).run(ownerId);
      d.prepare(
        `UPDATE generations SET user_id = (SELECT p.user_id FROM projects p WHERE p.id = generations.project_id)
          WHERE user_id IS NULL`,
      ).run();
      d.prepare(
        `UPDATE usage_events SET user_id = COALESCE(
            (SELECT p.user_id FROM projects p WHERE p.id = usage_events.project_id), ?)
          WHERE user_id IS NULL`,
      ).run(ownerId);
      return true;
    },
  },
];

/** Вызывается из getDb() после applySchema; порядок массива = порядок применения. */
export function runDataMigrations(d: DatabaseSync, opts: DataMigrationOpts): void {
  for (const m of MIGRATIONS) {
    const done = d.prepare(`SELECT 1 FROM schema_migrations WHERE id = ?`).get(m.id);
    if (done) continue;
    d.exec('BEGIN IMMEDIATE');
    try {
      const applied = m.up(d, opts);
      if (applied) {
        d.prepare(`INSERT INTO schema_migrations (id) VALUES (?)`).run(m.id);
        d.exec('COMMIT');
        console.log(`[migrate] ${m.id} применена`);
      } else {
        d.exec('ROLLBACK');
        console.warn(`[migrate] ${m.id} отложена: не задан OWNER_TELEGRAM_ID`);
      }
    } catch (e) {
      d.exec('ROLLBACK');
      throw new Error(`Миграция ${m.id} упала: ${e instanceof Error ? e.message : e}`);
    }
  }
}
