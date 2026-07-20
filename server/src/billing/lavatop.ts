// Lava.top — единственный файл, знающий его wire-формат.
// Доки: https://gate.lava.top/docs (OpenAPI, сверено 19.07.2026).
// - POST /api/v3/invoice: { email, offerId, currency: 'RUB', amount, clientUtm } → { paymentUrl };
//   amount = выбранный USD-баланс × фиксированный LAVA_RUB_PER_USD; маппинг кладём в clientUtm — он
//   round-trip в вебхуке (email обязателен, но для маппинга не используется);
// - вебхук: { eventType, contractId, buyer.email, amount, currency, status, clientUtm };
// - auth: X-Api-Key заголовок (запросы И вебхук — ApiKeyWebhookAuth в ЛК).
//   Подписи HMAC у Lava нет → защита = HTTPS + секрет заголовка + (nginx) IP-whitelist.
import { timingSafeEqual } from 'node:crypto';
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

const API_BASE = 'https://gate.lava.top';

interface LavaInvoice {
  id?: string;
  status?: string;
  paymentUrl?: string;
  amountTotal?: number | string;
  receipt?: { amount?: number | string; currency?: string };
  clientUtm?: { utm_content?: string; utm_term?: string };
}

function finiteAmount(value: unknown): number | null {
  const amount = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function normalizeInvoice(invoice: LavaInvoice): ProviderPaymentStatus | null {
  if (!invoice.id) return null;
  const ref = decodeRef(invoice.clientUtm?.utm_content);
  const amount = finiteAmount(invoice.receipt?.amount ?? invoice.amountTotal);
  const rawStatus = String(invoice.status ?? '').toUpperCase();
  const state = rawStatus === 'COMPLETED' ? 'paid' : rawStatus === 'FAILED' ? 'failed' : 'pending';
  return {
    externalId: invoice.id,
    intentId: ref?.intentId ?? null,
    userId: ref?.userId ?? null,
    amountCents: ref?.amountCents ?? null,
    state,
    paidCurrency: typeof invoice.receipt?.currency === 'string' ? invoice.receipt.currency.toUpperCase() : 'RUB',
    paidAmountMinor: amount === null ? null : Math.round(amount * 100),
    expiresAt: null,
  };
}

async function lavaRequest(path: string): Promise<unknown> {
  if (!config.lavaApiKey) throw new Error('Lava.top не настроен на сервере');
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'X-Api-Key': config.lavaApiKey },
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Lava.top отклонил запрос: ${JSON.stringify(json)}`);
  return json;
}

export function parseLavaEvent(rawBody: Buffer): PaymentEvent {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
  } catch {
    return { kind: 'invalid', reason: 'not_json' };
  }
  const eventType = String(body.eventType ?? '');
  // нас интересует только успешная разовая покупка продукта
  if (eventType !== 'payment.success') return { kind: 'ignored', reason: eventType || 'no_event' };
  if (String(body.status ?? '').toLowerCase() !== 'completed') {
    return { kind: 'ignored', reason: `status=${String(body.status)}` };
  }

  const contractId = body.contractId;
  const utm = (body.clientUtm ?? {}) as Record<string, unknown>;
  // маппинг мы сами положили в UTM при создании инвойса
  const ref = decodeRef(typeof utm.utm_content === 'string' ? utm.utm_content : null);
  const expectedMatch = typeof utm.utm_term === 'string' ? /^rub-(\d+)$/.exec(utm.utm_term) : null;
  const expectedPaidAmountMinor = expectedMatch ? Number(expectedMatch[1]) : NaN;
  if (
    contractId === undefined ||
    contractId === null ||
    !ref ||
    !Number.isSafeInteger(expectedPaidAmountMinor) ||
    expectedPaidAmountMinor <= 0
  ) {
    return { kind: 'invalid', reason: 'missing_contract_or_utm' };
  }
  return {
    kind: 'purchase',
    paymentRef: `lavatop:${contractId}`,
    externalId: String(contractId),
    intentId: ref.intentId,
    userId: ref.userId,
    amountCents: ref.amountCents,
    packId: ref.packId,
    paidAmount:
      typeof body.amount === 'number'
        ? body.amount
        : typeof body.amount === 'string'
          ? Number(body.amount)
          : null,
    paidCurrency: typeof body.currency === 'string' ? body.currency.toUpperCase() : null,
    expectedPaidAmountMinor,
  };
}

export class LavaTopProvider implements PaymentProvider {
  readonly id = 'lavatop' as const;
  readonly needsEmail = true;

  get ready(): boolean {
    // ОБА секрета обязательны: без webhook-секрета юзер заплатит, но вебхук не
    // пройдёт verify → баланс не пополнится («оплачено, не доставлено»). Лучше
    // не показывать кнопку оплаты картой, пока конфиг неполон.
    return !!config.lavaApiKey && !!config.lavaWebhookSecret && !!config.lavaDynamicOfferId;
  }

  async createCheckout(input: CheckoutInput): Promise<CheckoutResult> {
    if (!this.ready) throw new Error('Lava.top не настроен на сервере');
    const email = (input.email ?? '').trim();
    if (!email) throw new Error('Для оплаты картой нужен email');
    const amountCents = Math.round(input.amountUsd * 100);
    const amountRub = Math.round(input.amountUsd * config.lavaRubPerUsd * 100) / 100;

    const res = await fetch(`${API_BASE}/api/v3/invoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.lavaApiKey },
      body: JSON.stringify({
        email,
        offerId: config.lavaDynamicOfferId,
        currency: 'RUB',
        amount: amountRub,
        // round-trip маппинг: userId+сумма переживут поход на оплату
        clientUtm: {
          utm_content: encodeRef(input.userId, amountCents, input.intentId),
          utm_term: `rub-${Math.round(amountRub * 100)}`,
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
    const json = (await res.json().catch(() => ({}))) as LavaInvoice & { error?: unknown };
    if (!res.ok || !json.paymentUrl || !json.id) {
      throw new Error(`Lava.top отклонил создание счёта: ${JSON.stringify(json.error ?? res.status)}`);
    }
    return {
      payUrl: json.paymentUrl,
      externalId: json.id,
      paidCurrency: 'RUB',
      expectedPaidAmountMinor: Math.round(amountRub * 100),
      expiresAt: null,
    };
  }

  async getPayment(externalId: string): Promise<ProviderPaymentStatus | null> {
    const invoice = (await lavaRequest(`/api/v1/invoices/${encodeURIComponent(externalId)}`)) as LavaInvoice;
    return normalizeInvoice(invoice);
  }

  async findRecentPayment(intentId: string): Promise<ProviderPaymentStatus | null> {
    const beginDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const query = new URLSearchParams({ beginDate, page: '0', size: '100' });
    for (const status of ['NEW', 'IN_PROGRESS', 'COMPLETED', 'FAILED']) query.append('invoiceStatuses', status);
    const result = (await lavaRequest(`/api/v1/invoices?${query}`)) as { items?: LavaInvoice[] };
    const invoice = (result.items ?? []).find(
      (item) => decodeRef(item.clientUtm?.utm_content)?.intentId === intentId,
    );
    return invoice ? normalizeInvoice(invoice) : null;
  }

  verifyWebhook(_rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
    // ApiKeyWebhookAuth: сверяем заголовок X-Api-Key с секретом вебхука (задаётся в ЛК Lava)
    const got = headers['x-api-key'];
    const want = config.lavaWebhookSecret;
    if (!want || typeof got !== 'string' || !got) return false;
    const a = Buffer.from(got);
    const b = Buffer.from(want);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseWebhook(rawBody: Buffer): PaymentEvent {
    return parseLavaEvent(rawBody);
  }
}
