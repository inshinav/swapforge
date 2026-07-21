// Биллинг-роуты, провайдер-нейтральные. Server-initiated checkout: сервер сам
// создаёт инвойс у выбранного провайдера (Crypto Pay / Lava.top) и кладёт НАШ
// userId+сумму в round-trip канал → вебхук возвращает их обратно. Вебхуки живут в
// encapsulated-scope с raw-buffer парсером (подпись/секрет считаются по сырому телу).
import type { FastifyInstance, FastifyReply } from 'fastify';
import { getDb } from '../db';
import { requireOwner } from '../auth/middleware';
import { byUserOrIp, rateLimit } from '../rateLimit';
import { config } from '../config';
import { adjustCredits, creditBalance, listLedger } from './credits';
import { cryptoPayAvailableToRole } from './cryptopay';
import { getProvider, readyProviders, validateCheckoutUrl } from './provider';
import {
  createPaymentIntent,
  listPaymentIntents,
  listRecentPaymentEvents,
  listRecoverablePaymentIntents,
  markPaymentIntentCreationUncertain,
  markPaymentIntentPending,
  paymentIntentStats,
  processPaidEvent,
  reconcilePaymentIntent,
  recordPaymentEventReceipt,
  webhookEventHash,
} from './payments';

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

  app.get('/api/billing/payment-intents', async (req) => ({
    intents: listPaymentIntents(req.user!.id),
  }));

  // Оставляем URL /packs для совместимости клиента, но пакетов в продукте больше нет.
  app.get('/api/billing/packs', async (req) => {
    const previewAsUser =
      req.user?.role === 'owner' && String((req.query as { preview?: unknown } | undefined)?.preview ?? '') === 'user';
    const billingRole = previewAsUser ? 'user' : req.user?.role;
    return {
      minTopupUsd: config.minTopupUsd,
      maxTopupUsd: config.maxTopupUsd,
      providers: readyProviders()
        .filter((p) => p.id !== 'cryptopay' || cryptoPayAvailableToRole(billingRole, undefined, req.user?.sandbox))
        .map((p) => ({
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
    if (provider.id === 'cryptopay' && !cryptoPayAvailableToRole(req.user?.role, undefined, req.user?.sandbox)) {
      return bad(reply, 400, 'Способ оплаты недоступен');
    }
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

    const intent = createPaymentIntent(req.user!.id, provider.id, amountCents);
    try {
      const result = await provider.createCheckout({
        intentId: intent.id,
        userId: req.user!.id,
        amountUsd: usd(amountCents),
        email,
      });
      const payUrl = validateCheckoutUrl(provider.id, result.payUrl);
      markPaymentIntentPending(intent.id, result, payUrl);
      return { payUrl };
    } catch (e) {
      markPaymentIntentCreationUncertain(intent.id, e);
      req.log.error({ err: e instanceof Error ? e.message : e }, 'checkout не удался');
      // Lava валидирует email строже нашего RE («Incorrect email to purchase») —
      // юзер должен услышать причину, а не безликое «попробуй позже»
      const message = e instanceof Error ? e.message : String(e);
      if (/email/i.test(message)) {
        return bad(reply, 400, 'Платёжная система не приняла email — проверь адрес и попробуй ещё раз');
      }
      return bad(reply, 502, 'Не удалось создать счёт — попробуй позже');
    }
  });

  // Legacy endpoint deliberately cannot mutate the ledger. All manual grants go through the
  // idempotent, audited /manual-topup service below.
  app.post('/api/billing/adjust', { preHandler: requireOwner }, async (req, reply) => {
    return bad(reply, 410, 'Используй безопасное идемпотентное пополнение /api/billing/manual-topup');
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

  // Живая проверка оплаты владельцем: пинг API каждого включённого провайдера
  // (без секретов), статус вебхук-конфига, счётчики интентов и последние события.
  app.get('/api/admin/billing/health', { preHandler: requireOwner }, async () => {
    const providers = await Promise.all(
      readyProviders().map(async (p) => ({
        id: p.id,
        needsEmail: p.needsEmail,
        ...(p.id === 'cryptopay'
          ? { testnet: config.cryptoPayTestnet, availableToUsers: cryptoPayAvailableToRole('user') }
          : { availableToUsers: true }),
        check: await p.healthCheck(),
      })),
    );
    return {
      generatedAt: new Date().toISOString(),
      providers,
      intents: paymentIntentStats(),
      events: listRecentPaymentEvents(15),
    };
  });

  app.get('/api/admin/payment-intents', { preHandler: requireOwner }, async (req, reply) => {
    const status = String((req.query as { status?: unknown }).status ?? 'pending');
    if (!['creating', 'pending', 'paid', 'quarantined'].includes(status)) {
      return bad(reply, 400, 'Некорректный статус');
    }
    return { intents: listRecoverablePaymentIntents(status as 'creating' | 'pending' | 'paid' | 'quarantined') };
  });

  app.post('/api/admin/payment-intents/:id/reconcile', { preHandler: requireOwner }, async (req, reply) => {
    const id = String((req.params as { id?: unknown }).id ?? '');
    const row = getDb().prepare(`SELECT id FROM payment_intents WHERE id=?`).get(id);
    if (!row) return bad(reply, 404, 'Платёж не найден');
    await reconcilePaymentIntent(id);
    const intent = getDb().prepare(`SELECT * FROM payment_intents WHERE id=?`).get(id);
    return { intent };
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
      const eventHash = webhookEventHash(raw);

      if (!provider.verifyWebhook(raw, req.headers)) {
        recordPaymentEventReceipt({
          provider: provider.id,
          eventHash,
          verified: false,
          outcome: 'rejected',
          reason: 'bad_signature',
        });
        req.log.warn({ provider: providerId }, 'webhook: подпись/секрет не сошлись');
        return bad(reply, 403, 'bad signature');
      }

      const ev = provider.parseWebhook(raw);
      if (ev.kind === 'invalid') {
        recordPaymentEventReceipt({
          provider: provider.id,
          eventHash,
          verified: true,
          outcome: 'invalid',
          reason: ev.reason,
        });
        req.log.warn({ provider: providerId, reason: ev.reason }, 'webhook: невалидное событие');
        return bad(reply, 400, 'bad payload');
      }
      if (ev.kind === 'ignored') {
        recordPaymentEventReceipt({
          provider: provider.id,
          eventHash,
          verified: true,
          outcome: 'ignored',
          reason: ev.reason,
        });
        return { ok: true, ignored: ev.reason };
      }

      const result = processPaidEvent(provider.id, ev, { source: 'webhook', eventHash });
      req.log.info({ provider: providerId, result }, 'webhook: платёж обработан');
      return {
        ok: true,
        result: result.outcome,
        ...(result.outcome === 'quarantined'
          ? { quarantined: true, unmatched: true, reason: result.reason }
          : {}),
      };
    });
  });
}
