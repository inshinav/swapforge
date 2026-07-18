// Проверка подписи Telegram Login Widget — чистая функция на node:crypto.
// Схема из доков Telegram: secret = SHA256(bot_token); data_check_string = все поля
// кроме hash, отсортированные по ключу, «key=value» через \n; подпись = HMAC-SHA256.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface TgAuthPayload {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

/** Свежесть подписи: сутки. Виджет отдаёт auth_date момента входа. */
export const TG_AUTH_MAX_AGE_MS = 24 * 3_600_000;
/** Допуск на рассинхрон часов (auth_date «из будущего»). */
const CLOCK_SKEW_MS = 5 * 60_000;

export type TgVerifyResult = { ok: true; tgId: number } | { ok: false; reason: string };

export function verifyTelegramLogin(
  payload: unknown,
  botToken: string,
  nowMs = Date.now(),
): TgVerifyResult {
  if (!botToken) return { ok: false, reason: 'bot_token_missing' };
  if (typeof payload !== 'object' || payload === null) return { ok: false, reason: 'bad_payload' };
  const p = payload as Record<string, unknown>;
  const hash = p.hash;
  const id = p.id;
  const authDate = p.auth_date;
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: 'bad_hash' };
  if (typeof id !== 'number' || !Number.isFinite(id) || id <= 0) return { ok: false, reason: 'bad_id' };
  if (typeof authDate !== 'number' || !Number.isFinite(authDate)) {
    return { ok: false, reason: 'bad_auth_date' };
  }

  // data_check_string строится из ФАКТИЧЕСКИ присланных полей (undefined/null не участвуют)
  const dataCheck = Object.keys(p)
    .filter((k) => k !== 'hash' && p[k] !== undefined && p[k] !== null)
    .sort()
    .map((k) => `${k}=${String(p[k])}`)
    .join('\n');
  const secret = createHash('sha256').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheck).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };

  const ageMs = nowMs - authDate * 1000;
  if (ageMs > TG_AUTH_MAX_AGE_MS) return { ok: false, reason: 'stale' };
  if (ageMs < -CLOCK_SKEW_MS) return { ok: false, reason: 'from_future' };
  return { ok: true, tgId: id };
}
