// Провайдер-нейтральный слой оплаты. Кредиты/холды/идемпотентность (credits.ts)
// НЕ знают про конкретного провайдера — они видят только этот интерфейс.
// Server-initiated: createCheckout сам создаёт инвойс и кладёт НАШ userId+сумму
// в провайдерский round-trip канал (payload у Crypto Pay, clientUtm у Lava) →
// вебхук возвращает их обратно, маппинг платёж→юзер 100%-й без внешних lookup.
import { config } from '../config';
import { CryptoPayProvider } from './cryptopay';
import { LavaTopProvider } from './lavatop';
export type ProviderId = 'cryptopay' | 'lavatop';

export interface CheckoutInput {
  /** Internal durable intent, created before the remote invoice. */
  intentId: string;
  userId: string;
  /** Сумма пользовательского баланса в USD; до входа в провайдер нормализована до центов. */
  amountUsd: number;
  /** Email покупателя (Lava требует; Crypto Pay игнорирует). */
  email?: string;
}

export interface CheckoutResult {
  /** Ссылка/URL виджета оплаты для редиректа юзера. */
  payUrl: string;
  externalId: string;
  paidCurrency: string;
  expectedPaidAmountMinor: number;
  expiresAt: string | null;
}

export type ProviderPaymentState = 'pending' | 'paid' | 'expired' | 'cancelled' | 'failed';

export interface ProviderPaymentStatus {
  externalId: string;
  intentId: string | null;
  userId: string | null;
  amountCents: number | null;
  state: ProviderPaymentState;
  paidCurrency: string | null;
  paidAmountMinor: number | null;
  expiresAt: string | null;
}

const CHECKOUT_HOSTS: Record<ProviderId, readonly string[]> = {
  cryptopay: ['t.me', 'telegram.me'],
  lavatop: ['lava.top'],
};

/** Prevent a compromised/malformed provider response from becoming an open redirect. */
export function validateCheckoutUrl(provider: ProviderId, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Платёжный провайдер вернул некорректную ссылку');
  }
  const hostname = url.hostname.toLowerCase();
  const allowed = CHECKOUT_HOSTS[provider].some(
    (root) => hostname === root || hostname.endsWith(`.${root}`),
  );
  if (url.protocol !== 'https:' || url.username || url.password || !allowed) {
    throw new Error('Платёжный провайдер вернул небезопасную ссылку');
  }
  return url.toString();
}

export type PaymentEvent =
  | {
      kind: 'purchase';
      /** UNIQUE-ключ идемпотентности леджера (провайдер:контракт). */
      paymentRef: string;
      externalId: string;
      intentId?: string;
      /** НАШ user_id (мы сами положили его в инвойс). */
      userId: string;
      /** Новые инвойсы содержат точную сумму пополнения; packId нужен для старых незакрытых счетов. */
      amountCents?: number;
      packId?: string;
      /** Номинал инвойса в USD для защиты от недоплаты/рассинхрона. */
      paidAmountUsd?: number | null;
      paidCurrency?: string | null;
      /** Фактически оплаченная сумма в paidCurrency (Lava RUB и старые крипто-инвойсы). */
      paidAmount?: number | null;
      paidAsset?: string | null;
      /** Ожидаемая сумма в минимальных единицах paidCurrency, зафиксированная при checkout. */
      expectedPaidAmountMinor?: number;
    }
  | { kind: 'ignored'; reason: string }
  | { kind: 'invalid'; reason: string };

export interface PaymentProvider {
  readonly id: ProviderId;
  /** Провайдер сконфигурирован (есть ключи) и готов создавать инвойсы. */
  readonly ready: boolean;
  /** Нужен ли email от покупателя перед checkout. */
  readonly needsEmail: boolean;
  createCheckout(input: CheckoutInput): Promise<CheckoutResult>;
  getPayment(externalId: string): Promise<ProviderPaymentStatus | null>;
  findRecentPayment(intentId: string): Promise<ProviderPaymentStatus | null>;
  /** Подпись/секрет вебхука по СЫРОМУ телу + заголовкам. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean;
  parseWebhook(rawBody: Buffer): PaymentEvent;
}

/** Единая упаковка userId+суммы в round-trip строку провайдера. */
export function encodeRef(userId: string, amountCents: number | string, intentId?: string): string {
  // string — только для тестов/обработки старых пакетных счетов.
  return typeof amountCents === 'number'
    ? JSON.stringify({ u: userId, c: amountCents, ...(intentId ? { i: intentId } : {}) })
    : JSON.stringify({ u: userId, p: amountCents, ...(intentId ? { i: intentId } : {}) });
}

export function decodeRef(
  raw: string | undefined | null,
): { userId: string; amountCents?: number; packId?: string; intentId?: string } | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as { u?: unknown; c?: unknown; p?: unknown; i?: unknown };
    if (typeof o.u !== 'string') return null;
    const intentId = typeof o.i === 'string' ? o.i : undefined;
    if (typeof o.c === 'number' && Number.isSafeInteger(o.c) && o.c > 0) {
      return { userId: o.u, amountCents: o.c, intentId };
    }
    // Совместимость с уже выпущенными пакетными инвойсами.
    if (typeof o.p === 'string') return { userId: o.u, packId: o.p, intentId };
  } catch {
    /* не наш payload */
  }
  return null;
}

// ── Реестр активных провайдеров ─────────────────────────────────────────────
// Ленивая инициализация: env читается один раз, тесты сбрасывают через _reset.
let registry: Map<ProviderId, PaymentProvider> | null = null;

function buildRegistry(): Map<ProviderId, PaymentProvider> {
  const enabled = new Set(
    config.billingProviders
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  // cryptopay/lavatop импортят encodeRef/decodeRef отсюда же — цикл значений
  // безопасен: конструкторы вызываются лениво, к этому моменту всё загружено
  const all: PaymentProvider[] = [new CryptoPayProvider(), new LavaTopProvider()];
  const map = new Map<ProviderId, PaymentProvider>();
  for (const p of all) if (enabled.has(p.id)) map.set(p.id, p);
  return map;
}

export function getProvider(id: string): PaymentProvider | undefined {
  if (!registry) registry = buildRegistry();
  return registry.get(id as ProviderId);
}

/** Провайдеры, доступные юзеру для оплаты (активны + сконфигурированы ключами). */
export function readyProviders(): PaymentProvider[] {
  if (!registry) registry = buildRegistry();
  return [...registry.values()].filter((p) => p.ready);
}

export function _resetProviders(): void {
  registry = null;
}
