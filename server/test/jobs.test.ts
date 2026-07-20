import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-durable-jobs-'));

const { getDb } = await import('../src/db');
const {
  _dropRuntimeJobsForTests,
  _pauseJobsForTests,
  enqueueProjectJob,
  isQueued,
  registerDurableJobKind,
  resumeDurableJobs,
  waitForJobsIdle,
} = await import('../src/jobs');

describe('durable local jobs', () => {
  it('persists payload, reclaims a running lease after restart and executes exactly once', async () => {
    const projectId = 'durable-project';
    getDb().prepare(`INSERT INTO projects (id, title) VALUES (?, 'p')`).run(projectId);
    let calls = 0;
    registerDurableJobKind('test-durable', (id, payload) => ({
      projectId: id,
      label: 'test-durable',
      busyStatus: 'analyzing',
      doneStatus: 'analyzed',
      errorFallbackStatus: 'storyboarded',
      payload,
      fn: async () => {
        calls += Number(payload.increment ?? 0);
      },
    }));
    _pauseJobsForTests(true);
    enqueueProjectJob({
      projectId,
      label: 'test-durable',
      busyStatus: 'analyzing',
      doneStatus: 'analyzed',
      errorFallbackStatus: 'storyboarded',
      payload: { increment: 1 },
      fn: async () => {
        throw new Error('in-memory handler must be lost');
      },
    });
    const row = getDb().prepare(`SELECT id, payload_json FROM jobs WHERE project_id=?`).get(projectId) as {
      id: string;
      payload_json: string;
    };
    expect(JSON.parse(row.payload_json)).toEqual({ increment: 1 });
    expect(isQueued(projectId)).toBe(true);
    getDb()
      .prepare(`UPDATE jobs SET status='running', lease_owner='dead', lease_expires_at=datetime('now','+1 hour') WHERE id=?`)
      .run(row.id);
    _dropRuntimeJobsForTests();
    _pauseJobsForTests(false);
    expect(resumeDurableJobs()).toBe(1);
    await waitForJobsIdle();

    expect(calls).toBe(1);
    expect(getDb().prepare(`SELECT status, attempts FROM jobs WHERE id=?`).get(row.id)).toMatchObject({
      status: 'done',
      attempts: 1,
    });
    expect(getDb().prepare(`SELECT status FROM projects WHERE id=?`).get(projectId)).toEqual({ status: 'analyzed' });
  });

  it('allows only one active local job per project', () => {
    const projectId = 'one-active-project';
    getDb().prepare(`INSERT INTO projects (id, title) VALUES (?, 'p')`).run(projectId);
    _pauseJobsForTests(true);
    const options = {
      projectId,
      label: 'test-durable',
      busyStatus: 'analyzing',
      doneStatus: 'analyzed',
      errorFallbackStatus: 'storyboarded',
      payload: { increment: 1 },
      fn: async () => undefined,
    };
    enqueueProjectJob(options);
    expect(() => enqueueProjectJob(options)).toThrow(/UNIQUE/);
    getDb().prepare(`UPDATE jobs SET status='cancelled' WHERE project_id=?`).run(projectId);
    _dropRuntimeJobsForTests();
    _pauseJobsForTests(false);
  });
});
