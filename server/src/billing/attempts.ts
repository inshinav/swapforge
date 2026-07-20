import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../db';
import { config } from '../config';
import { referenceFingerprint } from '../engine/reference-audit';
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
  return getDb()
    .prepare(`SELECT id, idx, role, file, note FROM refs WHERE project_id = ? ORDER BY idx ASC`)
    .all(projectId) as unknown as RefInfo[];
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
    getDb()
      .prepare(
        `INSERT INTO flow_attempts
          (id, user_id, project_id, action, version, source_generation_id, final_price_cents,
           pricing_snapshot_json, ref_fingerprint, context_fingerprint, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
