import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EstimateInfo } from '../../shared/api-types';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-ref-invalidation-'));
process.env.USER_MARGIN_PCT = '25';

const { getDb } = await import('../src/db');
const { grantPurchase } = await import('../src/billing/credits');
const { issueFlowQuote, confirmFlowQuote } = await import('../src/billing/attempts');
const { invalidateReferenceAnalysis } = await import('../src/routes');
const { ensureProjectDirs, startDir } = await import('../src/storage');

const estimate: EstimateInfo = {
  stages: ['render'],
  openai: { perTask: [], usd: 0, priceDate: '2026-07-21' },
  wavespeed: {
    usd: 1,
    billedSeconds: 6,
    perSecondUsd: 1 / 6,
    resolution: '720p',
    priceDate: '2026-07-21',
    unavailableReason: null,
  },
  totalUsd: 1,
  approximate: false,
  balanceUsd: 10,
  warnings: [],
};

let userId: string;
let projectId: string;
const flagsJson = '{"removeText":false,"enhanceFigure":false,"wish":"","generateAudio":true}';

beforeEach(() => {
  userId = randomUUID();
  projectId = randomUUID();
  getDb().prepare(`INSERT INTO users (id, telegram_id) VALUES (?, ?)`).run(userId, Math.floor(Math.random() * 1e9) + 1);
  getDb()
    .prepare(
      `INSERT INTO projects (id, user_id, title, status, frames_json, analysis_json, tags_json, flags_json)
       VALUES (?, ?, 'p', 'complete', '[]', '{}', '[]', ?)`,
    )
    .run(projectId, userId, flagsJson);
  getDb()
    .prepare(`INSERT INTO refs (id, project_id, idx, role, file, note) VALUES (?, ?, 0, 'model', 'model.jpg', '')`)
    .run(randomUUID(), projectId);
  getDb()
    .prepare(`INSERT INTO prompts (id, project_id, version, kind, text, params_json) VALUES (?, ?, 1, 'video', 'p', '{}')`)
    .run(randomUUID(), projectId);
  ensureProjectDirs(projectId);
  fs.mkdirSync(startDir(projectId), { recursive: true });
  fs.writeFileSync(path.join(startDir(projectId), 'start_v1_old.png'), 'old');
  grantPurchase(userId, 1_000, `test:${randomUUID()}`, 'test');
});

describe('reference mutation invalidation', () => {
  it('cancels an unstarted confirmed action, releases its hold and removes stale derivatives', () => {
    const quote = issueFlowQuote({
      userId,
      projectId,
      action: 'first',
      estimate,
      flagsJson,
    });
    const confirmed = confirmFlowQuote({
      quoteId: quote.quoteId!,
      userId,
      projectId,
      action: 'first',
      flagsJson,
    });
    expect(confirmed.ok).toBe(true);

    invalidateReferenceAnalysis(projectId);

    expect((getDb().prepare(`SELECT COUNT(*) AS c FROM prompts WHERE project_id=?`).get(projectId) as { c: number }).c).toBe(0);
    expect(fs.readdirSync(startDir(projectId))).toEqual([]);
    expect(
      (getDb().prepare(`SELECT status, error FROM flow_attempts WHERE id=?`).get(quote.quoteId!) as { status: string; error: string }),
    ).toEqual({ status: 'cancelled', error: 'references_changed' });
    expect(
      (getDb().prepare(`SELECT status FROM credit_holds WHERE project_id=?`).get(projectId) as { status: string }).status,
    ).toBe('released');
    expect(
      getDb().prepare(`SELECT status, analysis_json, tags_json FROM projects WHERE id=?`).get(projectId),
    ).toMatchObject({ status: 'storyboarded', analysis_json: null, tags_json: null });
  });
});
