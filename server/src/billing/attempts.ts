import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../db';
import { config } from '../config';
import { loadReferenceManifest, referenceFingerprint } from '../engine/reference-manifest';
import { creditBalance, priceCredits, tx } from './credits';
import type { DatabaseSync } from 'node:sqlite';
import type { EstimateForUser, EstimateInfo, FlowAction, RefInfo } from '../../../shared/api-types';

export const QUOTE_TTL_MS = 5 * 60_000;

interface QuoteRow {
  id: string;
  user_id: string;
  project_id: string;
  action: FlowAction;
  version: number | null;
  source_generation_id: string | null;
  final_price_cents: number | null;
  ref_fingerprint: string;
  context_fingerprint: string;
  status: string;
  expires_at: string;
  hold_id: string | null;
}

function sqliteTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

function refsFor(projectId: string): RefInfo[] {
  return loadReferenceManifest(projectId).refs;
}

export function quoteContextFingerprint(input: {
  projectId: string;
  flagsJson: string | null;
  action: FlowAction;
  version?: number | null;
  sourceGenerationId?: string | null;
}): { refFingerprint: string; contextFingerprint: string } {
  const refFingerprint = referenceFingerprint(refsFor(input.projectId));
  const payload = {
    refFingerprint,
    flags: input.flagsJson ?? '',
    action: input.action,
    version: input.version ?? null,
    sourceGenerationId: input.sourceGenerationId ?? null,
  };
  return {
    refFingerprint,
    contextFingerprint: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  };
}

export function issueFlowQuote(input: {
  userId: string;
  projectId: string;
  action: FlowAction;
  estimate: EstimateInfo;
  flagsJson: string | null;
  version?: number | null;
  sourceGenerationId?: string | null;
  nowMs?: number;
}): EstimateForUser {
  const nowMs = input.nowMs ?? Date.now();
  const finalPriceCents = input.estimate.totalUsd === null ? null : priceCredits(input.estimate.totalUsd);
  const { refFingerprint, contextFingerprint } = quoteContextFingerprint(input);
  const quoteId = finalPriceCents === null ? null : randomUUID();
  const expiresAt = quoteId ? sqliteTime(nowMs + QUOTE_TTL_MS) : null;
  if (quoteId && expiresAt) {
    const db = getDb();
    tx(db, () => {
      db.prepare(
        `UPDATE flow_attempts
            SET status='cancelled', finished_at=datetime('now'), error='superseded_quote'
          WHERE user_id=? AND project_id=? AND action=? AND status='quoted'`,
      ).run(input.userId, input.projectId, input.action);
      db.prepare(
        `INSERT INTO flow_attempts
          (id, user_id, project_id, action, version, source_generation_id, final_price_cents,
           pricing_snapshot_json, ref_fingerprint, context_fingerprint, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        quoteId,
        input.userId,
        input.projectId,
        input.action,
        input.version ?? null,
        input.sourceGenerationId ?? null,
        finalPriceCents,
        JSON.stringify({ estimate: input.estimate, marginPct: config.userMarginPct }),
        refFingerprint,
        contextFingerprint,
        expiresAt,
      );
    });
  }

  const { available } = creditBalance(input.userId);
  const warnings: string[] = [];
  if (finalPriceCents === null) {
    warnings.push('Точная смета временно недоступна — попробуй чуть позже');
  } else if (finalPriceCents > available) {
    warnings.push(`Нужно $${(finalPriceCents / 100).toFixed(2)}, на балансе $${(available / 100).toFixed(2)}`);
  }
  return {
    kind: 'balance',
    quoteId,
    action: input.action,
    expiresAt,
    refFingerprint,
    stages: input.estimate.stages,
    priceUsd: finalPriceCents === null ? null : finalPriceCents / 100,
    balanceUsd: available / 100,
    approximate: input.estimate.approximate,
    warnings,
  };
}

export type ConfirmQuoteResult =
  | { ok: true; attemptId: string; holdId: string; replayed: boolean }
  | { ok: false; reason: 'missing' | 'stale' | 'insufficient'; needCredits?: number; availableCredits?: number };

function confirmInTransaction(
  d: DatabaseSync,
  quote: QuoteRow,
  contextFingerprint: string,
  nowMs: number,
): ConfirmQuoteResult {
  if (quote.status === 'held' || quote.status === 'running') {
    if (!quote.hold_id) return { ok: false, reason: 'stale' };
    return { ok: true, attemptId: quote.id, holdId: quote.hold_id, replayed: true };
  }
  if (
    quote.status !== 'quoted' ||
    quote.final_price_cents === null ||
    quote.expires_at <= sqliteTime(nowMs) ||
    quote.context_fingerprint !== contextFingerprint
  ) {
    if (quote.status === 'quoted') {
      d.prepare(`UPDATE flow_attempts SET status='cancelled', finished_at=datetime('now'), error='quote_stale' WHERE id=?`).run(quote.id);
    }
    return { ok: false, reason: 'stale' };
  }

  const bal = d
    .prepare(`SELECT COALESCE(SUM(delta_credits), 0) AS s FROM credit_ledger WHERE user_id = ?`)
    .get(quote.user_id) as { s: number };
  const held = d
    .prepare(`SELECT COALESCE(SUM(credits), 0) AS s FROM credit_holds WHERE user_id = ? AND status = 'open'`)
    .get(quote.user_id) as { s: number };
  const available = bal.s - held.s;
  if (quote.final_price_cents > available) {
    return {
      ok: false,
      reason: 'insufficient',
      needCredits: quote.final_price_cents,
      availableCredits: Math.max(0, available),
    };
  }

  const holdId = randomUUID();
  d.prepare(
    `INSERT INTO credit_holds (id, user_id, project_id, credits, attempt_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(holdId, quote.user_id, quote.project_id, quote.final_price_cents, quote.id);
  d.prepare(
    `UPDATE flow_attempts SET status='held', hold_id=?, started_at=datetime('now')
      WHERE id=? AND status='quoted'`,
  ).run(holdId, quote.id);
  return { ok: true, attemptId: quote.id, holdId, replayed: false };
}

export function confirmFlowQuote(input: {
  quoteId: string;
  userId: string;
  projectId: string;
  action: FlowAction;
  flagsJson: string | null;
  version?: number | null;
  sourceGenerationId?: string | null;
  nowMs?: number;
}): ConfirmQuoteResult {
  const d = getDb();
  const quote = d
    .prepare(
      `SELECT id, user_id, project_id, action, version, source_generation_id, final_price_cents,
              ref_fingerprint, context_fingerprint, status, expires_at, hold_id
         FROM flow_attempts WHERE id=? AND user_id=? AND project_id=? AND action=?`,
    )
    .get(input.quoteId, input.userId, input.projectId, input.action) as QuoteRow | undefined;
  if (!quote) return { ok: false, reason: 'missing' };
  const { contextFingerprint } = quoteContextFingerprint(input);
  try {
    return tx(d, () => confirmInTransaction(d, quote, contextFingerprint, input.nowMs ?? Date.now()));
  } catch (error) {
    if (error instanceof Error && /UNIQUE/i.test(error.message)) {
      const replay = d
        .prepare(`SELECT hold_id, status FROM flow_attempts WHERE id=?`)
        .get(quote.id) as { hold_id: string | null; status: string } | undefined;
      if (replay?.hold_id && (replay.status === 'held' || replay.status === 'running')) {
        return { ok: true, attemptId: quote.id, holdId: replay.hold_id, replayed: true };
      }
      return { ok: false, reason: 'stale' };
    }
    throw error;
  }
}

export function markAttemptRunning(attemptId: string): void {
  getDb()
    .prepare(`UPDATE flow_attempts SET status='running' WHERE id=? AND status='held'`)
    .run(attemptId);
}

export class BillingAttemptRequiredError extends Error {
  constructor() {
    super('Платный запуск не подтверждён — обнови цену и нажми кнопку запуска ещё раз');
    this.name = 'BillingAttemptRequiredError';
  }
}

/** Fail-closed gate immediately before any paid AI/provider call. */
export function requireActiveAttempt(input: {
  projectId?: string | null;
  userId?: string | null;
  refFingerprint?: string | null;
  /** Carousel Studio: скоуп оплаты — открытая hold на carouselId (SPEC §7). */
  carouselId?: string | null;
  /** Reference Miner: скоуп оплаты — открытая hold на collectionId (темы/vision-карточки). */
  collectionId?: string | null;
}): string | null {
  const db = getDb();
  // Майнерская ветка изолирована (fail-closed на каждом шаге), как карусельная ниже.
  if (input.collectionId) {
    const col = db
      .prepare(`SELECT user_id FROM collections WHERE id=?`)
      .get(input.collectionId) as { user_id: string } | undefined;
    if (!col) throw new BillingAttemptRequiredError();
    const mUser = db.prepare(`SELECT role FROM users WHERE id=?`).get(col.user_id) as
      | { role: string }
      | undefined;
    if (mUser?.role === 'owner') return null;
    const mHold = db
      .prepare(
        `SELECT id FROM credit_holds WHERE project_id=? AND user_id=? AND status='open' LIMIT 1`,
      )
      .get(input.collectionId, col.user_id) as { id: string } | undefined;
    if (!mHold) throw new BillingAttemptRequiredError();
    return mHold.id;
  }
  // Карусельная ветка изолирована и не проваливается в проектную (fail-closed на каждом шаге).
  if (input.carouselId) {
    const carousel = db
      .prepare(`SELECT user_id FROM carousel_projects WHERE id=?`)
      .get(input.carouselId) as { user_id: string } | undefined;
    if (!carousel) throw new BillingAttemptRequiredError();
    const cUser = db.prepare(`SELECT role FROM users WHERE id=?`).get(carousel.user_id) as
      | { role: string }
      | undefined;
    if (cUser?.role === 'owner') return null;
    // Владелец hold обязан совпадать с владельцем карусели — чужая/подложная hold не проходит.
    const hold = db
      .prepare(
        `SELECT id FROM credit_holds WHERE project_id=? AND user_id=? AND status='open' LIMIT 1`,
      )
      .get(input.carouselId, carousel.user_id) as { id: string } | undefined;
    if (!hold) throw new BillingAttemptRequiredError();
    return hold.id;
  }
  let userId = input.userId ?? null;
  if (input.projectId) {
    const project = db
      .prepare(`SELECT user_id FROM projects WHERE id=?`)
      .get(input.projectId) as { user_id: string | null } | undefined;
    if (!project) throw new BillingAttemptRequiredError();
    userId = project.user_id;
  }
  // Legacy/system projects without a tenant predate paid accounts and remain an internal-only path.
  if (!userId) return null;
  const user = db.prepare(`SELECT role FROM users WHERE id=?`).get(userId) as { role: string } | undefined;
  if (user?.role === 'owner') return null;
  if (!input.projectId) throw new BillingAttemptRequiredError();
  const row = db
    .prepare(
      `SELECT a.id, a.ref_fingerprint
         FROM flow_attempts a
         JOIN credit_holds h ON h.id=a.hold_id AND h.status='open'
        WHERE a.project_id=? AND a.user_id=? AND a.status IN ('held','running')
        ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1`,
    )
    .get(input.projectId, userId) as { id: string; ref_fingerprint: string } | undefined;
  if (!row) throw new BillingAttemptRequiredError();
  const currentFingerprint = input.refFingerprint ?? loadReferenceManifest(input.projectId).fingerprint;
  if (row.ref_fingerprint !== currentFingerprint) throw new BillingAttemptRequiredError();
  return row.id;
}
