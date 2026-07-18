// Fastify-хуки авторизации. attachAuth вешается на onRequest уровня приложения,
// requireApiAuth — default-deny для /api/* с явным allowlist публичных путей:
// новый роут защищён по умолчанию, а не «если не забыли добавить гвард».
import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, parseCookies } from './cookies';
import { authenticateSession, type SessionUser } from './sessions';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

/** Публичные /api/*-пути: auth-вход + минимальный health. Вебхуки/legal добавятся этапами. */
export const PUBLIC_API_PATHS = new Set<string>([
  '/api/health',
  '/api/auth/telegram',
  '/api/auth/dev-login',
  // logout чистит СВОЮ httpOnly-cookie — работает и с протухшей сессией
  '/api/auth/logout',
]);

export function attachAuth(req: FastifyRequest, _reply: FastifyReply, done: () => void): void {
  const cookies = parseCookies(req.headers.cookie);
  req.user = authenticateSession(cookies[SESSION_COOKIE] ?? '');
  done();
}

/** Double-submit CSRF: cookie sf_csrf обязан совпасть с заголовком x-sf-csrf. */
export function verifyCsrf(req: FastifyRequest): boolean {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true;
  const cookieVal = parseCookies(req.headers.cookie)[CSRF_COOKIE] ?? '';
  const headerVal = req.headers[CSRF_HEADER];
  if (!cookieVal || typeof headerVal !== 'string' || !headerVal) return false;
  const a = Buffer.from(cookieVal);
  const b = Buffer.from(headerVal);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Default-deny для API: всё под сессией + CSRF на мутациях, кроме allowlist.
 * Статика/SPA (не /api/) проходит свободно — секретов в билде фронта нет.
 */
export async function requireApiAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const url = (req.raw.url ?? req.url).split('?')[0]!;
  if (!url.startsWith('/api/')) return;
  if (PUBLIC_API_PATHS.has(url)) return;
  if (!req.user) {
    return reply.code(401).send({ error: 'Требуется вход через Telegram' });
  }
  if (!verifyCsrf(req)) {
    return reply.code(403).send({ error: 'CSRF-проверка не пройдена — перезагрузи страницу' });
  }
}

export function requireOwner(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
  if (req.user?.role !== 'owner') {
    reply.code(403).send({ error: 'Доступно только владельцу сервиса' });
    return;
  }
  done();
}
