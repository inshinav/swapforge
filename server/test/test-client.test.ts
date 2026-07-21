// Тест-клиент владельца (реальный metered-юзер для проверки пути клиента),
// живой health-check оплаты и внятная ошибка email при отказе Lava.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-testclient-'));
process.env.AUTH_DEV_BYPASS = '1';
process.env.BILLING_PROVIDERS = 'cryptopay,lavatop';
process.env.CRYPTO_PAY_TOKEN = 'test-token';
process.env.CRYPTO_PAY_TESTNET = '1'; // прод-режим: крипта в тестнете
process.env.LAVA_API_KEY = 'lava-key';
process.env.LAVA_WEBHOOK_SECRET = 'lava-hook';
process.env.LAVA_DYNAMIC_OFFER_ID = 'lava-offer';

const { getDb } = await import('../src/db');
const { makeAuthedApp } = await import('./helpers');
const { cryptoPayAvailableToRole, CryptoPayProvider } = await import('../src/billing/cryptopay');
const { createPaymentIntent, markPaymentIntentPending, processPaidEvent } = await import(
  '../src/billing/payments'
);
const { creditBalance } = await import('../src/billing/credits');
import type { BillingHealthInfo, BillingMethodsInfo, AuthUser } from '../../shared/api-types';

interface InjectResponse {
  statusCode: number;
  headers: Record<string, unknown>;
  json: () => unknown;
}

/** Куки и csrf из ответа switch-роутов — для запросов от лица новой сессии. */
function headersFrom(res: InjectResponse): Record<string, string> {
  const setCookies = res.headers['set-cookie'] as string[];
  const sess = setCookies.find((c) => c.startsWith('sf_sess='))!.split(';')[0]!;
  const csrfPair = setCookies.find((c) => c.startsWith('sf_csrf='))!.split(';')[0]!;
  const csrf = decodeURIComponent(csrfPair.split('=').slice(1).join('='));
  return { cookie: `${sess}; ${csrfPair}`, 'x-sf-csrf': csrf };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('тест-клиент владельца', () => {
  it('обычному юзеру переключение недоступно', async () => {
    const regular = await makeAuthedApp(92001, 'Обычный');
    const res = await regular.app.inject({ method: 'POST', url: '/api/auth/test-client' });
    expect(res.statusCode).toBe(403);
  });

  it('владелец переключается в metered тест-клиента и обратно; старая сессия гаснет', async () => {
    const authed = await makeAuthedApp(92002, 'Владелец');
    getDb().prepare(`UPDATE users SET role='owner' WHERE id=?`).run(authed.userId);

    const enter = await authed.app.inject({ method: 'POST', url: '/api/auth/test-client' });
    expect(enter.statusCode).toBe(200);
    const sandboxUser = (enter.json() as { user: AuthUser }).user;
    expect(sandboxUser.sandbox).toBe(true);
    expect(sandboxUser.role).toBe('user');
    expect(sandboxUser.telegramId).toBe(-92002);
    expect(sandboxUser.firstName).toBe('Тест-клиент');

    // старая owner-кука мертва (одна кука — одна живая сессия)
    const stale = await authed.app.inject({ method: 'GET', url: '/api/me' });
    expect(stale.statusCode).toBe(401);

    const sandboxHeaders = headersFrom(enter as InjectResponse);
    const me = await authed.app.inject({ method: 'GET', url: '/api/me', headers: sandboxHeaders });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { user: AuthUser }).user.sandbox).toBe(true);

    // повторный вход владельца использует ТОГО ЖЕ тест-клиента (upsert, без клонов)
    const exit = await authed.app.inject({
      method: 'POST',
      url: '/api/auth/test-client/exit',
      headers: sandboxHeaders,
    });
    expect(exit.statusCode).toBe(200);
    expect((exit.json() as { user: AuthUser }).user.role).toBe('owner');
    const ownerHeaders = headersFrom(exit as InjectResponse);
    const again = await authed.app.inject({
      method: 'POST',
      url: '/api/auth/test-client',
      headers: ownerHeaders,
    });
    expect(again.statusCode).toBe(200);
    expect((again.json() as { user: AuthUser }).user.id).toBe(sandboxUser.id);
  });

  it('exit из обычной (не sandbox) сессии — 403', async () => {
    const regular = await makeAuthedApp(92003, 'Не-Сандбокс');
    const res = await regular.app.inject({ method: 'POST', url: '/api/auth/test-client/exit' });
    expect(res.statusCode).toBe(403);
  });

  it('testnet-крипта: скрыта юзеру, видна владельцу и тест-клиенту', async () => {
    expect(cryptoPayAvailableToRole('user', true)).toBe(false);
    expect(cryptoPayAvailableToRole('owner', true)).toBe(true);
    expect(cryptoPayAvailableToRole('user', true, true)).toBe(true); // sandbox
    expect(cryptoPayAvailableToRole('user', false)).toBe(true); // mainnet — всем

    const authed = await makeAuthedApp(92004, 'Владелец-2');
    getDb().prepare(`UPDATE users SET role='owner' WHERE id=?`).run(authed.userId);
    const enter = await authed.app.inject({ method: 'POST', url: '/api/auth/test-client' });
    const sandboxHeaders = headersFrom(enter as InjectResponse);
    const packs = await authed.app.inject({ method: 'GET', url: '/api/billing/packs', headers: sandboxHeaders });
    const providers = (packs.json() as BillingMethodsInfo).providers.map((p) => p.id);
    expect(providers).toContain('cryptopay');
    expect(providers).toContain('lavatop');

    const regular = await makeAuthedApp(92005, 'Юзер-Пакс');
    const regularPacks = await regular.app.inject({ method: 'GET', url: '/api/billing/packs' });
    const regularProviders = (regularPacks.json() as BillingMethodsInfo).providers.map((p) => p.id);
    expect(regularProviders).not.toContain('cryptopay');
    expect(regularProviders).toContain('lavatop');
  });

  it('оплата тест-клиента в testnet-крипте зачисляется, а не уходит в карантин', () => {
    const authedOwnerId = randomUUID();
    getDb()
      .prepare(`INSERT INTO users (id, telegram_id, role) VALUES (?, 92106, 'owner')`)
      .run(authedOwnerId);
    const sandboxId = randomUUID();
    getDb()
      .prepare(`INSERT INTO users (id, telegram_id, tg_first_name, role, sandbox_of) VALUES (?, -92106, 'Тест-клиент', 'user', ?)`)
      .run(sandboxId, authedOwnerId);
    const intent = createPaymentIntent(sandboxId, 'cryptopay', 500);
    markPaymentIntentPending(
      intent.id,
      { payUrl: 'https://t.me/x', externalId: 'inv-92106', paidCurrency: 'USD', expectedPaidAmountMinor: 500, expiresAt: null },
      'https://t.me/x',
    );
    const result = processPaidEvent(
      'cryptopay',
      {
        kind: 'purchase',
        paymentRef: 'cryptopay:inv-92106',
        externalId: 'inv-92106',
        intentId: intent.id,
        userId: sandboxId,
        amountCents: 500,
        paidAmountUsd: 5,
        paidCurrency: 'USD',
      },
      { source: 'webhook', eventHash: `hash-${randomUUID()}` },
    );
    expect(result.outcome).toBe('credited');
    expect(creditBalance(sandboxId).available).toBe(500);
  });
});

describe('проверка оплаты владельцем', () => {
  it('health-check крипты: живой getMe с сетью и деталью про тестнет', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { app_id: 42, name: 'SwapForge' } }),
      })) as unknown as typeof fetch,
    );
    const health = await new CryptoPayProvider().healthCheck();
    expect(health.ok).toBe(true);
    expect(health.detail).toContain('SwapForge');
    expect(health.detail).toContain('ТЕСТНЕТ');
  });

  it('GET /api/admin/billing/health — только владельцу; отдаёт провайдеров, счётчики и события', async () => {
    const regular = await makeAuthedApp(92007, 'Не-Админ');
    expect((await regular.app.inject({ method: 'GET', url: '/api/admin/billing/health' })).statusCode).toBe(403);

    const authed = await makeAuthedApp(92008, 'Админ');
    getDb().prepare(`UPDATE users SET role='owner' WHERE id=?`).run(authed.userId);
    const res = await authed.app.inject({ method: 'GET', url: '/api/admin/billing/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as BillingHealthInfo;
    expect(body.providers.map((p) => p.id).sort()).toEqual(['cryptopay', 'lavatop']);
    const crypto = body.providers.find((p) => p.id === 'cryptopay')!;
    expect(crypto.testnet).toBe(true);
    expect(crypto.availableToUsers).toBe(false);
    // сеть в тестах закрыта — пинг честно падает, а не притворяется зелёным
    expect(crypto.check.ok).toBe(false);
    expect(typeof body.intents).toBe('object');
    expect(Array.isArray(body.events)).toBe(true);
  });

  it('отказ Lava по email превращается в понятную 400, а не «попробуй позже»', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: 'Incorrect email to purchase' }),
      })) as unknown as typeof fetch,
    );
    const authed = await makeAuthedApp(92009, 'Емейл');
    const res = await authed.app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      payload: { provider: 'lavatop', amountUsd: 5, email: 'странный@адрес.рф' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('email');
  });
});
