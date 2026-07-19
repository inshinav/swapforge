// Биллинг-роуты, провайдер-нейтральные. Server-initiated checkout: сервер сам
// создаёт инвойс у выбранного провайдера (Crypto Pay / Lava.top) и кладёт НАШ
// userId+сумму в round-trip канал → вебхук возвращает их обратно. Вебхуки живут в
// encapsulated-scope с raw-buffer парсером (подпись/секрет считаются по сырому телу).
import type { FastifyInstance, FastifyReply } from 'fastify';
import { getDb } from '../db';
import { requireOwner } from '../auth/middleware';
import { byUserOrIp, rateLimit } from '../rateLimit';
import { config } from '../config';
import { adjustCredits, creditBalance, grantPurchase, listLedger } from './credits';
import { getPack } from './packs';
import { getProvider, readyProviders } from './provider';

function bad(reply: FastifyReply, code: number, msg: string) {
  return reply.code(code).send({ error: msg });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TG_USERNAME_RE = /^[A-Za-z0-9_]{5,32}$/;
const MANUAL_REQUEST_RE = /^[A-Za-z0-9_-]{16,80}$/;
const MAX_MANUAL_TOPUP_CENTS = 1_000_000;
const usd = (cents: number): number => Math.round(cents) / 100;

interface ManualBillingUserRow {
  id: string;
  telegram_id: number;
  tg_username: string;
  tg_first_name: string;
  role: string;
  status: string;
}

function publicBalance(userId: string) {
  const b = creditBalance(userId);
  return { balanceUsd: usd(b.balance), heldUsd: usd(b.held), availableUsd: usd(b.available) };
}

function topupCents(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const cents = Math.round(raw * 100);
  if (Math.abs(raw * 100 - cents) > 1e-7) return null;
  const min = Math.round(config.minTopupUsd * 100);
  const max = Math.round(config.maxTopupUsd * 100);
  return cents >= min && cents <= max ? cents : null;
}

function manualTopupCents(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const cents = Math.round(raw * 100);
  if (Math.abs(raw * 100 - cents) > 1e-7) return null;
  return cents > 0 && cents <= MAX_MANUAL_TOPUP_CENTS ? cents : null;
}

function manualUser(user: ManualBillingUserRow) {
  return {
    id: user.id,
    telegramId: user.telegram_id,
    username: user.tg_username,
    firstName: user.tg_first_name,
    balance: publicBalance(user.id),
  };
}

export function registerBillingRoutes(app: FastifyInstance): void {
  app.get('/api/billing/balance', async (req) => publicBalance(req.user!.id));

  app.get('/api/billing/ledger', async (req) => {
    return {
      entries: listLedger(req.user!.id, 100).map((e) => ({
        id: e.id,
        deltaUsd: usd(e.delta),
        kind: e.kind,
        note: e.note,
        createdAt: e.createdAt,
      })),
    };
  });

  // Оставляем URL /packs для совместимости клиента, но пакетов в продукте больше нет.
  app.get('/api/billing/packs', async () => {
    return {
      minTopupUsd: config.minTopupUsd,
      maxTopupUsd: config.maxTopupUsd,
      providers: readyProviders().map((p) => ({
        id: p.id,
        needsEmail: p.needsEmail,
        ...(p.id === 'lavatop' ? { rubPerUsd: config.lavaRubPerUsd } : {}),
      })),
    };
  });

  // Server-initiated: создать инвойс у провайдера и вернуть ссылку на оплату.
  // Рейт-лимит: каждый вызов делает исходящий createInvoice к провайдеру.
  // У авторизованного checkout лимит персональный: общий NAT/IP не связывает клиентов.
  const checkoutLimiter = rateLimit(20, 5 * 60_000, byUserOrIp);
  app.post('/api/billing/checkout', { preHandler: checkoutLimiter }, async (req, reply) => {
    const body = (req.body ?? {}) as { amountUsd?: number; provider?: string; email?: string };
    const provider = getProvider(body.provider ?? '');
    if (!provider || !provider.ready) return bad(reply, 400, 'Способ оплаты недоступен');
    const amountCents = topupCents(body.amountUsd);
    if (amountCents === null) {
      return bad(reply, 400, `Укажи сумму от $${config.minTopupUsd} до $${config.maxTopupUsd}, не больше 2 знаков после точки`);
    }

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
      const { payUrl } = await provider.createCheckout({ userId: req.user!.id, amountUsd: usd(amountCents), email });
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

  // Простое ручное пополнение после перевода владельцу напрямую: сначала ищем точный
  // Telegram username, затем начисляем по стабильному userId. requestId защищает от
  // двойного клика/повтора запроса, а запись остаётся в общем append-only ledger.
  app.get('/api/billing/manual-user', { preHandler: requireOwner }, async (req, reply) => {
    const raw = String((req.query as { username?: unknown }).username ?? '').trim();
    const username = raw.replace(/^@/, '');
    if (!TG_USERNAME_RE.test(username)) {
      return bad(reply, 400, 'Введи Telegram-ник без ссылки, например @username');
    }
    const rows = getDb()
      .prepare(
        `SELECT id, telegram_id, tg_username, tg_first_name, role, status
           FROM users WHERE lower(tg_username) = lower(?)`,
      )
      .all(username) as unknown as ManualBillingUserRow[];
    if (rows.length === 0) {
      return bad(reply, 404, 'Пользователь не найден — сначала он должен войти в SwapForge через Telegram');
    }
    if (rows.length > 1) {
      return bad(reply, 409, 'Ник найден у нескольких аккаунтов — попроси пользователя заново войти через Telegram');
    }
    const user = rows[0]!;
    if (user.role === 'owner') return bad(reply, 400, 'Владельцу баланс не требуется');
    if (user.status !== 'active') return bad(reply, 409, 'Аккаунт пользователя заблокирован');
    return { user: manualUser(user) };
  });

  app.post('/api/billing/manual-topup', { preHandler: requireOwner }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      userId?: unknown;
      amountUsd?: unknown;
      note?: unknown;
      requestId?: unknown;
    };
    const userId = typeof body.userId === 'string' ? body.userId : '';
    const requestId = typeof body.requestId === 'string' ? body.requestId : '';
    const amountCents = manualTopupCents(body.amountUsd);
    if (!userId || amountCents === null) {
      return bad(reply, 400, 'Укажи сумму от $0.01 до $10 000, не больше 2 знаков после точки');
    }
    if (!MANUAL_REQUEST_RE.test(requestId)) return bad(reply, 400, 'Некорректный requestId');

    const user = getDb()
      .prepare(
        `SELECT id, telegram_id, tg_username, tg_first_name, role, status FROM users WHERE id = ?`,
      )
      .get(userId) as ManualBillingUserRow | undefined;
    if (!user) return bad(reply, 404, 'Пользователь не найден');
    if (user.role === 'owner') return bad(reply, 400, 'Владельцу баланс не требуется');
    if (user.status !== 'active') return bad(reply, 409, 'Аккаунт пользователя заблокирован');

    const ownerLabel = req.user!.username ? `@${req.user!.username}` : `Telegram ID ${req.user!.telegramId}`;
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 180) : '';
    const ledgerNote = `Ручное пополнение владельцем ${ownerLabel}${note ? `: ${note}` : ''}`;
    const result = adjustCredits(user.id, amountCents, ledgerNote, `manual:${user.id}:${requestId}`);
    return {
      ok: true,
      replayed: result === 'replay',
      user: manualUser(user),
    };
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
      const legacyPack = ev.packId ? getPack(ev.packId) : null;
      const expectedCents = ev.amountCents ?? legacyPack?.credits ?? null;
      const amountValid = ev.amountCents === undefined || topupCents(ev.amountCents / 100) === ev.amountCents;
      if (!user || expectedCents === null || !amountValid) {
        // деньги не теряем молча: 200 (провайдер не ретраит вечно) + громкий лог
        console.error(
          `[billing:${providerId}] платёж ${ev.paymentRef} без юзера/суммы (user=${ev.userId} amount=${ev.amountCents} pack=${ev.packId}) — разберись через /api/billing/adjust`,
        );
        return { ok: true, unmatched: true };
      }

      // Defense-in-depth: если провайдер сообщил сумму — сверяем с ценой пакета
      // (защита от рассинхрона SWAPFORGE_PACKS_JSON при «висящем» старом инвойсе).
      // Актив тоже должен совпасть, иначе 3 USDT != 3 TON. Недоплата → не начисляем.
      if (legacyPack && providerId === 'cryptopay' && typeof ev.paidAmount === 'number' && legacyPack.cryptoAmount) {
        const assetOk = !ev.paidAsset || ev.paidAsset === (legacyPack.cryptoAsset ?? 'USDT');
        if (!assetOk || ev.paidAmount + 1e-9 < legacyPack.cryptoAmount) {
          console.error(
            `[billing:${providerId}] сумма/актив не совпали для ${ev.paymentRef}: оплачено ${ev.paidAmount} ${ev.paidAsset}, ожидалось ${legacyPack.cryptoAmount} ${legacyPack.cryptoAsset ?? 'USDT'} — не начисляю, разберись руками`,
          );
          adjustCredits(user.id, 0, `недоплата/несовпадение ${ev.paymentRef} (${ev.paidAmount} ${ev.paidAsset})`);
          return { ok: true, unmatched: true };
        }
      }

      if (!legacyPack) {
        const isLavaRub = providerId === 'lavatop';
        const paidMinor = isLavaRub
          ? typeof ev.paidAmount === 'number' && Number.isFinite(ev.paidAmount)
            ? Math.round(ev.paidAmount * 100)
            : null
          : typeof ev.paidAmountUsd === 'number' && Number.isFinite(ev.paidAmountUsd)
            ? Math.round(ev.paidAmountUsd * 100)
            : null;
        const expectedMinor = isLavaRub ? ev.expectedPaidAmountMinor ?? null : expectedCents;
        const expectedCurrency = isLavaRub ? 'RUB' : 'USD';
        const currencyOk = ev.paidCurrency === expectedCurrency;
        if (expectedMinor === null || !currencyOk || paidMinor === null || paidMinor < expectedMinor) {
          const expectedLabel = expectedMinor === null
            ? `неизвестная сумма ${expectedCurrency}`
            : isLavaRub
              ? `${(expectedMinor / 100).toFixed(2)} RUB`
              : `$${usd(expectedCents).toFixed(2)}`;
          console.error(
            `[billing:${providerId}] сумма не совпала для ${ev.paymentRef}: оплачено ${isLavaRub ? ev.paidAmount : ev.paidAmountUsd} ${ev.paidCurrency}, ожидалось ${expectedLabel} — не начисляю`,
          );
          return { ok: true, unmatched: true };
        }
      }

      const res = grantPurchase(
        user.id,
        expectedCents,
        ev.paymentRef,
        legacyPack
          ? `пакет «${legacyPack.title}» через ${providerId} (${ev.paymentRef})`
          : `пополнение $${usd(expectedCents).toFixed(2)} через ${providerId}`,
      );
      req.log.info({ provider: providerId, user: user.id, amountUsd: usd(expectedCents), res }, 'webhook: пополнение');
      return { ok: true, result: res };
    });
  });
}
