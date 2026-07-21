import { createHash, randomUUID } from 'node:crypto';
import { config } from '../config';
import { getDb } from '../db';
import { tx } from './credits';
import { cryptoPayAvailableToRole } from './cryptopay';
import { getPack } from './packs';
import {
  getProvider,
  type CheckoutResult,
  type PaymentEvent,
  type PaymentProvider,
  type ProviderId,
  type ProviderPaymentStatus,
} from './provider';

export type PaymentIntentStatus =
  | 'creating'
  | 'pending'
  | 'paid'
  | 'credited'
  | 'expired'
  | 'cancelled'
  | 'failed'
  | 'quarantined';

export interface PaymentIntentRow {
  id: string;
  user_id: string;
  provider: ProviderId;
  external_id: string | null;
  credits_cents: number;
  paid_currency: string;
  expected_paid_minor: number;
  status: PaymentIntentStatus;
  pay_url: string | null;
  expires_at: string | null;
  reconcile_after: string;
  reconcile_attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  paid_at: string | null;
  credited_at: string | null;
}

export interface PublicPaymentIntent {
  id: string;
  provider: ProviderId;
  amountUsd: number;
  status: PaymentIntentStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  creditedAt: string | null;
}

const TERMINAL = new Set<PaymentIntentStatus>([
  'credited',
  'expired',
  'cancelled',
  'failed',
  'quarantined',
]);

function nowSql(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function nextReconcile(attempts: number): string {
  const delays = [10, 30, 120, 600, 1800, 3600];
  const seconds = delays[Math.min(Math.max(0, attempts), delays.length - 1)]!;
  return new Date(Date.now() + seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function expectedPayment(provider: ProviderId, creditsCents: number): { currency: string; minor: number } {
  if (provider === 'lavatop') {
    return {
      currency: 'RUB',
      minor: Math.round((creditsCents / 100) * config.lavaRubPerUsd * 100),
    };
  }
  return { currency: 'USD', minor: creditsCents };
}

function findIntent(id: string): PaymentIntentRow | undefined {
  return getDb().prepare(`SELECT * FROM payment_intents WHERE id = ?`).get(id) as PaymentIntentRow | undefined;
}

export function createPaymentIntent(userId: string, provider: ProviderId, creditsCents: number): PaymentIntentRow {
  const expected = expectedPayment(provider, creditsCents);
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO payment_intents
        (id, user_id, provider, credits_cents, paid_currency, expected_paid_minor)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, userId, provider, creditsCents, expected.currency, expected.minor);
  return findIntent(id)!;
}

export function markPaymentIntentPending(intentId: string, result: CheckoutResult, payUrl: string): void {
  getDb()
    .prepare(
      `UPDATE payment_intents
          SET external_id=?, paid_currency=?, expected_paid_minor=?, status='pending', pay_url=?,
              expires_at=?, reconcile_after=datetime('now','+10 seconds'), updated_at=datetime('now'), last_error=NULL
        WHERE id=? AND status='creating'`,
    )
    .run(
      result.externalId,
      result.paidCurrency.toUpperCase(),
      result.expectedPaidAmountMinor,
      payUrl,
      result.expiresAt,
      intentId,
    );
}

/** A timeout may happen after the provider created an invoice. Keep the creating intent recoverable. */
export function markPaymentIntentCreationUncertain(intentId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  getDb()
    .prepare(
      `UPDATE payment_intents
          SET last_error=?, reconcile_attempts=reconcile_attempts+1,
              reconcile_after=datetime('now','+10 seconds'), updated_at=datetime('now')
        WHERE id=? AND status='creating'`,
    )
    .run(message.slice(0, 300), intentId);
}

export function listPaymentIntents(userId: string, limit = 20): PublicPaymentIntent[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM payment_intents WHERE user_id=?
        ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(userId, Math.max(1, Math.min(100, limit))) as unknown as PaymentIntentRow[];
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    amountUsd: row.credits_cents / 100,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    creditedAt: row.credited_at,
  }));
}

export function listRecoverablePaymentIntents(
  status: 'pending' | 'quarantined' | 'creating' | 'paid',
  limit = 100,
): PaymentIntentRow[] {
  return getDb()
    .prepare(`SELECT * FROM payment_intents WHERE status=? ORDER BY created_at ASC LIMIT ?`)
    .all(status, Math.max(1, Math.min(500, limit))) as unknown as PaymentIntentRow[];
}

function eventPaidMinor(provider: ProviderId, event: Extract<PaymentEvent, { kind: 'purchase' }>): number | null {
  const amount = provider === 'lavatop' ? event.paidAmount : event.paidAmountUsd;
  return typeof amount === 'number' && Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function legacyIntent(
  provider: ProviderId,
  event: Extract<PaymentEvent, { kind: 'purchase' }>,
): PaymentIntentRow | undefined {
  const user = getDb().prepare(`SELECT id FROM users WHERE id=?`).get(event.userId) as { id: string } | undefined;
  const pack = event.packId ? getPack(event.packId) : null;
  const creditsCents = event.amountCents ?? pack?.credits ?? null;
  if (!user || creditsCents === null || creditsCents <= 0) return undefined;
  const expected = expectedPayment(provider, creditsCents);
  const expectedMinor = provider === 'lavatop' ? event.expectedPaidAmountMinor ?? expected.minor : expected.minor;
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO payment_intents
        (id,user_id,provider,external_id,credits_cents,paid_currency,expected_paid_minor,status,reconcile_after)
       VALUES (?,?,?,?,?,?,?,'pending',datetime('now'))`,
    )
    .run(id, event.userId, provider, event.externalId, creditsCents, expected.currency, expectedMinor);
  return findIntent(id);
}

export type PaymentProcessResult =
  | { outcome: 'credited'; intentId: string; amountUsd: number }
  | { outcome: 'replay'; intentId: string | null }
  | { outcome: 'quarantined'; intentId: string | null; reason: string };

function quarantine(
  eventId: string,
  intent: PaymentIntentRow | undefined,
  reason: string,
): PaymentProcessResult {
  const d = getDb();
  d.prepare(`UPDATE payment_events SET outcome='quarantined', reason=?, processed_at=datetime('now') WHERE id=?`)
    .run(reason.slice(0, 300), eventId);
  if (intent && intent.status !== 'credited') {
    d.prepare(
      `UPDATE payment_intents SET status='quarantined', last_error=?, updated_at=datetime('now') WHERE id=?`,
    ).run(reason.slice(0, 300), intent.id);
  }
  return { outcome: 'quarantined', intentId: intent?.id ?? null, reason };
}

/** Webhooks and reconciliation meet here. The inbox, intent transition and ledger credit share one transaction. */
export function processPaidEvent(
  provider: ProviderId,
  event: Extract<PaymentEvent, { kind: 'purchase' }>,
  options: { source: 'webhook' | 'reconcile'; eventHash: string; verified?: boolean },
): PaymentProcessResult {
  const d = getDb();
  return tx(d, () => {
    const eventId = randomUUID();
    const inserted = d
      .prepare(
        `INSERT OR IGNORE INTO payment_events
          (id,provider,event_hash,external_ref,intent_id,source,verified,outcome)
         VALUES (?,?,?,?,?,?,?,'received')`,
      )
      .run(
        eventId,
        provider,
        options.eventHash,
        event.externalId,
        null,
        options.source,
        options.verified === false ? 0 : 1,
      );
    if (inserted.changes === 0) {
      const previous = d
        .prepare(`SELECT intent_id FROM payment_events WHERE event_hash=?`)
        .get(options.eventHash) as { intent_id: string | null } | undefined;
      return { outcome: 'replay', intentId: previous?.intent_id ?? null };
    }

    let intent = event.intentId ? findIntent(event.intentId) : undefined;
    if (!intent) {
      intent = d
        .prepare(`SELECT * FROM payment_intents WHERE provider=? AND external_id=?`)
        .get(provider, event.externalId) as PaymentIntentRow | undefined;
    }
    if (!intent) intent = legacyIntent(provider, event);
    if (intent) d.prepare(`UPDATE payment_events SET intent_id=? WHERE id=?`).run(intent.id, eventId);

    if (options.verified === false) return quarantine(eventId, intent, 'signature_not_verified');
    if (!intent) return quarantine(eventId, undefined, 'intent_not_found');
    if (intent.provider !== provider) return quarantine(eventId, intent, 'provider_mismatch');
    if (intent.external_id && intent.external_id !== event.externalId) {
      return quarantine(eventId, intent, 'external_id_mismatch');
    }
    if (intent.user_id !== event.userId || (event.amountCents !== undefined && intent.credits_cents !== event.amountCents)) {
      return quarantine(eventId, intent, 'user_or_credit_amount_mismatch');
    }
    const user = d.prepare(`SELECT role,status,sandbox_of FROM users WHERE id=?`).get(intent.user_id) as
      | { role: string; status: string; sandbox_of: string | null }
      | undefined;
    if (!user || user.status !== 'active') return quarantine(eventId, intent, 'user_unavailable');
    if (provider === 'cryptopay' && !cryptoPayAvailableToRole(user.role, undefined, !!user.sandbox_of)) {
      return quarantine(eventId, intent, 'cryptopay_testnet_owner_only');
    }

    const paidMinor = eventPaidMinor(provider, event);
    const currency = event.paidCurrency?.toUpperCase() ?? null;
    if (currency !== intent.paid_currency || paidMinor === null || paidMinor < intent.expected_paid_minor) {
      return quarantine(eventId, intent, 'currency_or_amount_mismatch');
    }

    if (intent.status === 'credited') {
      d.prepare(`UPDATE payment_events SET outcome='replay', processed_at=datetime('now') WHERE id=?`).run(eventId);
      return { outcome: 'replay', intentId: intent.id };
    }
    if (TERMINAL.has(intent.status)) return quarantine(eventId, intent, `intent_terminal_${intent.status}`);

    d.prepare(
      `UPDATE payment_intents
          SET external_id=COALESCE(external_id,?), status='paid', paid_at=COALESCE(paid_at,datetime('now')),
              updated_at=datetime('now'), last_error=NULL
        WHERE id=?`,
    ).run(event.externalId, intent.id);
    const ledger = d
      .prepare(
        `INSERT OR IGNORE INTO credit_ledger
          (id,user_id,delta_credits,kind,payment_ref,note)
         VALUES (?,?,?,'purchase',?,?)`,
      )
      .run(
        randomUUID(),
        intent.user_id,
        intent.credits_cents,
        event.paymentRef,
        `пополнение $${(intent.credits_cents / 100).toFixed(2)} через ${provider}`,
      );
    d.prepare(
      `UPDATE payment_intents
          SET status='credited', credited_at=COALESCE(credited_at,datetime('now')), updated_at=datetime('now')
        WHERE id=?`,
    ).run(intent.id);
    d.prepare(`UPDATE payment_events SET outcome=?, processed_at=datetime('now') WHERE id=?`).run(
      ledger.changes > 0 ? 'credited' : 'ledger_replay',
      eventId,
    );
    return ledger.changes > 0
      ? { outcome: 'credited', intentId: intent.id, amountUsd: intent.credits_cents / 100 }
      : { outcome: 'replay', intentId: intent.id };
  });
}

export function webhookEventHash(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex');
}

export interface PaymentEventSummary {
  provider: string;
  source: string;
  verified: boolean;
  outcome: string;
  reason: string | null;
  createdAt: string;
}

/** Последние входящие события оплат (вебхуки/сверки) — диагностика владельца. */
export function listRecentPaymentEvents(limit = 15): PaymentEventSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT provider, source, verified, outcome, reason, created_at
         FROM payment_events ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(Math.max(1, Math.min(100, limit))) as Array<{
    provider: string;
    source: string;
    verified: number;
    outcome: string;
    reason: string | null;
    created_at: string;
  }>;
  return rows.map((r) => ({
    provider: r.provider,
    source: r.source,
    verified: r.verified === 1,
    outcome: r.outcome,
    reason: r.reason,
    createdAt: r.created_at,
  }));
}

/** Счётчики интентов по статусам — сводка «где застряли деньги». */
export function paymentIntentStats(): Record<string, number> {
  const rows = getDb()
    .prepare(`SELECT status, COUNT(*) AS n FROM payment_intents GROUP BY status`)
    .all() as Array<{ status: string; n: number }>;
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

export function recordPaymentEventReceipt(input: {
  provider: ProviderId;
  eventHash: string;
  source?: 'webhook' | 'reconcile';
  verified: boolean;
  outcome: string;
  reason?: string;
}): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO payment_events
        (id,provider,event_hash,source,verified,outcome,reason,processed_at)
       VALUES (?,?,?,?,?,?,?,datetime('now'))`,
    )
    .run(
      randomUUID(),
      input.provider,
      input.eventHash,
      input.source ?? 'webhook',
      input.verified ? 1 : 0,
      input.outcome.slice(0, 80),
      input.reason?.slice(0, 300) ?? null,
    );
}

function reconciledEvent(intent: PaymentIntentRow, status: ProviderPaymentStatus): Extract<PaymentEvent, { kind: 'purchase' }> {
  const paidAmount = status.paidAmountMinor === null ? null : status.paidAmountMinor / 100;
  return {
    kind: 'purchase',
    paymentRef: `${intent.provider}:${status.externalId}`,
    externalId: status.externalId,
    intentId: intent.id,
    userId: status.userId ?? intent.user_id,
    amountCents: status.amountCents ?? intent.credits_cents,
    paidCurrency: status.paidCurrency,
    ...(intent.provider === 'lavatop'
      ? { paidAmount, expectedPaidAmountMinor: intent.expected_paid_minor }
      : { paidAmountUsd: paidAmount }),
  };
}

function updateRemoteState(intent: PaymentIntentRow, status: ProviderPaymentStatus): void {
  const target = status.state === 'expired' ? 'expired' : status.state === 'cancelled' ? 'cancelled' : 'failed';
  getDb()
    .prepare(
      `UPDATE payment_intents SET status=?, external_id=COALESCE(external_id,?), expires_at=COALESCE(expires_at,?),
          updated_at=datetime('now'), last_error=NULL WHERE id=? AND status IN ('creating','pending','paid')`,
    )
    .run(target, status.externalId, status.expiresAt, intent.id);
}

export async function reconcilePaymentIntent(
  intentId: string,
  providerOverride?: PaymentProvider,
): Promise<PaymentProcessResult | null> {
  let intent = findIntent(intentId);
  if (!intent || TERMINAL.has(intent.status)) return null;
  const provider = providerOverride ?? getProvider(intent.provider);
  if (!provider || !provider.ready) {
    getDb()
      .prepare(
        `UPDATE payment_intents SET last_error='provider_not_ready', reconcile_attempts=reconcile_attempts+1,
          reconcile_after=?, updated_at=datetime('now') WHERE id=?`,
      )
      .run(nextReconcile(intent.reconcile_attempts + 1), intent.id);
    return null;
  }
  try {
    const status = intent.external_id
      ? await provider.getPayment(intent.external_id)
      : await provider.findRecentPayment(intent.id);
    if (!status) throw new Error('invoice_not_found');
    if (!intent.external_id) {
      getDb()
        .prepare(
          `UPDATE payment_intents SET external_id=?, status='pending', expires_at=COALESCE(expires_at,?),
            updated_at=datetime('now') WHERE id=? AND status='creating'`,
        )
        .run(status.externalId, status.expiresAt, intent.id);
      intent = findIntent(intent.id)!;
    }
    if (status.state === 'paid') {
      const event = reconciledEvent(intent, status);
      return processPaidEvent(intent.provider, event, {
        source: 'reconcile',
        eventHash: createHash('sha256')
          .update(`reconcile:${intent.provider}:${status.externalId}:${status.state}:${status.paidAmountMinor ?? ''}`)
          .digest('hex'),
      });
    }
    if (status.state !== 'pending') {
      updateRemoteState(intent, status);
      return null;
    }
    getDb()
      .prepare(
        `UPDATE payment_intents SET reconcile_attempts=reconcile_attempts+1, reconcile_after=?,
          expires_at=COALESCE(expires_at,?), updated_at=datetime('now'), last_error=NULL WHERE id=?`,
      )
      .run(nextReconcile(intent.reconcile_attempts + 1), status.expiresAt, intent.id);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const ageMs = Date.now() - Date.parse(`${intent.created_at.replace(' ', 'T')}Z`);
    if (intent.status === 'creating' && ageMs >= 24 * 60 * 60 * 1000) {
      getDb()
        .prepare(
          `UPDATE payment_intents SET status='failed', updated_at=datetime('now'), last_error=? WHERE id=?`,
        )
        .run(`invoice_not_recovered: ${message}`.slice(0, 300), intent.id);
      return null;
    }
    getDb()
      .prepare(
        `UPDATE payment_intents SET reconcile_attempts=reconcile_attempts+1, reconcile_after=?,
          updated_at=datetime('now'), last_error=? WHERE id=?`,
      )
      .run(nextReconcile(intent.reconcile_attempts + 1), message.slice(0, 300), intent.id);
    return null;
  }
}

export async function reconcileDuePaymentIntents(limit = 50): Promise<number> {
  const rows = getDb()
    .prepare(
      `SELECT id FROM payment_intents
        WHERE status IN ('creating','pending','paid') AND reconcile_after <= ?
        ORDER BY reconcile_after ASC LIMIT ?`,
    )
    .all(nowSql(), Math.max(1, Math.min(200, limit))) as Array<{ id: string }>;
  for (const row of rows) await reconcilePaymentIntent(row.id);
  return rows.length;
}
