// ЕДИНСТВЕННЫЙ файл, знающий wire-формат Tribute (сверено с живой OpenAPI-спекой
// https://tribute.tg/api/v1/openapi/en, 19.07.2026):
// - подпись: header `trbt-signature` = HMAC-SHA256(тело запроса, API-ключ);
// - конверт: { name, created_at, sent_at, payload };
// - new_digital_product: payload { product_id, product_name, amount (в минимальных
//   единицах), currency, telegram_user_id, purchase_id («use for idempotency»), … };
// - digital_product_refunded: тот же payload + refund_reason/refunded_at.
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyTributeSignature(rawBody: Buffer, signatureHeader: string, apiKey: string): boolean {
  if (!apiKey || !signatureHeader) return false;
  const mac = createHmac('sha256', apiKey).update(rawBody).digest();
  // кодировка подписи в доках не зафиксирована — принимаем hex ИЛИ base64
  for (const candidate of [mac.toString('hex'), mac.toString('base64')]) {
    const a = Buffer.from(candidate);
    const b = Buffer.from(signatureHeader.trim());
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

export type TributeEvent =
  | {
      kind: 'purchase';
      /** UNIQUE-ключ идемпотентности леджера. */
      paymentRef: string;
      telegramUserId: number;
      productId: number | null;
      productName: string;
      amountMinor: number;
      currency: string;
    }
  | {
      kind: 'refund';
      paymentRef: string;
      telegramUserId: number | null;
      productId: number | null;
      amountMinor: number;
      currency: string;
    }
  | { kind: 'ignored'; name: string }
  | { kind: 'invalid'; reason: string };

export function parseTributeEvent(rawBody: Buffer): TributeEvent {
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
  } catch {
    return { kind: 'invalid', reason: 'not_json' };
  }
  const name = typeof envelope.name === 'string' ? envelope.name : '';
  const p = (envelope.payload ?? {}) as Record<string, unknown>;

  if (name === 'new_digital_product') {
    const tgId = num(p.telegram_user_id);
    const purchaseId = num(p.purchase_id);
    const amount = num(p.amount);
    if (tgId === null || purchaseId === null || amount === null) {
      return { kind: 'invalid', reason: 'missing_fields' };
    }
    return {
      kind: 'purchase',
      paymentRef: `tribute:${purchaseId}`,
      telegramUserId: tgId,
      productId: num(p.product_id),
      productName: typeof p.product_name === 'string' ? p.product_name : '',
      amountMinor: amount,
      currency: typeof p.currency === 'string' ? p.currency.toLowerCase() : '',
    };
  }

  if (name === 'digital_product_refunded') {
    const purchaseId = num(p.purchase_id);
    const amount = num(p.amount);
    if (purchaseId === null || amount === null) return { kind: 'invalid', reason: 'missing_fields' };
    return {
      kind: 'refund',
      // отдельный ref: рефанд не должен коллидировать с purchase-строкой того же purchase_id
      paymentRef: `tribute-refund:${purchaseId}`,
      telegramUserId: num(p.telegram_user_id),
      productId: num(p.product_id),
      amountMinor: amount,
      currency: typeof p.currency === 'string' ? p.currency.toLowerCase() : '',
    };
  }

  return name ? { kind: 'ignored', name } : { kind: 'invalid', reason: 'no_name' };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
