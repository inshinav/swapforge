// Кредиты: hold/settle/release, идемпотентность вебхука Tribute, изоляция USD
// от не-владельца (regex по сериализованным payload), политика release при фейлах.
import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-credits-'));
process.env.AUTH_DEV_BYPASS = '1';
process.env.OWNER_TELEGRAM_ID = '9500';
process.env.OPENAI_API_KEY = 'test-key';
process.env.WAVESPEED_API_KEY = 'test-key';
process.env.CREDIT_MARKUP = '2';
process.env.TRIBUTE_API_KEY = 'trbt-test-key';
process.env.SWAPFORGE_PACKS_JSON = JSON.stringify([
  { id: 'start', title: 'Старт', credits: 300, priceLabel: '299 ₽', url: 'https://t.me/x', tributeProductId: 456 },
  { id: 'big', title: 'Большой', credits: 1200, priceLabel: '999 ₽', url: 'https://t.me/y', amountMinor: 99900, currency: 'rub' },
]);

const { getDb } = await import('../src/db');
const {
  adjustCredits,
  applyRefund,
  creditBalance,
  grantPurchase,
  openHoldForProject,
  placeHold,
  priceCredits,
  releaseHold,
  settleHold,
} = await import('../src/billing/credits');
const { releaseFlowHoldOnFailure, settleProjectHold, toUserEstimate } = await import('../src/billing/flow');
const { parseTributeEvent, verifyTributeSignature } = await import('../src/billing/tribute');
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
  it('ceil(usd × markup × 100), минимум 1', () => {
    expect(priceCredits(2.1)).toBe(420); // 2.1 × 2 × 100
    expect(priceCredits(0.001)).toBe(1);
    expect(priceCredits(0)).toBe(1);
    expect(priceCredits(1.234)).toBe(247); // ceil(246.8)
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
    // LLM-расход ПОСЛЕ постановки hold-а (created_at свежее)
    getDb()
      .prepare(
        `INSERT INTO usage_events (id, project_id, user_id, task, model, cost_usd, created_at)
         VALUES (?, ?, ?, 'prompt_pair', 'm', 0.10, datetime('now', '+1 second'))`,
      )
      .run(randomUUID(), p, u);
    settleProjectHold(p, 'gen-1', 1.89);
    // (1.89 + 0.10) × 2 × 100 = 398
    expect(creditBalance(u).balance).toBe(1000 - 398);
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
    releaseFlowHoldOnFailure(p, 'анализ упал');
    // списано ceil(0.05×2×100)=10, остальное вернулось
    expect(creditBalance(u)).toEqual({ balance: 990, held: 0, available: 990 });
  });

  it('failed-генерация С ws_prediction_id блокирует release (recheck может добрать)', () => {
    const u = mkUser(807);
    const p = mkProject(u);
    grantPurchase(u, 1000, `ref-${randomUUID()}`, 'тест');
    const h = placeHold(u, p, 400);
    if (!h.ok) throw new Error();
    getDb()
      .prepare(
        `INSERT INTO generations (id, project_id, version, status, ws_prediction_id, user_id) VALUES (?, ?, 1, 'failed', 'pred-1', ?)`,
      )
      .run(randomUUID(), p, u);
    releaseFlowHoldOnFailure(p, 'таймаут');
    expect(openHoldForProject(p)?.status).toBe('open'); // hold жив до исхода задачи
    // задача добралась → settle срабатывает
    settleProjectHold(p, 'gen-z', 1.0);
    expect(openHoldForProject(p)).toBeUndefined();
  });
});

describe('Tribute адаптер', () => {
  const KEY = 'trbt-test-key';
  const purchase = {
    name: 'new_digital_product',
    created_at: '2026-07-19T10:00:00Z',
    sent_at: '2026-07-19T10:00:01Z',
    payload: {
      product_id: 456,
      product_name: 'Старт',
      amount: 29900,
      currency: 'rub',
      telegram_user_id: 555001,
      purchase_id: 78901,
      transaction_id: 1,
      purchase_created_at: '2026-07-19T10:00:00Z',
    },
  };

  const signed = (body: Buffer, key = KEY) => createHmac('sha256', key).update(body).digest('hex');

  it('подпись: hex и base64 валидны, чужой ключ/подмена тела — нет', () => {
    const body = Buffer.from(JSON.stringify(purchase));
    expect(verifyTributeSignature(body, signed(body), KEY)).toBe(true);
    const b64 = createHmac('sha256', KEY).update(body).digest('base64');
    expect(verifyTributeSignature(body, b64, KEY)).toBe(true);
    expect(verifyTributeSignature(body, signed(body, 'другой'), KEY)).toBe(false);
    expect(verifyTributeSignature(Buffer.from('{}'), signed(body), KEY)).toBe(false);
    expect(verifyTributeSignature(body, '', KEY)).toBe(false);
  });

  it('parseTributeEvent: purchase/refund/ignored/invalid', () => {
    const ev = parseTributeEvent(Buffer.from(JSON.stringify(purchase)));
    expect(ev).toMatchObject({
      kind: 'purchase',
      paymentRef: 'tribute:78901',
      telegramUserId: 555001,
      productId: 456,
      amountMinor: 29900,
      currency: 'rub',
    });
    const refund = parseTributeEvent(
      Buffer.from(
        JSON.stringify({ name: 'digital_product_refunded', payload: { ...purchase.payload } }),
      ),
    );
    expect(refund).toMatchObject({ kind: 'refund', paymentRef: 'tribute-refund:78901' });
    expect(parseTributeEvent(Buffer.from(JSON.stringify({ name: 'new_donation', payload: {} })))).toEqual({
      kind: 'ignored',
      name: 'new_donation',
    });
    expect(parseTributeEvent(Buffer.from('не json')).kind).toBe('invalid');
    expect(
      parseTributeEvent(Buffer.from(JSON.stringify({ name: 'new_digital_product', payload: {} }))).kind,
    ).toBe('invalid');
  });

  it('grantPurchase/applyRefund идемпотентны по payment_ref', () => {
    const u = mkUser(808);
    expect(grantPurchase(u, 300, 'tribute:111', 'пакет')).toBe('granted');
    expect(grantPurchase(u, 300, 'tribute:111', 'пакет')).toBe('replay');
    expect(creditBalance(u).balance).toBe(300);
    expect(applyRefund(u, 300, 'tribute-refund:111', 'рефанд')).toBe('granted');
    expect(applyRefund(u, 300, 'tribute-refund:111', 'рефанд')).toBe('replay');
    expect(creditBalance(u).balance).toBe(0);
    adjustCredits(u, 50, 'компенсация');
    expect(creditBalance(u).balance).toBe(50);
  });
});

describe('вебхук-роут (реальное приложение)', () => {
  let app: Awaited<ReturnType<typeof makeAuthedApp>>;
  const KEY = 'trbt-test-key';

  const send = (body: unknown, sigKey = KEY) => {
    const raw = Buffer.from(JSON.stringify(body));
    return app.app.inject({
      method: 'POST',
      url: '/api/billing/tribute/webhook',
      headers: {
        'content-type': 'application/json',
        'trbt-signature': createHmac('sha256', sigKey).update(raw).digest('hex'),
        // вебхук публичный: cookie/csrf хелпера не мешают, но и не требуются
      },
      payload: raw,
    });
  };

  const purchaseFor = (tgId: number, purchaseId: number) => ({
    name: 'new_digital_product',
    created_at: 'x',
    sent_at: 'x',
    payload: {
      product_id: 456,
      product_name: 'Старт',
      amount: 29900,
      currency: 'rub',
      telegram_user_id: tgId,
      purchase_id: purchaseId,
      transaction_id: 1,
      purchase_created_at: 'x',
    },
  });

  beforeAll(async () => {
    app = await makeAuthedApp(9501, 'Покупатель');
  });

  it('валидный платёж начисляет пакет один раз; replay — ноль', async () => {
    const me = getDb().prepare(`SELECT id FROM users WHERE telegram_id = 9501`).get() as { id: string };
    const r1 = await send(purchaseFor(9501, 90001));
    expect(r1.statusCode).toBe(200);
    expect(creditBalance(me.id).balance).toBe(300);
    const r2 = await send(purchaseFor(9501, 90001));
    expect(r2.statusCode).toBe(200);
    expect(creditBalance(me.id).balance).toBe(300); // не задвоилось
  });

  it('битая подпись → 403, ничего не начислено', async () => {
    const me = getDb().prepare(`SELECT id FROM users WHERE telegram_id = 9501`).get() as { id: string };
    const before = creditBalance(me.id).balance;
    const r = await send(purchaseFor(9501, 90002), 'wrong-key');
    expect(r.statusCode).toBe(403);
    expect(creditBalance(me.id).balance).toBe(before);
  });

  it('неопознанный продукт → adjust-0 след, деньги не теряются молча', async () => {
    const me = getDb().prepare(`SELECT id FROM users WHERE telegram_id = 9501`).get() as { id: string };
    const odd = purchaseFor(9501, 90003);
    odd.payload.product_id = 999999;
    odd.payload.amount = 12345;
    const r = await send(odd);
    expect(r.statusCode).toBe(200);
    const trace = getDb()
      .prepare(`SELECT note FROM credit_ledger WHERE user_id = ? AND kind = 'adjust' AND delta_credits = 0`)
      .get(me.id) as { note: string } | undefined;
    expect(trace?.note).toContain('неопознанный');
  });

  it('fallback-маппинг по amount+currency работает (пакет big)', async () => {
    const buyer = await makeAuthedApp(9502, 'Второй');
    const body = purchaseFor(9502, 90004);
    body.payload.product_id = 31337; // незнакомый id → матч по сумме
    body.payload.amount = 99900;
    await send(body);
    expect(creditBalance(buyer.userId).balance).toBe(1200);
    await buyer.app.close();
  });
});

describe('изоляция USD от не-владельца', () => {
  it('toUserEstimate не содержит ни одного usd-поля/знака $', () => {
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
    const json = JSON.stringify(user);
    expect(json).not.toMatch(/[Uu]sd|\$/);
    expect(user.credits).toBe(450); // 2.25 × 2 × 100
    expect(user.balanceCredits).toBe(100);
    expect(user.warnings.join()).toContain('Не хватает кредитов');
    expect(user.warnings.join()).toContain('смета примерная'); // без-$ ворнинги проходят
  });

  it('GET /api/projects/:id не-владельцу отдаёт payload без USD, с heldCredits', async () => {
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
    expect((res.json() as { costs: { heldCredits: number } }).costs.heldCredits).toBe(420);
    await tenant.app.close();
  });
});
