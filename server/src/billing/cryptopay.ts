// Crypto Pay (@CryptoBot) — единственный файл, знающий его wire-формат.
// Доки: https://help.send.tg/en/articles/10279948-crypto-pay-api (сверено 19.07.2026).
// - createInvoice: fiat USD + accepted_assets, payload (до 4кб, round-trip);
// - вебхук invoice_paid: { update_type, payload: <Invoice> }, Invoice.payload = наш JSON;
// - подпись: header crypto-pay-api-signature = HMAC-SHA256(raw-тело, SHA256(токен)).
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config';
import {
  decodeRef,
  encodeRef,
  type CheckoutInput,
  type CheckoutResult,
  type PaymentEvent,
  type ProviderPaymentStatus,
  type PaymentProvider,
} from './provider';

const MAINNET = 'https://pay.crypt.bot/api';
const TESTNET = 'https://testnet-pay.crypt.bot/api';

function apiBase(): string {
  return config.cryptoPayTestnet ? TESTNET : MAINNET;
}

interface CryptoInvoice {
  invoice_id?: number | string;
  status?: string;
  fiat?: string;
  amount?: string | number;
  payload?: string;
  expiration_date?: string;
  mini_app_invoice_url?: string;
  bot_invoice_url?: string;
  web_app_invoice_url?: string;
}

function finiteAmount(value: unknown): number | null {
  const amount = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function normalizeInvoice(invoice: CryptoInvoice): ProviderPaymentStatus | null {
  if (invoice.invoice_id === undefined || invoice.invoice_id === null) return null;
  const ref = decodeRef(invoice.payload);
  const amount = finiteAmount(invoice.amount);
  return {
    externalId: String(invoice.invoice_id),
    intentId: ref?.intentId ?? null,
    userId: ref?.userId ?? null,
    amountCents: ref?.amountCents ?? null,
    state: invoice.status === 'paid' ? 'paid' : invoice.status === 'expired' ? 'expired' : 'pending',
    paidCurrency: typeof invoice.fiat === 'string' ? invoice.fiat.toUpperCase() : null,
    paidAmountMinor: amount === null ? null : Math.round(amount * 100),
    expiresAt: typeof invoice.expiration_date === 'string' ? invoice.expiration_date : null,
  };
}

async function cryptoRequest(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!config.cryptoPayToken) throw new Error('Crypto Pay не настроен на сервере');
  const res = await fetch(`${apiBase()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Crypto-Pay-API-Token': config.cryptoPayToken },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: unknown; result?: unknown };
  if (!res.ok || !json.ok || !json.result || typeof json.result !== 'object') {
    throw new Error(`Crypto Pay отклонил запрос ${method}: ${JSON.stringify(json.error ?? res.status)}`);
  }
  return json.result as Record<string, unknown>;
}

/**
 * Testnet нельзя выдавать обычным пользователям: иначе тестовыми монетами можно
 * купить настоящий USD-баланс SwapForge. На публичном prod тестирует только owner.
 */
export function cryptoPayAvailableToRole(
  role: string | null | undefined,
  testnet = config.cryptoPayTestnet,
): boolean {
  return !testnet || role === 'owner';
}

export function verifyCryptoPaySignature(rawBody: Buffer, signature: string, token: string): boolean {
  if (!token || !signature) return false;
  const secret = createHash('sha256').update(token).digest();
  const mac = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(mac);
  const b = Buffer.from(signature.trim());
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseCryptoPayEvent(rawBody: Buffer): PaymentEvent {
  let update: Record<string, unknown>;
  try {
    update = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
  } catch {
    return { kind: 'invalid', reason: 'not_json' };
  }
  if (update.update_type !== 'invoice_paid') {
    return { kind: 'ignored', reason: String(update.update_type ?? 'unknown') };
  }
  const inv = (update.payload ?? {}) as Record<string, unknown>;
  if (inv.status !== 'paid') return { kind: 'ignored', reason: `status=${String(inv.status)}` };
  const invoiceId = inv.invoice_id;
  const ref = decodeRef(typeof inv.payload === 'string' ? inv.payload : null);
  if (invoiceId === undefined || invoiceId === null || !ref) {
    return { kind: 'invalid', reason: 'missing_invoice_or_payload' };
  }
  const paidAmount = typeof inv.amount === 'string' ? Number(inv.amount) : typeof inv.amount === 'number' ? inv.amount : null;
  return {
    kind: 'purchase',
    paymentRef: `cryptopay:${invoiceId}`,
    externalId: String(invoiceId),
    intentId: ref.intentId,
    userId: ref.userId,
    amountCents: ref.amountCents,
    packId: ref.packId,
    paidAmountUsd:
      ref.amountCents !== undefined && paidAmount !== null && Number.isFinite(paidAmount) ? paidAmount : null,
    paidCurrency: ref.amountCents !== undefined && typeof inv.fiat === 'string' ? inv.fiat.toUpperCase() : null,
    paidAmount: ref.packId && paidAmount !== null && Number.isFinite(paidAmount) ? paidAmount : null,
    paidAsset: ref.packId && typeof inv.asset === 'string' ? inv.asset.toUpperCase() : null,
  };
}

export class CryptoPayProvider implements PaymentProvider {
  readonly id = 'cryptopay' as const;
  readonly needsEmail = false;

  get ready(): boolean {
    return !!config.cryptoPayToken;
  }

  async createCheckout(input: CheckoutInput): Promise<CheckoutResult> {
    if (!this.ready) throw new Error('Crypto Pay не настроен на сервере');
    const amountCents = Math.round(input.amountUsd * 100);
    const r = (await cryptoRequest('createInvoice', {
      currency_type: 'fiat',
      fiat: 'USD',
      accepted_assets: config.cryptoPayAcceptedAssets,
      amount: input.amountUsd.toFixed(2),
      description: `Пополнение баланса SwapForge на $${input.amountUsd.toFixed(2)}`,
      payload: encodeRef(input.userId, amountCents, input.intentId),
      paid_btn_name: 'callback',
      paid_btn_url: `${config.publicBaseUrl}#billing`,
      expires_in: 3600,
    })) as CryptoInvoice;
    const payUrl = r.mini_app_invoice_url || r.bot_invoice_url || r.web_app_invoice_url;
    if (!payUrl || r.invoice_id === undefined || r.invoice_id === null) {
      throw new Error('Crypto Pay не вернул ссылку или ID счёта');
    }
    return {
      payUrl,
      externalId: String(r.invoice_id),
      paidCurrency: 'USD',
      expectedPaidAmountMinor: amountCents,
      expiresAt: typeof r.expiration_date === 'string' ? r.expiration_date : null,
    };
  }

  async getPayment(externalId: string): Promise<ProviderPaymentStatus | null> {
    const result = await cryptoRequest('getInvoices', { invoice_ids: externalId, count: 1 });
    const items = Array.isArray(result.items) ? (result.items as CryptoInvoice[]) : [];
    return items.length ? normalizeInvoice(items[0]!) : null;
  }

  async findRecentPayment(intentId: string): Promise<ProviderPaymentStatus | null> {
    const result = await cryptoRequest('getInvoices', { count: 100, offset: 0 });
    const items = Array.isArray(result.items) ? (result.items as CryptoInvoice[]) : [];
    const invoice = items.find((item) => decodeRef(item.payload)?.intentId === intentId);
    return invoice ? normalizeInvoice(invoice) : null;
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
    const sig = headers['crypto-pay-api-signature'];
    return verifyCryptoPaySignature(rawBody, typeof sig === 'string' ? sig : '', config.cryptoPayToken);
  }

  parseWebhook(rawBody: Buffer): PaymentEvent {
    return parseCryptoPayEvent(rawBody);
  }
}
