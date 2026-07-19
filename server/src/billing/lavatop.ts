// Lava.top — единственный файл, знающий его wire-формат.
// Доки: https://gate.lava.top/docs (OpenAPI, сверено 19.07.2026).
// - POST /api/v3/invoice: { email, offerId, currency, amount, clientUtm } → { paymentUrl };
//   amount работает у оффера с динамической ценой; маппинг кладём в clientUtm — он
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
  type PaymentProvider,
} from './provider';

const API_BASE = 'https://gate.lava.top';

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
  if (body.status !== 'completed') return { kind: 'ignored', reason: `status=${String(body.status)}` };

  const contractId = body.contractId;
  const utm = (body.clientUtm ?? {}) as Record<string, unknown>;
  // маппинг мы сами положили в UTM при создании инвойса
  const ref = decodeRef(typeof utm.utm_content === 'string' ? utm.utm_content : null);
  if (contractId === undefined || contractId === null || !ref) {
    return { kind: 'invalid', reason: 'missing_contract_or_utm' };
  }
  return {
    kind: 'purchase',
    paymentRef: `lavatop:${contractId}`,
    userId: ref.userId,
    amountCents: ref.amountCents,
    packId: ref.packId,
    paidAmountUsd:
      typeof body.amount === 'number'
        ? body.amount
        : typeof body.amount === 'string'
          ? Number(body.amount)
          : null,
    paidCurrency: typeof body.currency === 'string' ? body.currency.toUpperCase() : null,
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

    const res = await fetch(`${API_BASE}/api/v3/invoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.lavaApiKey },
      body: JSON.stringify({
        email,
        offerId: config.lavaDynamicOfferId,
        currency: 'USD',
        amount: input.amountUsd,
        // round-trip маппинг: userId+сумма переживут поход на оплату
        clientUtm: {
          utm_content: encodeRef(input.userId, Math.round(input.amountUsd * 100)),
          utm_term: `usd-${Math.round(input.amountUsd * 100)}`,
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
    const json = (await res.json().catch(() => ({}))) as { paymentUrl?: string; error?: unknown };
    if (!res.ok || !json.paymentUrl) {
      throw new Error(`Lava.top отклонил создание счёта: ${JSON.stringify(json.error ?? res.status)}`);
    }
    return { payUrl: json.paymentUrl };
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
