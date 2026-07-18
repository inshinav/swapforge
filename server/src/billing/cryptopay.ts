// Crypto Pay (@CryptoBot) — единственный файл, знающий его wire-формат.
// Доки: https://help.send.tg/en/articles/10279948-crypto-pay-api (сверено 19.07.2026).
// - createInvoice: asset+amount (currency_type=crypto), payload (до 4кб, round-trip);
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
  type PaymentProvider,
} from './provider';

const MAINNET = 'https://pay.crypt.bot/api';
const TESTNET = 'https://testnet-pay.crypt.bot/api';

function apiBase(): string {
  return config.cryptoPayTestnet ? TESTNET : MAINNET;
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
    userId: ref.userId,
    packId: ref.packId,
    paidAmount: paidAmount !== null && Number.isFinite(paidAmount) ? paidAmount : null,
    paidAsset: typeof inv.asset === 'string' ? inv.asset.toUpperCase() : null,
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
    const asset = input.pack.cryptoAsset ?? 'USDT';
    const amount = input.pack.cryptoAmount;
    if (!amount || amount <= 0) {
      throw new Error(`У пакета «${input.pack.id}» не задана крипто-цена (cryptoAmount)`);
    }
    const res = await fetch(`${apiBase()}/createInvoice`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Crypto-Pay-API-Token': config.cryptoPayToken,
      },
      body: JSON.stringify({
        currency_type: 'crypto',
        asset,
        amount: String(amount),
        description: `${input.pack.title} — ${input.pack.credits} кредитов SwapForge`,
        payload: encodeRef(input.userId, input.pack.id),
        paid_btn_name: 'callback',
        paid_btn_url: `${config.publicBaseUrl}#billing`,
        expires_in: 3600,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: unknown;
      result?: { mini_app_invoice_url?: string; bot_invoice_url?: string; web_app_invoice_url?: string };
    };
    if (!res.ok || !json.ok || !json.result) {
      throw new Error(`Crypto Pay отклонил создание счёта: ${JSON.stringify(json.error ?? res.status)}`);
    }
    const r = json.result;
    const payUrl = r.mini_app_invoice_url || r.bot_invoice_url || r.web_app_invoice_url;
    if (!payUrl) throw new Error('Crypto Pay не вернул ссылку на оплату');
    return { payUrl };
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
    const sig = headers['crypto-pay-api-signature'];
    return verifyCryptoPaySignature(rawBody, typeof sig === 'string' ? sig : '', config.cryptoPayToken);
  }

  parseWebhook(rawBody: Buffer): PaymentEvent {
    return parseCryptoPayEvent(rawBody);
  }
}
