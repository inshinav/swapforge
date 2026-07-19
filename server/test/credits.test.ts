// Кредиты: hold/settle/release, провайдер-агностичный вебхук (Crypto Pay + Lava.top),
// изоляция USD от не-владельца (regex по сериализованным payload), release при фейлах.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac, randomUUID } from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-credits-'));
process.env.AUTH_DEV_BYPASS = '1';
process.env.OWNER_TELEGRAM_ID = '9500';
process.env.OPENAI_API_KEY = 'test-key';
process.env.WAVESPEED_API_KEY = 'test-key';
process.env.USER_MARGIN_PCT = '25';
process.env.BILLING_PROVIDERS = 'cryptopay,lavatop';
process.env.CRYPTO_PAY_TOKEN = 'cp-test-token';
process.env.LAVA_API_KEY = 'lava-test-key';
process.env.LAVA_WEBHOOK_SECRET = 'lava-hook-secret';
process.env.LAVA_DYNAMIC_OFFER_ID = 'dynamic-rub-offer';
process.env.LAVA_RUB_PER_USD = '100';
process.env.SWAPFORGE_PACKS_JSON = JSON.stringify([
  { id: 'start', title: 'Старт', credits: 300, priceLabel: '≈3 USDT / 299 ₽', cryptoAsset: 'USDT', cryptoAmount: 3, lavaOfferId: 'offer-start', lavaCurrency: 'RUB' },
  { id: 'big', title: 'Большой', credits: 1200, priceLabel: '≈12 USDT / 999 ₽', cryptoAsset: 'USDT', cryptoAmount: 12, lavaOfferId: 'offer-big', lavaCurrency: 'RUB' },
]);

const { getDb } = await import('../src/db');
const {
  adjustCredits,
  applyRefund,
  attachHoldGeneration,
  creditBalance,
  grantPurchase,
  openHoldForProject,
  placeHold,
  priceCredits,
  releaseHold,
  settleHold,
} = await import('../src/billing/credits');
const { reconcileOrphanHolds, releaseFlowHoldOnFailure, settleProjectHold, toUserEstimate } = await import(
  '../src/billing/flow'
);
const { encodeRef } = await import('../src/billing/provider');
const {
  CryptoPayProvider,
  cryptoPayAvailableToRole,
  parseCryptoPayEvent,
  verifyCryptoPaySignature,
} = await import('../src/billing/cryptopay');
const { LavaTopProvider, parseLavaEvent } = await import('../src/billing/lavatop');
const { makeAuthedApp } = await import('./helpers');
import type { EstimateInfo } from '../../shared/api-types';

function mkUser(tg: number): string {
  const id = randomUUID();
  getDb().prepare(`INSERT INTO users (id, telegram_id) VALUES (?, ?)`).run(id, tg);
  return id;
}

function mkProject(userId: string): string {
  const id = randomUUID();
  getDb()
    .prepare(`INSERT INTO projects (id, user_id, title, status) VALUES (?, ?, 'p', 'complete')`)
    .run(id, userId);
  return id;
}

describe('priceCredits', () => {
  it('добавляет ровно 25% к себестоимости, округляет вверх до цента, минимум 1', () => {
    expect(priceCredits(2.1)).toBe(263); // ceil(2.1 × 1.25 × 100)
    expect(priceCredits(0.001)).toBe(1);
    expect(priceCredits(0)).toBe(1);
    expect(priceCredits(1.234)).toBe(155); // ceil(154.25)
  });
});

describe('hold/settle/release', () => {
  it('hold ставится при достатке, отклоняется при нехватке (без записи)', () => {
    const u = mkUser(801);
    const p = mkProject(u);
    grantPurchase(u, 100, `ref-${randomUUID()}`, 'тест');
    const no = placeHold(u, p, 101);
    expect(no.ok).toBe(false);
    if (!no.ok) expect(no.availableCredits).toBe(100);
    expect(openHoldForProject(p)).toBeUndefined();

    const yes = placeHold(u, p, 100);
    expect(yes.ok).toBe(true);
    expect(creditBalance(u)).toEqual({ balance: 100, held: 100, available: 0 });
  });

  it('один open-hold на проект: повторный placeHold реюзает', () => {
    const u = mkUser(802);
    const p = mkProject(u);
    grantPurchase(u, 500, `ref-${randomUUID()}`, 'тест');
    const h1 = placeHold(u, p, 200);
    const h2 = placeHold(u, p, 999); // сумма игнорируется — реюз существующего
    expect(h1.ok && h2.ok).toBe(true);
    if (h1.ok && h2.ok) {
      expect(h2.holdId).toBe(h1.holdId);
      expect(h2.reused).toBe(true);
    }
    expect(creditBalance(u).held).toBe(200);
  });

  it('settle списывает факт с капом в hold; повторный settle — no-op', () => {
    const u = mkUser(803);
    const p = mkProject(u);
    grantPurchase(u, 500, `ref-${randomUUID()}`, 'тест');
    const h = placeHold(u, p, 300);
    if (!h.ok) throw new Error('hold не встал');
    // факт больше hold-а → списывается ровно hold (перерасход поглощает оператор)
    expect(settleHold(h.holdId, 999, 'gen-x')).toBe(true);
    expect(creditBalance(u)).toEqual({ balance: 200, held: 0, available: 200 });
    expect(settleHold(h.holdId, 999)).toBe(false); // идемпотентно
    expect(creditBalance(u).balance).toBe(200);
  });

  it('release возвращает резерв, частичное списание допустимо', () => {
    const u = mkUser(804);
    const p = mkProject(u);
    grantPurchase(u, 500, `ref-${randomUUID()}`, 'тест');
    const h = placeHold(u, p, 300);
    if (!h.ok) throw new Error('hold не встал');
    expect(releaseHold(h.holdId, 40, 'LLM-часть')).toBe(true);
    expect(creditBalance(u)).toEqual({ balance: 460, held: 0, available: 460 });
  });

  it('settleProjectHold: WS-факт + LLM с момента резерва, cap = hold', () => {
    const u = mkUser(805);
    const p = mkProject(u);
    grantPurchase(u, 1000, `ref-${randomUUID()}`, 'тест');
    const h = placeHold(u, p, 500);
    if (!h.ok) throw new Error('hold не встал');
    // hold привязан к генерации, как это делает startRender (иначе settle его не тронет)
    attachHoldGeneration(h.holdId, 'gen-1');
    // LLM-расход ПОСЛЕ постановки hold-а (created_at свежее)
    getDb()
      .prepare(
        `INSERT INTO usage_events (id, project_id, user_id, task, model, cost_usd, created_at)
         VALUES (?, ?, ?, 'prompt_pair', 'm', 0.10, datetime('now', '+1 second'))`,
      )
      .run(randomUUID(), p, u);
    settleProjectHold(p, 'gen-1', 1.89);
    // (1.89 + 0.10) × 1.25 × 100 = 248.75 → 249
    expect(creditBalance(u).balance).toBe(1000 - 249);
  });

  it('settle НЕ трогает hold, привязанный к ДРУГОЙ генерации (F2)', () => {
    const u = mkUser(820);
    const p = mkProject(u);
    grantPurchase(u, 1000, `ref-${randomUUID()}`, 'тест');
    const h = placeHold(u, p, 500);
    if (!h.ok) throw new Error();
    attachHoldGeneration(h.holdId, 'gen-new'); // hold переклеен на новый рендер
    // финал СТАРОГО gen-old не должен закрыть чужой резерв
    settleProjectHold(p, 'gen-old', 1.89);
    expect(openHoldForProject(p)?.status).toBe('open');
    expect(creditBalance(u).held).toBe(500);
    // а финал правильной генерации — закрывает
    settleProjectHold(p, 'gen-new', 1.0);
    expect(openHoldForProject(p)).toBeUndefined();
  });
});

describe('release-политика при фейлах', () => {
  it('без generations hold освобождается (LLM-часть списывается)', () => {
    const u = mkUser(806);
    const p = mkProject(u);
    grantPurchase(u, 1000, `ref-${randomUUID()}`, 'тест');
    const h = placeHold(u, p, 400);
    if (!h.ok) throw new Error();
    getDb()
      .prepare(
        `INSERT INTO usage_events (id, project_id, user_id, task, model, cost_usd, created_at)
         VALUES (?, ?, ?, 'video_analysis', 'm', 0.05, datetime('now', '+1 second'))`,
      )
      .run(randomUUID(), p, u);
    // стадия до рендера упала: flow-hold (generation_id=null) → genId=null
    releaseFlowHoldOnFailure(p, null, 'анализ упал');
    // списано ceil(0.05×1.25×100)=7, остальное вернулось
    expect(creditBalance(u)).toEqual({ balance: 993, held: 0, available: 993 });
  });

  it('failed-генерация С ws_prediction_id блокирует release (recheck может добрать)', () => {
    const u = mkUser(807);
    const p = mkProject(u);
    grantPurchase(u, 1000, `ref-${randomUUID()}`, 'тест');
    const h = placeHold(u, p, 400);
    if (!h.ok) throw new Error();
    const genId = randomUUID();
    getDb()
      .prepare(
        `INSERT INTO generations (id, project_id, version, status, ws_prediction_id, user_id) VALUES (?, ?, 1, 'failed', 'pred-1', ?)`,
      )
      .run(genId, p, u);
    attachHoldGeneration(h.holdId, genId);
    releaseFlowHoldOnFailure(p, genId, 'таймаут');
    expect(openHoldForProject(p)?.status).toBe('open'); // hold жив до исхода задачи
    // задача добралась → settle срабатывает
    settleProjectHold(p, genId, 1.0);
    expect(openHoldForProject(p)).toBeUndefined();
  });
});

describe('сверка осиротевших холдов на старте (F3)', () => {
  it('open-hold на done-генерации закрывается по факту', () => {
    const u = mkUser(830);
    const p = mkProject(u);
    grantPurchase(u, 1000, `ref-${randomUUID()}`, 'тест');
    const h = placeHold(u, p, 500);
    if (!h.ok) throw new Error();
    const genId = randomUUID();
    getDb()
      .prepare(
        `INSERT INTO generations (id, project_id, version, status, cost_actual_usd, user_id) VALUES (?, ?, 1, 'done', 1.5, ?)`,
      )
      .run(genId, p, u);
    attachHoldGeneration(h.holdId, genId);
    // краш случился между 'done' и settle → hold остался open
    const fixed = reconcileOrphanHolds();
    expect(fixed).toBeGreaterThanOrEqual(1);
    expect(openHoldForProject(p)).toBeUndefined();
    // списано ceil(1.5×1.25×100)=188 (cap 500 не превышен)
    expect(creditBalance(u).balance).toBe(1000 - 188);
  });
});

describe('Crypto Pay адаптер', () => {
  const TOKEN = 'cp-test-token';
  const invoice = (userId: string, amountCents: number | string, invoiceId = 55501) => ({
    update_id: 1,
    update_type: 'invoice_paid',
    request_date: 'x',
    payload: { invoice_id: invoiceId, status: 'paid', fiat: 'USD', amount: '5.00', payload: encodeRef(userId, amountCents) },
  });
  const signed = (body: Buffer, token = TOKEN) =>
    createHmac('sha256', createHash('sha256').update(token).digest()).update(body).digest('hex');

  it('testnet доступен только владельцу, mainnet — обычным пользователям тоже', () => {
    expect(cryptoPayAvailableToRole('owner', true)).toBe(true);
    expect(cryptoPayAvailableToRole('user', true)).toBe(false);
    expect(cryptoPayAvailableToRole(null, true)).toBe(false);
    expect(cryptoPayAvailableToRole('user', false)).toBe(true);
  });

  it('подпись: HMAC(body, SHA256(token)); чужой токен/подмена тела — нет', () => {
    const body = Buffer.from(JSON.stringify(invoice('u1', 500)));
    expect(verifyCryptoPaySignature(body, signed(body), TOKEN)).toBe(true);
    expect(verifyCryptoPaySignature(body, signed(body, 'другой'), TOKEN)).toBe(false);
    expect(verifyCryptoPaySignature(Buffer.from('{}'), signed(body), TOKEN)).toBe(false);
    expect(verifyCryptoPaySignature(body, '', TOKEN)).toBe(false);
  });

  it('parseCryptoPayEvent: purchase (payload round-trip) / ignored / invalid', () => {
    const ev = parseCryptoPayEvent(Buffer.from(JSON.stringify(invoice('user-42', 500, 777))));
    expect(ev).toMatchObject({
      kind: 'purchase',
      paymentRef: 'cryptopay:777',
      userId: 'user-42',
      amountCents: 500,
      paidAmountUsd: 5,
      paidCurrency: 'USD',
    });
    // не invoice_paid → ignored
    expect(parseCryptoPayEvent(Buffer.from(JSON.stringify({ update_type: 'invoice_created' }))).kind).toBe('ignored');
    // invoice_paid, но status!=paid → ignored
    const active = invoice('u', 500);
    active.payload.status = 'active';
    expect(parseCryptoPayEvent(Buffer.from(JSON.stringify(active))).kind).toBe('ignored');
    // без нашего payload → invalid
    const noPayload = invoice('u', 500);
    (noPayload.payload as { payload?: string }).payload = 'чужая-строка';
    expect(parseCryptoPayEvent(Buffer.from(JSON.stringify(noPayload))).kind).toBe('invalid');
    expect(parseCryptoPayEvent(Buffer.from('не json')).kind).toBe('invalid');
  });

  it('createCheckout создаёт точный fiat-USD инвойс с оплатой криптовалютой', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { bot_invoice_url: 'https://pay.test/i' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    try {
      await expect(new CryptoPayProvider().createCheckout({ userId: 'u-1', amountUsd: 7.25 })).resolves.toEqual({
        payUrl: 'https://pay.test/i',
      });
      const init = fetchMock.mock.calls[0]![1]!;
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        currency_type: 'fiat',
        fiat: 'USD',
        amount: '7.25',
        payload: encodeRef('u-1', 725),
      });
      expect(String(body.accepted_assets)).toContain('USDT');
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe('Lava.top адаптер', () => {
  const ok = (userId: string, amountCents: number | string, contractId = 'c-123') => ({
    eventType: 'payment.success',
    product: { id: 'p1', title: 'Старт' },
    contractId,
    buyer: { email: 'x@y.z' },
    amount: typeof amountCents === 'number' ? amountCents : 1200,
    currency: 'RUB',
    status: 'completed',
    clientUtm: { utm_content: encodeRef(userId, amountCents), utm_term: 'rub-120000' },
  });

  it('parseLavaEvent: purchase (utm round-trip) / ignored / invalid', () => {
    const ev = parseLavaEvent(Buffer.from(JSON.stringify(ok('user-7', 1200, 'ctr-9'))));
    expect(ev).toEqual({
      kind: 'purchase',
      paymentRef: 'lavatop:ctr-9',
      userId: 'user-7',
      amountCents: 1200,
      packId: undefined,
      paidAmount: 1200,
      paidCurrency: 'RUB',
      expectedPaidAmountMinor: 120000,
    });
    // не payment.success → ignored
    expect(parseLavaEvent(Buffer.from(JSON.stringify({ eventType: 'subscription.cancelled' }))).kind).toBe('ignored');
    // success, но status!=completed → ignored
    const failed = ok('u', 1200);
    failed.status = 'failed';
    expect(parseLavaEvent(Buffer.from(JSON.stringify(failed))).kind).toBe('ignored');
    // без нашего utm_content → invalid
    const noUtm = ok('u', 1200);
    noUtm.clientUtm.utm_content = 'google';
    expect(parseLavaEvent(Buffer.from(JSON.stringify(noUtm))).kind).toBe('invalid');
  });

  it('createCheckout передаёт сумму динамическому RUB-офферу по фиксированному курсу', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ paymentUrl: 'https://lava.test/pay' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    try {
      await new LavaTopProvider().createCheckout({ userId: 'u-2', amountUsd: 9.99, email: 'x@y.z' });
      const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        offerId: 'dynamic-rub-offer',
        currency: 'RUB',
        amount: 999,
        clientUtm: {
          utm_content: encodeRef('u-2', 999),
          utm_term: 'rub-99900',
        },
      });
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe('леджер: идемпотентность grant/refund', () => {
  it('grantPurchase/applyRefund идемпотентны по payment_ref', () => {
    const u = mkUser(808);
    expect(grantPurchase(u, 300, 'cryptopay:111', 'пакет')).toBe('granted');
    expect(grantPurchase(u, 300, 'cryptopay:111', 'пакет')).toBe('replay');
    expect(creditBalance(u).balance).toBe(300);
    expect(applyRefund(u, 300, 'lavatop-refund:111', 'рефанд')).toBe('granted');
    expect(applyRefund(u, 300, 'lavatop-refund:111', 'рефанд')).toBe('replay');
    expect(creditBalance(u).balance).toBe(0);
    adjustCredits(u, 50, 'компенсация');
    expect(creditBalance(u).balance).toBe(50);
  });
});

describe('ручное пополнение владельцем по Telegram username', () => {
  it('находит пользователя, начисляет USD ровно один раз и закрыт для обычного аккаунта', async () => {
    const owner = await makeAuthedApp(9500, 'Владелец');
    const buyer = await makeAuthedApp(9701, 'Покупатель');
    try {
      getDb()
        .prepare(`UPDATE users SET tg_username = ?, tg_first_name = ? WHERE id = ?`)
        .run('Buyer_Name', 'Покупатель', buyer.userId);

      const deniedLookup = await buyer.app.inject({
        method: 'GET',
        url: '/api/billing/manual-user?username=Buyer_Name',
      });
      expect(deniedLookup.statusCode).toBe(403);

      const lookup = await owner.app.inject({
        method: 'GET',
        url: '/api/billing/manual-user?username=%40buyer_name',
      });
      expect(lookup.statusCode).toBe(200);
      expect(lookup.json()).toMatchObject({
        user: {
          id: buyer.userId,
          telegramId: 9701,
          username: 'Buyer_Name',
          firstName: 'Покупатель',
          balance: { balanceUsd: 0, heldUsd: 0, availableUsd: 0 },
        },
      });

      const payload = {
        userId: buyer.userId,
        amountUsd: 12.34,
        note: 'перевод в личку',
        requestId: 'manual-topup-9701-0001',
      };
      const topup = await owner.app.inject({
        method: 'POST',
        url: '/api/billing/manual-topup',
        payload,
      });
      expect(topup.statusCode).toBe(200);
      expect(topup.json()).toMatchObject({
        ok: true,
        replayed: false,
        user: { id: buyer.userId, balance: { balanceUsd: 12.34, availableUsd: 12.34 } },
      });
      expect(creditBalance(buyer.userId).balance).toBe(1234);

      const replay = await owner.app.inject({
        method: 'POST',
        url: '/api/billing/manual-topup',
        payload,
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({ replayed: true });
      expect(creditBalance(buyer.userId).balance).toBe(1234);

      const deniedTopup = await buyer.app.inject({
        method: 'POST',
        url: '/api/billing/manual-topup',
        payload,
      });
      expect(deniedTopup.statusCode).toBe(403);
      expect(creditBalance(buyer.userId).balance).toBe(1234);
    } finally {
      await buyer.app.close();
      await owner.app.close();
    }
  });

  it('отклоняет неизвестный ник и сумму с дробной частью меньше цента', async () => {
    const owner = await makeAuthedApp(9500, 'Владелец');
    const buyer = await makeAuthedApp(9702, 'Покупатель 2');
    try {
      const missing = await owner.app.inject({
        method: 'GET',
        url: '/api/billing/manual-user?username=no_such_user',
      });
      expect(missing.statusCode).toBe(404);

      const invalidAmount = await owner.app.inject({
        method: 'POST',
        url: '/api/billing/manual-topup',
        payload: {
          userId: buyer.userId,
          amountUsd: 1.001,
          note: '',
          requestId: 'manual-topup-9702-0001',
        },
      });
      expect(invalidAmount.statusCode).toBe(400);
      expect(creditBalance(buyer.userId).balance).toBe(0);
    } finally {
      await buyer.app.close();
      await owner.app.close();
    }
  });
});

describe('вебхук-роут /api/billing/webhook/:provider (реальное приложение)', () => {
  let app: Awaited<ReturnType<typeof makeAuthedApp>>;
  const TOKEN = 'cp-test-token';

  const sendCrypto = (body: unknown, token = TOKEN) => {
    const raw = Buffer.from(JSON.stringify(body));
    return app.app.inject({
      method: 'POST',
      url: '/api/billing/webhook/cryptopay',
      headers: {
        'content-type': 'application/json',
        'crypto-pay-api-signature': createHmac('sha256', createHash('sha256').update(token).digest()).update(raw).digest('hex'),
      },
      payload: raw,
    });
  };

  const invoiceFor = (userId: string, amountCents: number, invoiceId: number, paidUsd = amountCents / 100) => ({
    update_type: 'invoice_paid',
    payload: { invoice_id: invoiceId, status: 'paid', fiat: 'USD', amount: paidUsd.toFixed(2), payload: encodeRef(userId, amountCents) },
  });

  beforeAll(async () => {
    app = await makeAuthedApp(9501, 'Покупатель');
  });

  it('публичный баланс и способы оплаты — в USD, пополнение только от $5', async () => {
    const balanceRes = await app.app.inject({ method: 'GET', url: '/api/billing/balance' });
    expect(balanceRes.statusCode).toBe(200);
    expect(balanceRes.json()).toEqual({ balanceUsd: 0, heldUsd: 0, availableUsd: 0 });

    const methodsRes = await app.app.inject({ method: 'GET', url: '/api/billing/packs' });
    expect(methodsRes.json()).toMatchObject({
      minTopupUsd: 5,
      maxTopupUsd: 1000,
      providers: expect.arrayContaining([
        { id: 'cryptopay', needsEmail: false },
        { id: 'lavatop', needsEmail: true, rubPerUsd: 100 },
      ]),
    });
    expect((methodsRes.json() as Record<string, unknown>).packs).toBeUndefined();

    const tooSmall = await app.app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      payload: { amountUsd: 4.99, provider: 'cryptopay' },
    });
    expect(tooSmall.statusCode).toBe(400);
    const tooPrecise = await app.app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      payload: { amountUsd: 5.001, provider: 'cryptopay' },
    });
    expect(tooPrecise.statusCode).toBe(400);
  });

  it('валидный крипто-платёж пополняет точную USD-сумму один раз; replay — ноль', async () => {
    const me = app.userId;
    const before = creditBalance(me).balance;
    const r1 = await sendCrypto(invoiceFor(me, 725, 90001));
    expect(r1.statusCode).toBe(200);
    expect(creditBalance(me).balance).toBe(before + 725);
    const r2 = await sendCrypto(invoiceFor(me, 725, 90001));
    expect(r2.statusCode).toBe(200);
    expect(creditBalance(me).balance).toBe(before + 725); // не задвоилось (payment_ref UNIQUE)
  });

  it('битая подпись → 403, ничего не начислено', async () => {
    const before = creditBalance(app.userId).balance;
    const r = await sendCrypto(invoiceFor(app.userId, 500, 90002), 'wrong-token');
    expect(r.statusCode).toBe(403);
    expect(creditBalance(app.userId).balance).toBe(before);
  });

  it('неизвестный провайдер → 404', async () => {
    const r = await app.app.inject({ method: 'POST', url: '/api/billing/webhook/paypal', payload: '{}' });
    expect(r.statusCode).toBe(404);
  });

  it('платёж с чужим/несуществующим userId → 200 без начисления (не теряем молча)', async () => {
    const r = await sendCrypto(invoiceFor('нет-такого', 500, 90003));
    expect(r.statusCode).toBe(200);
    expect((r.json() as { unmatched?: boolean }).unmatched).toBe(true);
  });

  it('недоплата USD → не начисляем (defense-in-depth)', async () => {
    const me = app.userId;
    const before = creditBalance(me).balance;
    const underpaid = invoiceFor(me, 500, 90010, 4.99);
    const r = await sendCrypto(underpaid);
    expect(r.statusCode).toBe(200);
    expect((r.json() as { unmatched?: boolean }).unmatched).toBe(true);
    expect(creditBalance(me).balance).toBe(before); // ничего не начислено
    const wrongCurrency = {
      update_type: 'invoice_paid',
      payload: { invoice_id: 90011, status: 'paid', fiat: 'EUR', amount: '5', payload: encodeRef(me, 500) },
    };
    const r2 = await sendCrypto(wrongCurrency);
    expect((r2.json() as { unmatched?: boolean }).unmatched).toBe(true);
    expect(creditBalance(me).balance).toBe(before);
  });

  it('Lava-вебхук принимает только полную RUB-оплату по курсу 100 и верный X-Api-Key', async () => {
    const buyer = await makeAuthedApp(9502, 'Картой');
    const body = {
      eventType: 'payment.success',
      contractId: 'ctr-777',
      status: 'completed',
      amount: 1200,
      currency: 'RUB',
      clientUtm: { utm_content: encodeRef(buyer.userId, 1200), utm_term: 'rub-120000' },
    };
    const good = await buyer.app.inject({
      method: 'POST',
      url: '/api/billing/webhook/lavatop',
      headers: { 'content-type': 'application/json', 'x-api-key': 'lava-hook-secret' },
      payload: JSON.stringify(body),
    });
    expect(good.statusCode).toBe(200);
    expect(creditBalance(buyer.userId).balance).toBe(1200);

    const underpaid = await buyer.app.inject({
      method: 'POST',
      url: '/api/billing/webhook/lavatop',
      headers: { 'content-type': 'application/json', 'x-api-key': 'lava-hook-secret' },
      payload: JSON.stringify({ ...body, contractId: 'ctr-778', amount: 1199.99 }),
    });
    expect((underpaid.json() as { unmatched?: boolean }).unmatched).toBe(true);
    expect(creditBalance(buyer.userId).balance).toBe(1200);

    const wrongCurrency = await buyer.app.inject({
      method: 'POST',
      url: '/api/billing/webhook/lavatop',
      headers: { 'content-type': 'application/json', 'x-api-key': 'lava-hook-secret' },
      payload: JSON.stringify({ ...body, contractId: 'ctr-779', currency: 'USD', amount: 12 }),
    });
    expect((wrongCurrency.json() as { unmatched?: boolean }).unmatched).toBe(true);
    expect(creditBalance(buyer.userId).balance).toBe(1200);

    const bad = await buyer.app.inject({
      method: 'POST',
      url: '/api/billing/webhook/lavatop',
      headers: { 'content-type': 'application/json', 'x-api-key': 'wrong' },
      payload: JSON.stringify({ ...body, contractId: 'ctr-780' }),
    });
    expect(bad.statusCode).toBe(403);
    await buyer.app.close();
  });
});

describe('публичная USD-смета без себестоимости оператора', () => {
  it('toUserEstimate возвращает итоговую цену и долларовый баланс', () => {
    const u = mkUser(809);
    grantPurchase(u, 100, `ref-${randomUUID()}`, 'тест');
    const est: EstimateInfo = {
      stages: ['render'],
      openai: { perTask: [], usd: 0.15, priceDate: null },
      wavespeed: { usd: 2.1, billedSeconds: 14, perSecondUsd: 0.15, resolution: '720p', priceDate: null, unavailableReason: null },
      totalUsd: 2.25,
      approximate: false,
      balanceUsd: 11.46,
      warnings: ['баланс WaveSpeed $11.46 маловат', 'смета примерная'],
    };
    const user = toUserEstimate(est, u);
    expect(user.kind).toBe('balance');
    expect(user.priceUsd).toBe(2.82); // ceil((промты/фото $0.15 + видео $2.10) × 1.25 × 100) / 100
    expect(user.balanceUsd).toBe(1);
    expect(user.warnings.join()).toContain('Нужно $2.82');
    expect(JSON.stringify(user)).not.toContain('openai');
    expect(JSON.stringify(user)).not.toContain('wavespeed');
  });

  it('GET /api/projects/:id скрывает себестоимость и отдаёт heldUsd', async () => {
    const tenant = await makeAuthedApp(9503, 'Тенант');
    const p = mkProject(tenant.userId);
    getDb()
      .prepare(
        `INSERT INTO generations (id, project_id, version, status, cost_est_json, cost_actual_usd, cost_source, user_id)
         VALUES (?, ?, 1, 'done', '{"wavespeedUsd":2.1,"billedSeconds":14}', 1.89, 'balance_delta', ?)`,
      )
      .run(randomUUID(), p, tenant.userId);
    grantPurchase(tenant.userId, 500, `ref-${randomUUID()}`, 'тест');
    placeHold(tenant.userId, p, 420);

    const res = await tenant.app.inject({ method: 'GET', url: `/api/projects/${p}` });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body).not.toMatch(/costActualUsd":[0-9]/);
    expect(body).not.toMatch(/wavespeedUsd":[0-9]/);
    expect(body).not.toMatch(/projectUsd":[1-9]/);
    expect((res.json() as { costs: { heldUsd: number } }).costs.heldUsd).toBe(4.2);
    await tenant.app.close();
  });
});

describe('F1: /swap не оставляет висящий hold', () => {
  it('failed-версия → 409 БЕЗ постановки резерва', async () => {
    process.env.WAVESPEED_API_KEY = 'test-key';
    const tenant = await makeAuthedApp(9601, 'F1-юзер');
    grantPurchase(tenant.userId, 100000, `ref-${randomUUID()}`, 'тест');
    const p = mkProject(tenant.userId);
    getDb()
      .prepare(
        `UPDATE projects SET video_file='source.mp4', frames_json='[]', analysis_json='{}' WHERE id = ?`,
      )
      .run(p);
    getDb().prepare(`INSERT INTO refs (id, project_id, idx, role, file) VALUES (?, ?, 0, 'model', 'ref_a.jpg')`).run(randomUUID(), p);
    // версия промтов есть, но её единственный рендер — failed → nextStageOf='done' + latestGenStatus='failed'
    getDb().prepare(`INSERT INTO prompts (id, project_id, version, kind, text, flags_json) VALUES (?, ?, 1, 'video', 'VP', '{}')`).run(randomUUID(), p);
    getDb().prepare(`INSERT INTO prompts (id, project_id, version, kind, text, flags_json) VALUES (?, ?, 1, 'image', 'IP', '{}')`).run(randomUUID(), p);
    fs.mkdirSync(path.join(process.env.DATA_DIR!, 'projects', p, 'start'), { recursive: true });
    fs.writeFileSync(path.join(process.env.DATA_DIR!, 'projects', p, 'start', 'start_v1_2026-07-19T00-00-00.png'), 'png');
    getDb()
      .prepare(`INSERT INTO generations (id, project_id, version, status, ws_prediction_id, user_id) VALUES (?, ?, 1, 'failed', 'pred-x', ?)`)
      .run(randomUUID(), p, tenant.userId);

    const before = creditBalance(tenant.userId);
    const res = await tenant.app.inject({
      method: 'POST',
      url: `/api/projects/${p}/swap`,
      payload: { flags: { removeText: false, enhanceFigure: false } },
    });
    expect(res.statusCode).toBe(409);
    // ГЛАВНОЕ (суть F1): ранний возврат не оставил висящего резерва — held не вырос
    expect(creditBalance(tenant.userId)).toEqual(before);
    expect(openHoldForProject(p)).toBeUndefined();
    await tenant.app.close();
  });
});
