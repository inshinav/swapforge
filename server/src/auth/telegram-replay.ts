import { getDb } from '../db';
import { TG_AUTH_MAX_AGE_MS } from './telegram';

function sqliteTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** Atomically consumes a verified Telegram login hash for the rest of its freshness window. */
export function consumeTelegramLoginHash(
  loginHash: string,
  authDateSeconds: number,
  nowMs = Date.now(),
): boolean {
  const db = getDb();
  const now = sqliteTime(nowMs);
  db.prepare(`DELETE FROM telegram_login_replays WHERE expires_at <= ?`).run(now);
  const expiresAt = sqliteTime(Math.max(nowMs + 1_000, authDateSeconds * 1000 + TG_AUTH_MAX_AGE_MS));
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO telegram_login_replays (login_hash, expires_at)
       VALUES (?, ?)`,
    )
    .run(loginHash, expiresAt);
  return Number(result.changes) === 1;
}
