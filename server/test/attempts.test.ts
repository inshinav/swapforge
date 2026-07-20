import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-attempts-'));
process.env.USER_MARGIN_PCT = '25';

const { getDb } = await import('../src/db');
const { grantPurchase, creditBalance } = await import('../src/billing/credits');
const { issueFlowQuote, confirmFlowQuote, markAttemptRunning, requireActiveAttempt, QUOTE_TTL_MS } = await import(
  '../src/billing/attempts'
);
import type { EstimateInfo } from '../../shared/api-types';

const estimate: EstimateInfo = {
  stages: ['analyze', 'generate', 'startframe', 'render'],
  openai: { perTask: [], usd: 1, priceDate: '2026-07-21' },
  wavespeed: {
    usd: 3,
    billedSeconds: 20,
    perSecondUsd: 0.15,
    resolution: '720p',
    priceDate: '2026-07-21',
    unavailableReason: null,
  },
  totalUsd: 4,
  approximate: false,
  balanceUsd: 100,
  warnings: [],
};

let userId: string;
let projectId: string;

beforeEach(() => {
  userId = randomUUID();
  projectId = randomUUID();
  getDb().prepare(`INSERT INTO users (id, telegram_id) VALUES (?, ?)`).run(userId, Math.floor(Math.random() * 1e9) + 1);
  getDb()
    .prepare(`INSERT INTO projects (id, user_id, title, flags_json) VALUES (?, ?, 'p', ?)`)
    .run(projectId, userId, '{"removeText":true,"enhanceFigure":false,"wish":"","generateAudio":true}');
  getDb()
    .prepare(`INSERT INTO refs (id, project_id, idx, role, file, note) VALUES (?, ?, 0, 'model', 'model.jpg', '')`)
    .run(randomUUID(), projectId);
  grantPurchase(userId, 10_000, `test:${randomUUID()}`, 'test balance');
});

function quote(nowMs = Date.now()) {
  return issueFlowQuote({
    userId,
    projectId,
    action: 'first',
    estimate,
    flagsJson: '{"removeText":true,"enhanceFigure":false,"wish":"","generateAudio":true}',
    version: null,
    nowMs,
  });
}

function confirm(quoteId: string, nowMs = Date.now()) {
  return confirmFlowQuote({
    quoteId,
    userId,
    projectId,
    action: 'first',
    flagsJson: '{"removeText":true,"enhanceFigure":false,"wish":"","generateAudio":true}',
    version: null,
    nowMs,
  });
}

describe('flow attempts and quotes', () => {
  it('snapshots one final price with the 25% margin exactly once', () => {
    const q = quote();
    expect(q.priceUsd).toBe(5);
    expect(q.quoteId).toBeTruthy();
    expect(q.expiresAt).toBeTruthy();
    const row = getDb()
      .prepare(`SELECT final_price_cents, pricing_snapshot_json, status FROM flow_attempts WHERE id=?`)
      .get(q.quoteId!) as { final_price_cents: number; pricing_snapshot_json: string; status: string };
    expect(row.final_price_cents).toBe(500);
    expect(JSON.parse(row.pricing_snapshot_json).marginPct).toBe(25);
    expect(row.status).toBe('quoted');
  });

  it('atomically creates one attempt/hold and makes a double confirmation a replay', () => {
    const q = quote();
    const first = confirm(q.quoteId!);
    expect(first).toMatchObject({ ok: true, replayed: false });
    const second = confirm(q.quoteId!);
    expect(second).toMatchObject({ ok: true, replayed: true });
    expect(
      (getDb().prepare(`SELECT COUNT(*) AS c FROM credit_holds WHERE project_id=?`).get(projectId) as { c: number }).c,
    ).toBe(1);
    expect(creditBalance(userId)).toMatchObject({ held: 500, available: 9_500 });
    if (first.ok) markAttemptRunning(first.attemptId);
    expect(
      (getDb().prepare(`SELECT status FROM flow_attempts WHERE id=?`).get(q.quoteId!) as { status: string }).status,
    ).toBe('running');
  });

  it('rejects an expired quote without creating a hold', () => {
    const t0 = Date.now();
    const q = quote(t0);
    expect(confirm(q.quoteId!, t0 + QUOTE_TTL_MS + 1)).toEqual({ ok: false, reason: 'stale' });
    expect(
      (getDb().prepare(`SELECT COUNT(*) AS c FROM credit_holds WHERE project_id=?`).get(projectId) as { c: number }).c,
    ).toBe(0);
  });

  it('invalidates a quote after reference role/order/content changes', () => {
    const q = quote();
    getDb().prepare(`UPDATE refs SET role='object' WHERE project_id=?`).run(projectId);
    expect(confirm(q.quoteId!)).toEqual({ ok: false, reason: 'stale' });
  });

  it('returns 402 data and creates nothing when balance is insufficient', () => {
    getDb().prepare(`DELETE FROM credit_ledger WHERE user_id=?`).run(userId);
    const q = quote();
    expect(confirm(q.quoteId!)).toEqual({
      ok: false,
      reason: 'insufficient',
      needCredits: 500,
      availableCredits: 0,
    });
  });

  it('fails closed immediately before provider work without an active attempt', () => {
    expect(() => requireActiveAttempt({ projectId })).toThrow(/Платный запуск не подтверждён/);
    const q = quote();
    const confirmed = confirm(q.quoteId!);
    expect(confirmed.ok).toBe(true);
    expect(requireActiveAttempt({ projectId })).toBe(q.quoteId);
  });

  it('keeps the owner unmetered at the provider guard', () => {
    getDb().prepare(`UPDATE users SET role='owner' WHERE id=?`).run(userId);
    expect(requireActiveAttempt({ projectId })).toBeNull();
  });
});
