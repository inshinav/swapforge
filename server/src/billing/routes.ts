// Биллинг-роуты. Вебхук Tribute живёт в СВОЁМ encapsulated-scope с buffer-парсером:
// HMAC считается по сырым байтам тела, не по перепакованному JSON. Его auth —
// подпись, поэтому он в PUBLIC_API_PATHS (без сессии/CSRF); в nginx нужна локация
// с auth_basic off (серверы Tribute не пройдут basic auth) — см. deploy/nginx-swapforge.conf.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { config } from '../config';
import { getDb } from '../db';
import { requireOwner } from '../auth/middleware';
import {
  adjustCredits,
  applyRefund,
  creditBalance,
  grantPurchase,
  listLedger,
} from './credits';
import { listPacks, matchPack } from './packs';
import { parseTributeEvent, verifyTributeSignature } from './tribute';

function bad(reply: FastifyReply, code: number, msg: string) {
  return reply.code(code).send({ error: msg });
}

export function registerBillingRoutes(app: FastifyInstance): void {
  app.get('/api/billing/balance', async (req) => creditBalance(req.user!.id));

  app.get('/api/billing/ledger', async (req) => {
    return { entries: listLedger(req.user!.id, 100) };
  });

  app.get('/api/billing/packs', async () => {
    return listPacks().map((p) => ({
      id: p.id,
      title: p.title,
      credits: p.credits,
      priceLabel: p.priceLabel,
      url: p.url,
    }));
  });

  // Ручная корректировка владельцем: разбор неопознанных платежей/споров
  app.post('/api/billing/adjust', { preHandler: requireOwner }, async (req, reply) => {
    const body = (req.body ?? {}) as { userId?: string; telegramId?: number; delta?: number; note?: string };
    let userId = body.userId ?? null;
    if (!userId && body.telegramId) {
      const u = getDb().prepare(`SELECT id FROM users WHERE telegram_id = ?`).get(body.telegramId) as
        | { id: string }
        | undefined;
      userId = u?.id ?? null;
    }
    if (!userId || typeof body.delta !== 'number' || !Number.isFinite(body.delta) || body.delta === 0) {
      return bad(reply, 400, 'нужны userId (или telegramId) и delta ≠ 0');
    }
    if (!getDb().prepare(`SELECT 1 FROM users WHERE id = ?`).get(userId)) {
      return bad(reply, 404, 'Пользователь не найден');
    }
    adjustCredits(userId, body.delta, body.note ?? 'ручная корректировка владельцем');
    return { ok: true, balance: creditBalance(userId) };
  });

  // Вебхук — отдельный scope: свой content-parser (raw buffer) не задевает остальное API
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

    scope.post('/api/billing/tribute/webhook', async (req, reply) => {
      if (!config.tributeApiKey) {
        return bad(reply, 503, 'billing not configured');
      }
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''));
      const sig = req.headers['trbt-signature'];
      if (typeof sig !== 'string' || !verifyTributeSignature(raw, sig, config.tributeApiKey)) {
        req.log.warn('tribute-webhook: подпись не сошлась');
        return bad(reply, 403, 'bad signature');
      }

      const ev = parseTributeEvent(raw);
      if (ev.kind === 'invalid') {
        req.log.warn({ reason: ev.reason }, 'tribute-webhook: невалидное событие');
        return bad(reply, 400, 'bad payload');
      }
      if (ev.kind === 'ignored') {
        return { ok: true, ignored: ev.name }; // подписки/донаты и прочее — не наш сценарий
      }

      const user = getDb()
        .prepare(`SELECT id FROM users WHERE telegram_id = ?`)
        .get(ev.telegramUserId ?? -1) as { id: string } | undefined;

      if (ev.kind === 'purchase') {
        if (!user) {
          // Платёж от незарегистрированного TG-аккаунта: не теряем деньги молча —
          // 200 (чтобы Tribute не ретраил вечно) + громкий лог для ручного разбора
          console.error(
            `[tribute] платёж от НЕЗАРЕГИСТРИРОВАННОГО tg=${ev.telegramUserId} ref=${ev.paymentRef} amount=${ev.amountMinor} ${ev.currency} — начисли руками через /api/billing/adjust`,
          );
          return { ok: true, unmatchedUser: true };
        }
        const pack = matchPack(ev.productId, ev.amountMinor, ev.currency);
        if (!pack) {
          console.error(
            `[tribute] НЕОПОЗНАННЫЙ продукт product_id=${ev.productId} amount=${ev.amountMinor} ${ev.currency} ref=${ev.paymentRef} user=${user.id} — проверь SWAPFORGE_PACKS_JSON и доначисли руками`,
          );
          adjustCredits(user.id, 0, `неопознанный платёж Tribute ${ev.paymentRef} (${ev.amountMinor} ${ev.currency})`);
          return { ok: true, unmatchedPack: true };
        }
        const res = grantPurchase(user.id, pack.credits, ev.paymentRef, `пакет «${pack.title}» (${ev.paymentRef})`);
        req.log.info({ user: user.id, pack: pack.id, res }, 'tribute-webhook: покупка');
        return { ok: true, result: res };
      }

      // refund
      if (!user) {
        console.error(`[tribute] рефанд от неизвестного tg=${ev.telegramUserId} ref=${ev.paymentRef}`);
        return { ok: true, unmatchedUser: true };
      }
      const pack = matchPack(ev.productId, ev.amountMinor, ev.currency);
      const credits = pack?.credits ?? 0;
      if (credits === 0) {
        console.error(`[tribute] рефанд без опознанного пакета ref=${ev.paymentRef} — спиши руками`);
        adjustCredits(user.id, 0, `неопознанный рефанд Tribute ${ev.paymentRef}`);
        return { ok: true, unmatchedPack: true };
      }
      const res = applyRefund(user.id, credits, ev.paymentRef, `рефанд пакета (${ev.paymentRef})`);
      req.log.info({ user: user.id, res }, 'tribute-webhook: рефанд');
      return { ok: true, result: res };
    });
  });
}
