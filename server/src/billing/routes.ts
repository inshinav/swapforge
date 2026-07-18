// Биллинг-роуты, провайдер-нейтральные. Server-initiated checkout: сервер сам
// создаёт инвойс у выбранного провайдера (Crypto Pay / Lava.top) и кладёт НАШ
// userId+packId в round-trip канал → вебхук возвращает их обратно. Вебхуки живут в
// encapsulated-scope с raw-buffer парсером (подпись/секрет считаются по сырому телу).
import type { FastifyInstance, FastifyReply } from 'fastify';
import { getDb } from '../db';
import { requireOwner } from '../auth/middleware';
import { rateLimit } from '../rateLimit';
import { adjustCredits, creditBalance, grantPurchase, listLedger } from './credits';
import { getPack, listPacks } from './packs';
import { getProvider, readyProviders } from './provider';

function bad(reply: FastifyReply, code: number, msg: string) {
  return reply.code(code).send({ error: msg });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function registerBillingRoutes(app: FastifyInstance): void {
  app.get('/api/billing/balance', async (req) => creditBalance(req.user!.id));

  app.get('/api/billing/ledger', async (req) => {
    return { entries: listLedger(req.user!.id, 100) };
  });

  // Пакеты + какие способы оплаты доступны (клиент рисует нужные кнопки/форму email)
  app.get('/api/billing/packs', async () => {
    const providers = readyProviders();
    return {
      providers: providers.map((p) => ({ id: p.id, needsEmail: p.needsEmail })),
      packs: listPacks().map((p) => ({
        id: p.id,
        title: p.title,
        credits: p.credits,
        priceLabel: p.priceLabel,
        // какими провайдерами этот пакт реально оплачивается (задан offer/цена)
        pay: providers
          .filter((pr) => (pr.id === 'cryptopay' ? !!p.cryptoAmount : !!p.lavaOfferId))
          .map((pr) => pr.id),
      })),
    };
  });

  // Server-initiated: создать инвойс у провайдера и вернуть ссылку на оплату.
  // Рейт-лимит: каждый вызов делает исходящий createInvoice к провайдеру.
  const checkoutLimiter = rateLimit(20, 5 * 60_000);
  app.post('/api/billing/checkout', { preHandler: checkoutLimiter }, async (req, reply) => {
    const body = (req.body ?? {}) as { packId?: string; provider?: string; email?: string };
    const provider = getProvider(body.provider ?? '');
    if (!provider || !provider.ready) return bad(reply, 400, 'Способ оплаты недоступен');
    const pack = getPack(body.packId ?? '');
    if (!pack) return bad(reply, 404, 'Пакет не найден');

    let email = (body.email ?? '').trim();
    if (provider.needsEmail) {
      // берём сохранённый email профиля, если новый не прислали
      if (!email) {
        const u = getDb().prepare(`SELECT email FROM users WHERE id = ?`).get(req.user!.id) as
          | { email: string | null }
          | undefined;
        email = (u?.email ?? '').trim();
      }
      if (!EMAIL_RE.test(email)) return bad(reply, 400, 'Нужен корректный email для оплаты картой');
      getDb().prepare(`UPDATE users SET email = ? WHERE id = ?`).run(email.slice(0, 200), req.user!.id);
    }

    try {
      const { payUrl } = await provider.createCheckout({ userId: req.user!.id, pack, email });
      return { payUrl };
    } catch (e) {
      req.log.error({ err: e instanceof Error ? e.message : e }, 'checkout не удался');
      return bad(reply, 502, 'Не удалось создать счёт — попробуй позже');
    }
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

  // Вебхуки провайдеров — свой scope с raw-buffer парсером (подпись по сырому телу)
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

    scope.post('/api/billing/webhook/:provider', async (req, reply) => {
      const { provider: providerId } = req.params as { provider: string };
      const provider = getProvider(providerId);
      if (!provider || !provider.ready) return bad(reply, 404, 'unknown provider');
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''));

      if (!provider.verifyWebhook(raw, req.headers)) {
        req.log.warn({ provider: providerId }, 'webhook: подпись/секрет не сошлись');
        return bad(reply, 403, 'bad signature');
      }

      const ev = provider.parseWebhook(raw);
      if (ev.kind === 'invalid') {
        req.log.warn({ provider: providerId, reason: ev.reason }, 'webhook: невалидное событие');
        return bad(reply, 400, 'bad payload');
      }
      if (ev.kind === 'ignored') return { ok: true, ignored: ev.reason };

      // userId мы сами положили в инвойс — проверяем, что он жив
      const user = getDb().prepare(`SELECT id FROM users WHERE id = ?`).get(ev.userId) as
        | { id: string }
        | undefined;
      const pack = getPack(ev.packId);
      if (!user || !pack) {
        // деньги не теряем молча: 200 (провайдер не ретраит вечно) + громкий лог
        console.error(
          `[billing:${providerId}] платёж ${ev.paymentRef} без юзера/пакета (user=${ev.userId} pack=${ev.packId}) — разберись через /api/billing/adjust`,
        );
        return { ok: true, unmatched: true };
      }

      // Defense-in-depth: если провайдер сообщил сумму — сверяем с ценой пакета
      // (защита от рассинхрона SWAPFORGE_PACKS_JSON при «висящем» старом инвойсе).
      // Актив тоже должен совпасть, иначе 3 USDT != 3 TON. Недоплата → не начисляем.
      if (providerId === 'cryptopay' && typeof ev.paidAmount === 'number' && pack.cryptoAmount) {
        const assetOk = !ev.paidAsset || ev.paidAsset === (pack.cryptoAsset ?? 'USDT');
        if (!assetOk || ev.paidAmount + 1e-9 < pack.cryptoAmount) {
          console.error(
            `[billing:${providerId}] сумма/актив не совпали для ${ev.paymentRef}: оплачено ${ev.paidAmount} ${ev.paidAsset}, ожидалось ${pack.cryptoAmount} ${pack.cryptoAsset ?? 'USDT'} — не начисляю, разберись руками`,
          );
          adjustCredits(user.id, 0, `недоплата/несовпадение ${ev.paymentRef} (${ev.paidAmount} ${ev.paidAsset})`);
          return { ok: true, unmatched: true };
        }
      }

      const res = grantPurchase(
        user.id,
        pack.credits,
        ev.paymentRef,
        `пакет «${pack.title}» через ${providerId} (${ev.paymentRef})`,
      );
      req.log.info({ provider: providerId, user: user.id, pack: pack.id, res }, 'webhook: покупка');
      return { ok: true, result: res };
    });
  });
}
