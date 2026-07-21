// Opaque-сессии (порт паттерна ai-dash): клиенту уходит сырой 256-битный токен в
// httpOnly-cookie, в БД лежит только его sha256 — чтение БД не даёт рабочего креда.
// Lookup по хэшу, constant-time сравнение не нужно (коллизия sha256 нереальна).
import { createHash, randomBytes } from 'node:crypto';
import { getDb } from '../db';

export const SESSION_TTL_MS = 30 * 24 * 3_600_000; // 30 дней
/** Sliding-продление: не чаще раза в сутки при активности. */
export const SESSION_REFRESH_AFTER_MS = 24 * 3_600_000;

export interface SessionUser {
  id: string;
  telegramId: number;
  username: string;
  firstName: string;
  photoUrl: string;
  role: 'user' | 'owner';
  /** Тест-клиент владельца: обычный metered-юзер для проверки пути клиента. */
  sandbox: boolean;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function mintSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

/** ms epoch → формат datetime('now') sqlite (UTC, строковое сравнение работает). */
function sqliteTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

export function createSession(userId: string, nowMs = Date.now()): { token: string } {
  const { token, tokenHash } = mintSessionToken();
  getDb()
    .prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)`)
    .run(tokenHash, userId, sqliteTime(nowMs + SESSION_TTL_MS));
  return { token };
}

/**
 * Токен → живой пользователь (или null). Просроченные/чужие/заблокированные — null.
 * Sliding-продление и last_seen_at обновляются не чаще раза в сутки (не жжём диск WAL).
 */
export function authenticateSession(rawToken: string, nowMs = Date.now()): SessionUser | null {
  if (!rawToken) return null;
  const row = getDb()
    .prepare(
      `SELECT s.token_hash, s.expires_at, s.last_seen_at, s.created_at,
              u.id, u.telegram_id, u.tg_username, u.tg_first_name, u.tg_photo_url, u.role, u.status, u.sandbox_of
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
    )
    .get(hashToken(rawToken)) as
    | {
        token_hash: string;
        expires_at: string;
        last_seen_at: string | null;
        created_at: string;
        id: string;
        telegram_id: number;
        tg_username: string;
        tg_first_name: string;
        tg_photo_url: string;
        role: string;
        status: string;
        sandbox_of: string | null;
      }
    | undefined;
  if (!row) return null;
  if (row.status !== 'active') return null; // бан действует мгновенно, сессии не ждём
  const now = sqliteTime(nowMs);
  if (row.expires_at <= now) return null;

  const lastSeen = row.last_seen_at ?? row.created_at;
  if (sqliteTime(nowMs - SESSION_REFRESH_AFTER_MS) > lastSeen) {
    getDb()
      .prepare(`UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE token_hash = ?`)
      .run(sqliteTime(nowMs + SESSION_TTL_MS), now, row.token_hash);
  }
  return {
    id: row.id,
    telegramId: row.telegram_id,
    username: row.tg_username,
    firstName: row.tg_first_name,
    photoUrl: row.tg_photo_url,
    role: row.role === 'owner' ? 'owner' : 'user',
    sandbox: !!row.sandbox_of,
  };
}

export function destroySession(rawToken: string): void {
  if (!rawToken) return;
  getDb().prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(hashToken(rawToken));
}

/** Уборка протухших сессий: на буте и по unref-таймеру раз в сутки. */
export function purgeExpiredSessions(nowMs = Date.now()): number {
  const res = getDb()
    .prepare(`DELETE FROM sessions WHERE expires_at <= ?`)
    .run(sqliteTime(nowMs));
  return Number(res.changes);
}
