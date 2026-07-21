// Auth-роуты: вход через Telegram Login Widget (data-onauth POST-ит payload сюда),
// logout, /api/me. Дев-вход без Telegram — только за AUTH_DEV_BYPASS (в prod бут падает).
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { getDb } from '../db';
import { rateLimit } from '../rateLimit';
import { clearCookies, loginCookies, mintCsrfValue, parseCookies, SESSION_COOKIE } from './cookies';
import { createSession, destroySession, type SessionUser } from './sessions';
import { verifyTelegramLogin, type TgAuthPayload } from './telegram';
import { consumeTelegramLoginHash } from './telegram-replay';

interface DbUser {
  id: string;
  telegram_id: number;
  tg_username: string;
  tg_first_name: string;
  tg_photo_url: string;
  role: string;
  status: string;
  sandbox_of?: string | null;
}

/** Upsert по telegram_id: профиль (ник/имя/фото) освежается на каждом входе. */
function upsertTgUser(p: TgAuthPayload): DbUser {
  const d = getDb();
  const username = (p.username ?? '').slice(0, 64);
  const firstName = (p.first_name ?? '').slice(0, 128);
  const photo = (p.photo_url ?? '').slice(0, 500);
  const existing = d.prepare(`SELECT * FROM users WHERE telegram_id = ?`).get(p.id) as
    | DbUser
    | undefined;
  if (existing) {
    d.prepare(
      `UPDATE users SET tg_username = ?, tg_first_name = ?, tg_photo_url = ?, last_login_at = datetime('now') WHERE id = ?`,
    ).run(username, firstName, photo, existing.id);
    return { ...existing, tg_username: username, tg_first_name: firstName, tg_photo_url: photo };
  }
  const id = randomUUID();
  const role = config.ownerTelegramId && Number(config.ownerTelegramId) === p.id ? 'owner' : 'user';
  d.prepare(
    `INSERT INTO users (id, telegram_id, tg_username, tg_first_name, tg_photo_url, role, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(id, p.id, username, firstName, photo, role);
  return {
    id,
    telegram_id: p.id,
    tg_username: username,
    tg_first_name: firstName,
    tg_photo_url: photo,
    role,
    status: 'active',
  };
}

function toAuthUser(u: DbUser): SessionUser {
  return {
    id: u.id,
    telegramId: u.telegram_id,
    username: u.tg_username,
    firstName: u.tg_first_name,
    photoUrl: u.tg_photo_url,
    role: u.role === 'owner' ? 'owner' : 'user',
    sandbox: !!u.sandbox_of,
  };
}

function issueSession(u: DbUser): { cookies: string[]; user: SessionUser } {
  const { token } = createSession(u.id);
  return { cookies: loginCookies(token, mintCsrfValue()), user: toAuthUser(u) };
}

export function registerAuthRoutes(app: FastifyInstance): void {
  const loginLimiter = rateLimit(20, 15 * 60_000);

  app.post('/api/auth/telegram', { preHandler: loginLimiter }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const verdict = verifyTelegramLogin(body, config.telegramBotToken);
    if (!verdict.ok) {
      req.log.warn({ reason: verdict.reason }, 'tg-login отклонён');
      return reply.code(401).send({ error: 'Подпись Telegram не подтвердилась — попробуй войти ещё раз' });
    }
    const loginHash = String(body.hash);
    const authDate = Number(body.auth_date);
    if (!consumeTelegramLoginHash(loginHash, authDate)) {
      return reply.code(409).send({ error: 'Эта ссылка входа уже использована — открой вход через Telegram ещё раз' });
    }
    const u = upsertTgUser(body as unknown as TgAuthPayload);
    if (u.status !== 'active') {
      return reply.code(403).send({ error: 'Аккаунт заблокирован' });
    }
    const { cookies, user } = issueSession(u);
    reply.header('Set-Cookie', cookies);
    return { user };
  });

  // Дев-вход: localhost нельзя привязать в BotFather. В prod бут с этим флагом падает
  // (assertAuthConfig), плюс страховка здесь же.
  app.post('/api/auth/dev-login', { preHandler: loginLimiter }, async (req, reply) => {
    if (!config.devAuthBypass || config.isProduction) {
      return reply.code(404).send({ error: 'not found' });
    }
    const body = (req.body ?? {}) as { telegramId?: number; name?: string };
    const tgId = Number(body.telegramId ?? 1);
    if (!Number.isFinite(tgId) || tgId <= 0) return reply.code(400).send({ error: 'telegramId?' });
    const u = upsertTgUser({
      id: tgId,
      first_name: body.name ?? `dev-${tgId}`,
      auth_date: Math.floor(Date.now() / 1000),
      hash: '',
    });
    if (u.status !== 'active') return reply.code(403).send({ error: 'Аккаунт заблокирован' });
    const { cookies, user } = issueSession(u);
    reply.header('Set-Cookie', cookies);
    return { user };
  });

  // ── Тест-клиент владельца ────────────────────────────────────────────────
  // Владелец переключается в НАСТОЯЩЕГО metered-юзера (цены/резервы/оплата — как у
  // клиента) и обратно. Синтетический telegram_id = -ownerTelegramId: отрицательные
  // id из настоящего Telegram не приходят — коллизий нет. ВАЖНО: сессия тест-клиента
  // по силе эквивалентна владельческой (из неё есть выход обратно) — храним как owner.

  app.post('/api/auth/test-client', async (req, reply) => {
    if (req.user?.role !== 'owner') return reply.code(403).send({ error: 'Доступно только владельцу сервиса' });
    const d = getDb();
    const syntheticTgId = -Math.abs(req.user.telegramId);
    let sandbox = d.prepare(`SELECT * FROM users WHERE telegram_id = ?`).get(syntheticTgId) as
      | DbUser
      | undefined;
    if (!sandbox) {
      const id = randomUUID();
      d.prepare(
        `INSERT INTO users (id, telegram_id, tg_username, tg_first_name, role, sandbox_of, last_login_at)
         VALUES (?, ?, '', 'Тест-клиент', 'user', ?, datetime('now'))`,
      ).run(id, syntheticTgId, req.user.id);
      sandbox = d.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as unknown as DbUser;
    } else if (!sandbox.sandbox_of) {
      return reply.code(409).send({ error: 'Аккаунт тест-клиента повреждён — обратись к логам' });
    }
    if (sandbox.status !== 'active') return reply.code(409).send({ error: 'Тест-клиент заблокирован' });
    // Текущую owner-сессию гасим: одна кука — одна живая сессия, без «хвостов»
    const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? '';
    destroySession(raw);
    const { cookies, user } = issueSession(sandbox);
    reply.header('Set-Cookie', cookies);
    return { user };
  });

  app.post('/api/auth/test-client/exit', async (req, reply) => {
    if (!req.user?.sandbox) return reply.code(403).send({ error: 'Ты не в режиме тест-клиента' });
    const d = getDb();
    const sandboxRow = d.prepare(`SELECT sandbox_of FROM users WHERE id = ?`).get(req.user.id) as
      | { sandbox_of: string | null }
      | undefined;
    const owner = sandboxRow?.sandbox_of
      ? (d.prepare(`SELECT * FROM users WHERE id = ?`).get(sandboxRow.sandbox_of) as DbUser | undefined)
      : undefined;
    if (!owner || owner.role !== 'owner' || owner.status !== 'active') {
      return reply.code(409).send({ error: 'Владелец недоступен — войди через Telegram заново' });
    }
    const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? '';
    destroySession(raw);
    const { cookies, user } = issueSession(owner);
    reply.header('Set-Cookie', cookies);
    return { user };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    // Кросс-сайтовый разлогин — мелкое неудобство, но отбиваем как остальные мутации
    const site = req.headers['sec-fetch-site'];
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'same-site' && site !== 'none') {
      return reply.code(403).send({ error: 'Кросс-сайтовый запрос отклонён' });
    }
    const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? '';
    destroySession(raw);
    reply.header('Set-Cookie', clearCookies());
    return { ok: true };
  });

  app.get('/api/me', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Требуется вход через Telegram' });
    const counts = getDb()
      .prepare(`SELECT COUNT(*) AS projects FROM projects WHERE user_id = ?`)
      .get(req.user.id) as { projects: number };
    return { user: req.user, counts: { projects: counts.projects } };
  });
}
