import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';

// БД в темп-каталог ДО импорта модулей, читающих config
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-auth-'));

const { verifyTelegramLogin, TG_AUTH_MAX_AGE_MS } = await import('../src/auth/telegram');
const {
  createSession,
  authenticateSession,
  destroySession,
  purgeExpiredSessions,
  mintSessionToken,
  hashToken,
  SESSION_REFRESH_AFTER_MS,
} = await import('../src/auth/sessions');
const { parseCookies, loginCookies, clearCookies, mintCsrfValue } = await import(
  '../src/auth/cookies'
);
const { verifyCsrf } = await import('../src/auth/middleware');
const { getDb } = await import('../src/db');
const { applySchema } = await import('../src/db');
const { runDataMigrations, ensureOwnerUser } = await import('../src/migrations');
const { DatabaseSync } = await import('node:sqlite');

const BOT_TOKEN = '1234567:TEST-BOT-TOKEN-abcdef';

/** Подписываем payload так же, как это делает Telegram (эталон для позитивных кейсов). */
function signPayload(fields: Record<string, string | number>): Record<string, unknown> {
  const dataCheck = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${String(fields[k])}`)
    .join('\n');
  const secret = createHash('sha256').update(BOT_TOKEN).digest();
  const hash = createHmac('sha256', secret).update(dataCheck).digest('hex');
  return { ...fields, hash };
}

const NOW = 1_800_000_000_000; // фиксированное «сейчас» (ms)

function validPayload(overrides: Record<string, string | number> = {}): Record<string, unknown> {
  return signPayload({
    id: 42,
    first_name: 'Алекс',
    username: 'alex_test',
    photo_url: 'https://t.me/i/userpic/x.jpg',
    auth_date: Math.floor(NOW / 1000) - 60,
    ...overrides,
  });
}

describe('verifyTelegramLogin', () => {
  it('валидная подпись проходит', () => {
    const res = verifyTelegramLogin(validPayload(), BOT_TOKEN, NOW);
    expect(res).toEqual({ ok: true, tgId: 42 });
  });

  it('подпись без опциональных полей (минимальный payload) проходит', () => {
    const res = verifyTelegramLogin(
      signPayload({ id: 7, auth_date: Math.floor(NOW / 1000) - 5 }),
      BOT_TOKEN,
      NOW,
    );
    expect(res).toEqual({ ok: true, tgId: 7 });
  });

  it('подделка любого поля рушит подпись', () => {
    const p = validPayload();
    const tampered = { ...p, id: 43 }; // чужой id при старой подписи
    const res = verifyTelegramLogin(tampered, BOT_TOKEN, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('bad_signature');
  });

  it('подпись чужим bot_token не проходит', () => {
    const res = verifyTelegramLogin(validPayload(), 'другой-токен', NOW);
    expect(res.ok).toBe(false);
  });

  it('протухший auth_date (старше суток) отклоняется', () => {
    const stale = validPayload({ auth_date: Math.floor((NOW - TG_AUTH_MAX_AGE_MS) / 1000) - 10 });
    const res = verifyTelegramLogin(stale, BOT_TOKEN, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('stale');
  });

  it('auth_date из будущего (за пределами скью) отклоняется', () => {
    const future = validPayload({ auth_date: Math.floor(NOW / 1000) + 3600 });
    const res = verifyTelegramLogin(future, BOT_TOKEN, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('from_future');
  });

  it('мусорные payload/hash не роняют, а отклоняются', () => {
    expect(verifyTelegramLogin(null, BOT_TOKEN, NOW).ok).toBe(false);
    expect(verifyTelegramLogin('строка', BOT_TOKEN, NOW).ok).toBe(false);
    expect(verifyTelegramLogin({ id: 1, auth_date: 1, hash: 'не-hex' }, BOT_TOKEN, NOW).ok).toBe(false);
    expect(verifyTelegramLogin(validPayload(), '', NOW).ok).toBe(false);
  });
});

describe('sessions', () => {
  let userId: string;

  beforeAll(() => {
    const db = getDb();
    userId = 'sess-user-1';
    db.prepare(`INSERT INTO users (id, telegram_id) VALUES (?, 501)`).run(userId);
  });

  it('mint: сырой токен не равен хэшу, хэш детерминирован', () => {
    const { token, tokenHash } = mintSessionToken();
    expect(token).not.toBe(tokenHash);
    expect(hashToken(token)).toBe(tokenHash);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('create → authenticate возвращает пользователя; чужой токен = null', () => {
    const { token } = createSession(userId);
    const u = authenticateSession(token);
    expect(u?.id).toBe(userId);
    expect(u?.telegramId).toBe(501);
    expect(authenticateSession('несуществующий-токен')).toBeNull();
  });

  it('в БД лежит только sha256, не сырой токен', () => {
    const { token } = createSession(userId);
    const rows = getDb().prepare(`SELECT token_hash FROM sessions`).all() as Array<{
      token_hash: string;
    }>;
    expect(rows.some((r) => r.token_hash === token)).toBe(false);
    expect(rows.some((r) => r.token_hash === hashToken(token))).toBe(true);
  });

  it('просроченная сессия = null; purge её удаляет', () => {
    const { token } = createSession(userId, Date.now() - 40 * 24 * 3_600_000);
    expect(authenticateSession(token)).toBeNull();
    const purged = purgeExpiredSessions();
    expect(purged).toBeGreaterThan(0);
  });

  it('sliding: активность спустя >1 суток продлевает expires_at', () => {
    const t0 = Date.now();
    const { token } = createSession(userId, t0);
    const before = getDb()
      .prepare(`SELECT expires_at FROM sessions WHERE token_hash = ?`)
      .get(hashToken(token)) as { expires_at: string };
    // спустя 2 дня активности
    const u = authenticateSession(token, t0 + 2 * SESSION_REFRESH_AFTER_MS);
    expect(u?.id).toBe(userId);
    const after = getDb()
      .prepare(`SELECT expires_at FROM sessions WHERE token_hash = ?`)
      .get(hashToken(token)) as { expires_at: string };
    expect(after.expires_at > before.expires_at).toBe(true);
  });

  it('заблокированный пользователь теряет доступ мгновенно (сессия жива, вход — нет)', () => {
    const db = getDb();
    db.prepare(`INSERT INTO users (id, telegram_id, status) VALUES ('blocked-u', 502, 'active')`).run();
    const { token } = createSession('blocked-u');
    expect(authenticateSession(token)?.id).toBe('blocked-u');
    db.prepare(`UPDATE users SET status = 'blocked' WHERE id = 'blocked-u'`).run();
    expect(authenticateSession(token)).toBeNull();
  });

  it('destroySession убивает сессию', () => {
    const { token } = createSession(userId);
    destroySession(token);
    expect(authenticateSession(token)).toBeNull();
  });
});

describe('cookies + CSRF', () => {
  it('parseCookies разбирает заголовок', () => {
    expect(parseCookies('a=1; sf_sess=tok%3D%3D; b=2')).toEqual({ a: '1', sf_sess: 'tok==', b: '2' });
    expect(parseCookies(undefined)).toEqual({});
  });

  it('loginCookies: сессия httpOnly, CSRF — нет, обе на cookiePath', () => {
    const [sess, csrf] = loginCookies('TOKEN', 'CSRFVAL');
    expect(sess).toContain('sf_sess=TOKEN');
    expect(sess).toContain('HttpOnly');
    expect(sess).toContain('Path=/swapforge');
    expect(sess).toContain('SameSite=Lax');
    expect(csrf).toContain('sf_csrf=CSRFVAL');
    expect(csrf).not.toContain('HttpOnly');
  });

  it('clearCookies зануляет обе с Max-Age=0', () => {
    for (const c of clearCookies()) expect(c).toContain('Max-Age=0');
  });

  const fakeReq = (method: string, cookie?: string, header?: string) =>
    ({ method, headers: { cookie, 'x-sf-csrf': header } }) as never;

  it('verifyCsrf: GET проходит без пары; мутация требует совпадения cookie и заголовка', () => {
    const v = mintCsrfValue();
    expect(verifyCsrf(fakeReq('GET'))).toBe(true);
    expect(verifyCsrf(fakeReq('POST', `sf_csrf=${v}`, v))).toBe(true);
    expect(verifyCsrf(fakeReq('POST', `sf_csrf=${v}`, 'другое'))).toBe(false);
    expect(verifyCsrf(fakeReq('POST', undefined, v))).toBe(false);
    expect(verifyCsrf(fakeReq('POST', `sf_csrf=${v}`, undefined))).toBe(false);
  });
});

describe('runDataMigrations (m001 backfill)', () => {
  function freshDb() {
    const d = new DatabaseSync(':memory:');
    applySchema(d);
    return d;
  }

  it('без OWNER_TELEGRAM_ID откладывается и НЕ помечается применённой', () => {
    const d = freshDb();
    d.prepare(`INSERT INTO projects (id, title) VALUES ('legacy-1', 't')`).run();
    runDataMigrations(d, { ownerTelegramId: null });
    expect(d.prepare(`SELECT 1 FROM schema_migrations WHERE id = 'm001-owner-and-backfill'`).get()).toBeUndefined();
    const p = d.prepare(`SELECT user_id FROM projects WHERE id = 'legacy-1'`).get() as { user_id: string | null };
    expect(p.user_id).toBeNull();
  });

  it('с OWNER_TELEGRAM_ID создаёт владельца и присваивает ему все легаси-строки', () => {
    const d = freshDb();
    d.prepare(`INSERT INTO projects (id, title) VALUES ('legacy-1', 't')`).run();
    d.prepare(`INSERT INTO generations (id, project_id, version) VALUES ('g1', 'legacy-1', 1)`).run();
    d.prepare(`INSERT INTO usage_events (id, project_id, task, model) VALUES ('u1', 'legacy-1', 'analyze', 'm')`).run();
    d.prepare(`INSERT INTO usage_events (id, project_id, task, model) VALUES ('u2', NULL, 'analyze', 'm')`).run();

    runDataMigrations(d, { ownerTelegramId: '777' });

    const owner = d.prepare(`SELECT id, role FROM users WHERE telegram_id = 777`).get() as { id: string; role: string };
    expect(owner.role).toBe('owner');
    const p = d.prepare(`SELECT user_id FROM projects WHERE id = 'legacy-1'`).get() as { user_id: string };
    expect(p.user_id).toBe(owner.id);
    const g = d.prepare(`SELECT user_id FROM generations WHERE id = 'g1'`).get() as { user_id: string };
    expect(g.user_id).toBe(owner.id);
    const u1 = d.prepare(`SELECT user_id FROM usage_events WHERE id = 'u1'`).get() as { user_id: string };
    const u2 = d.prepare(`SELECT user_id FROM usage_events WHERE id = 'u2'`).get() as { user_id: string };
    expect(u1.user_id).toBe(owner.id);
    expect(u2.user_id).toBe(owner.id); // сирота от удалённого проекта — тоже владельцу

    // идемпотентность: второй прогон — no-op
    runDataMigrations(d, { ownerTelegramId: '777' });
    expect((d.prepare(`SELECT COUNT(*) AS c FROM users`).get() as { c: number }).c).toBe(1);
  });

  it('существующий юзер с owner-telegram_id повышается до owner, не дублируется', () => {
    const d = freshDb();
    d.prepare(`INSERT INTO users (id, telegram_id, role) VALUES ('u-x', 777, 'user')`).run();
    const id = ensureOwnerUser(d, '777');
    expect(id).toBe('u-x');
    const row = d.prepare(`SELECT role FROM users WHERE id = 'u-x'`).get() as { role: string };
    expect(row.role).toBe('owner');
  });

  it('кривой OWNER_TELEGRAM_ID = громкая ошибка, не тихий мусор', () => {
    const d = freshDb();
    expect(() => runDataMigrations(d, { ownerTelegramId: 'не-число' })).toThrow(/OWNER_TELEGRAM_ID/);
  });
});
