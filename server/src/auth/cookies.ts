// Cookie-слой без зависимостей: ручной парсинг + ручная сериализация Set-Cookie.
// Пара сессия+CSRF (double-submit): sf_sess httpOnly, sf_csrf читается JS-ом и
// возвращается заголовком x-sf-csrf на каждой мутации.
import { randomBytes } from 'node:crypto';
import { config } from '../config';
import { SESSION_TTL_MS } from './sessions';

export const SESSION_COOKIE = 'sf_sess';
export const CSRF_COOKIE = 'sf_csrf';
export const CSRF_HEADER = 'x-sf-csrf';

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

interface CookieOpts {
  httpOnly: boolean;
  maxAgeSec: number;
}

function serialize(name: string, value: string, opts: CookieOpts): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${config.cookiePath}`,
    `Max-Age=${opts.maxAgeSec}`,
    'SameSite=Lax',
  ];
  if (opts.httpOnly) parts.push('HttpOnly');
  if (config.isProduction) parts.push('Secure');
  return parts.join('; ');
}

export function mintCsrfValue(): string {
  return randomBytes(24).toString('base64url');
}

/** Пара Set-Cookie для логина: сессия (httpOnly) + CSRF (JS-читаемый). */
export function loginCookies(sessionToken: string, csrfValue: string): string[] {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return [
    serialize(SESSION_COOKIE, sessionToken, { httpOnly: true, maxAgeSec: maxAge }),
    serialize(CSRF_COOKIE, csrfValue, { httpOnly: false, maxAgeSec: maxAge }),
  ];
}

export function clearCookies(): string[] {
  return [
    serialize(SESSION_COOKIE, '', { httpOnly: true, maxAgeSec: 0 }),
    serialize(CSRF_COOKIE, '', { httpOnly: false, maxAgeSec: 0 }),
  ];
}
