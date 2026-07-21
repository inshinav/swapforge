import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { PaymentEvent, PaymentProvider, ProviderPaymentStatus } from '../src/billing/provider';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-payments-'));
process.env.AUTH_DEV_BYPASS = '1';
process.env.BILLING_PROVIDERS = 'cryptopay,lavatop';
process.env.CRYPTO_PAY_TOKEN = 'test-token';
process.env.CRYPTO_PAY_TESTNET = '0';
process.env.LAVA_API_KEY = 'lava-key';
process.env.LAVA_WEBHOOK_SECRET = 'lava-hook';
process.env.LAVA_DYNAMIC_OFFER_ID = 'lava-offer';
process.env.LAVA_RUB_PER_USD = '100';

const { getDb } = await import('../src/db');
const { creditBalance } = await import('../src/billing/credits');
const {
  createPaymentIntent,
  listPaymentIntents,
  markPaymentIntentPending,
  processPaidEvent,
  reconcilePaymentIntent,
} = await import('../src/billing/payments');

function user(): string {
  const id = randomUUID();
  getDb().prepare(`INSERT INTO users (id,telegram_id) VALUES (?,?)`).run(id, Date.now() + Math.floor(Math.random() * 10_000));
  return id;
}

function paidEvent(input: {
  intentId: string;
  userId: string;
  externalId?: string;
  amountUsd?: number;
}): Extract<PaymentEvent, { kind: 'purchase' }> {
  const externalId = input.externalId ?? randomUUID();
  return {
    kind: 'purchase',
    paymentRef: `cryptopay:${externalId}`,
    externalId,
    intentId: input.intentId,
    userId: input.userId,
    amountCents: 500,
    paidAmountUsd: input.amountUsd ?? 5,
    paidCurrency: 'USD',
  };
}

function fakeProvider(status: ProviderPaymentStatus, find = false): PaymentProvider {
  return {
    id: 'cryptopay',
    ready: true,
    needsEmail: false,
    createCheckout: vi.fn(),
    healthCheck: vi.fn(async () => ({ ok: true, detail: 'test' })),
    getPayment: vi.fn(async () => (find ? null : status)),
    findRecentPayment: vi.fn(async () => (find ? status : null)),
    verifyWebhook: vi.fn(() => true),
    parseWebhook: vi.fn(() => ({ kind: 'ignored' as const, reason: 'test' })),
  };
}

beforeAll(() => {
  getDb();
});

describe('durable payment intents', () => {
  it('credits a signed payment exactly once across duplicate and out-of-order deliveries', () => {
    const userId = user();
    const intent = createPaymentIntent(userId, 'cryptopay', 500);
    markPaymentIntentPending(
      intent.id,
      {
        payUrl: 'https://t.me/CryptoBot?start=1',
        externalId: 'invoice-1',
        paidCurrency: 'USD',
        expectedPaidAmountMinor: 500,
        expiresAt: null,
      },
      'https://t.me/CryptoBot?start=1',
    );
    const event = paidEvent({ intentId: intent.id, userId, externalId: 'invoice-1' });
    expect(processPaidEvent('cryptopay', event, { source: 'webhook', eventHash: 'hash-1' }).outcome).toBe('credited');
    expect(processPaidEvent('cryptopay', event, { source: 'webhook', eventHash: 'hash-1' }).outcome).toBe('replay');
    expect(processPaidEvent('cryptopay', event, { source: 'webhook', eventHash: 'hash-2' }).outcome).toBe('replay');
    expect(creditBalance(userId).balance).toBe(500);
    const row = getDb().prepare(`SELECT status FROM payment_intents WHERE id=?`).get(intent.id) as { status: string };
    expect(row.status).toBe('credited');
  });

  it('quarantines wrong currency or underpayment without touching the ledger', () => {
    const userId = user();
    const intent = createPaymentIntent(userId, 'cryptopay', 500);
    const event = paidEvent({ intentId: intent.id, userId, amountUsd: 4.99 });
    const result = processPaidEvent('cryptopay', event, { source: 'webhook', eventHash: 'underpaid' });
    expect(result).toMatchObject({ outcome: 'quarantined', reason: 'currency_or_amount_mismatch' });
    expect(creditBalance(userId).balance).toBe(0);
  });

  it('recovers the crash window after remote invoice creation but before external ID persistence', async () => {
    const userId = user();
    const intent = createPaymentIntent(userId, 'cryptopay', 500);
    const status: ProviderPaymentStatus = {
      externalId: 'recovered-invoice',
      intentId: intent.id,
      userId,
      amountCents: 500,
      state: 'paid',
      paidCurrency: 'USD',
      paidAmountMinor: 500,
      expiresAt: null,
    };
    const provider = fakeProvider(status, true);
    await reconcilePaymentIntent(intent.id, provider);
    expect(provider.findRecentPayment).toHaveBeenCalledWith(intent.id);
    expect(creditBalance(userId).balance).toBe(500);
    const row = getDb().prepare(`SELECT status,external_id FROM payment_intents WHERE id=?`).get(intent.id);
    expect(row).toMatchObject({ status: 'credited', external_id: 'recovered-invoice' });
  });

  it('credits a paid pending invoice when its webhook was lost', async () => {
    const userId = user();
    const intent = createPaymentIntent(userId, 'cryptopay', 500);
    markPaymentIntentPending(
      intent.id,
      {
        payUrl: 'https://t.me/CryptoBot?start=2',
        externalId: 'lost-webhook',
        paidCurrency: 'USD',
        expectedPaidAmountMinor: 500,
        expiresAt: null,
      },
      'https://t.me/CryptoBot?start=2',
    );
    const provider = fakeProvider({
      externalId: 'lost-webhook',
      intentId: intent.id,
      userId,
      amountCents: 500,
      state: 'paid',
      paidCurrency: 'USD',
      paidAmountMinor: 500,
      expiresAt: null,
    });
    await reconcilePaymentIntent(intent.id, provider);
    expect(provider.getPayment).toHaveBeenCalledWith('lost-webhook');
    expect(creditBalance(userId).balance).toBe(500);
    expect(listPaymentIntents(userId)[0]).toMatchObject({ id: intent.id, status: 'credited', amountUsd: 5 });
  });
});
