// Durable очередь локальных CPU/LLM-стадий: до localJobConcurrency джобов
// ПАРАЛЛЕЛЬНО (разные проекты — уникальный индекс не даёт проекту двух джобов),
// внутри проекта порядок сохраняется. Удалённые рендеры живут отдельно:
// generations несёт свою конкурентность (renderConcurrency) и восстановление.
import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { config } from './config';
import { tx } from './billing/credits';

export const BUSY_STATUSES = new Set(['storyboarding', 'analyzing', 'generating', 'startframing']);
const LEASE_MS = 60_000;
const HEARTBEAT_MS = 15_000;
const workerId = randomUUID();

export interface ProjectJobOptions {
  projectId: string;
  label: string;
  busyStatus: string;
  doneStatus: string;
  errorFallbackStatus: string;
  payload?: Record<string, unknown>;
  fn: () => Promise<void>;
  onSuccess?: () => void;
  onError?: (msg: string) => void;
}

type DurableFactory = (projectId: string, payload: Record<string, unknown>) => ProjectJobOptions;

interface JobRow {
  id: string;
  project_id: string;
  kind: string;
  payload_json: string;
}

const factories = new Map<string, DurableFactory>();
const runtimeJobs = new Map<string, ProjectJobOptions>();
let activeRuns = 0;
let pausedForTests = false;
const idleWaiters = new Set<() => void>();

function sqliteTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

export function registerDurableJobKind(kind: string, factory: DurableFactory): void {
  factories.set(kind, factory);
}

function activeCount(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM jobs WHERE status IN ('queued','running')`)
    .get() as { c: number };
  return row.c;
}

function notifyIdle(): void {
  if (activeRuns > 0 || activeCount() > 0) return;
  for (const resolve of idleWaiters) resolve();
  idleWaiters.clear();
}

export function isQueued(projectId: string): boolean {
  return !!getDb()
    .prepare(`SELECT 1 FROM jobs WHERE project_id=? AND status IN ('queued','running') LIMIT 1`)
    .get(projectId);
}

function recordStageTime(projectId: string, label: string, seconds: number): void {
  try {
    const db = getDb();
    const row = db.prepare(`SELECT stage_times_json FROM projects WHERE id = ?`).get(projectId) as
      | { stage_times_json: string | null }
      | undefined;
    if (!row) return;
    let times: Record<string, number> = {};
    try {
      times = row.stage_times_json ? (JSON.parse(row.stage_times_json) as Record<string, number>) : {};
    } catch {
      /* повреждённый JSON заменяется */
    }
    times[label] = Math.round(seconds * 10) / 10;
    db.prepare(`UPDATE projects SET stage_times_json = ? WHERE id = ?`).run(JSON.stringify(times), projectId);
  } catch (error) {
    console.warn(`[jobs] stage-time не записан (${label}):`, error instanceof Error ? error.message : error);
  }
}

function claimNext(): JobRow | null {
  const db = getDb();
  return tx(db, () => {
    const row = db
      .prepare(
        `SELECT id, project_id, kind, payload_json FROM jobs
          WHERE status='queued' OR (status='running' AND lease_expires_at <= ?)
          ORDER BY created_at ASC, rowid ASC LIMIT 1`,
      )
      .get(sqliteTime(Date.now())) as JobRow | undefined;
    if (!row) return null;
    const claimed = db
      .prepare(
        `UPDATE jobs SET status='running', lease_owner=?, lease_expires_at=?, heartbeat_at=datetime('now'),
                         started_at=COALESCE(started_at, datetime('now')), attempts=attempts+1
          WHERE id=? AND (status='queued' OR lease_expires_at <= ?)`,
      )
      .run(workerId, sqliteTime(Date.now() + LEASE_MS), row.id, sqliteTime(Date.now()));
    return Number(claimed.changes) === 1 ? row : null;
  });
}

function resolveJob(row: JobRow): ProjectJobOptions | null {
  const live = runtimeJobs.get(row.id);
  if (live) return live;
  const factory = factories.get(row.kind);
  if (!factory) return null;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    /* handler validates the empty payload */
  }
  return factory(row.project_id, payload);
}

async function execute(row: JobRow): Promise<void> {
  const db = getDb();
  const job = resolveJob(row);
  if (!job) {
    db.prepare(
      `UPDATE jobs SET status='failed', error='Нет обработчика durable job', finished_at=datetime('now'),
                       lease_owner=NULL, lease_expires_at=NULL WHERE id=?`,
    ).run(row.id);
    return;
  }
  db.prepare(`UPDATE projects SET status=?, error=NULL WHERE id=?`).run(job.busyStatus, row.project_id);
  const heartbeat = setInterval(() => {
    db.prepare(
      `UPDATE jobs SET heartbeat_at=datetime('now'), lease_expires_at=?
        WHERE id=? AND status='running' AND lease_owner=?`,
    ).run(sqliteTime(Date.now() + LEASE_MS), row.id, workerId);
  }, HEARTBEAT_MS);
  heartbeat.unref();
  const started = Date.now();
  try {
    await job.fn();
    tx(db, () => {
      db.prepare(`UPDATE projects SET status=?, error=NULL WHERE id=?`).run(job.doneStatus, row.project_id);
      db.prepare(
        `UPDATE jobs SET status='done', finished_at=datetime('now'), lease_owner=NULL, lease_expires_at=NULL
          WHERE id=? AND lease_owner=?`,
      ).run(row.id, workerId);
    });
    recordStageTime(row.project_id, job.label, (Date.now() - started) / 1000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[jobs] ${job.label} (${row.project_id}):`, message);
    tx(db, () => {
      db.prepare(`UPDATE projects SET status=?, error=? WHERE id=?`).run(
        job.errorFallbackStatus,
        message.slice(0, 500),
        row.project_id,
      );
      db.prepare(
        `UPDATE jobs SET status='failed', error=?, finished_at=datetime('now'), lease_owner=NULL, lease_expires_at=NULL
          WHERE id=? AND lease_owner=?`,
      ).run(message.slice(0, 500), row.id, workerId);
    });
    try {
      job.onError?.(message);
    } catch (hookError) {
      console.error(`[jobs] onError ${job.label} (${row.project_id}):`, hookError);
    }
    return;
  } finally {
    clearInterval(heartbeat);
    runtimeJobs.delete(row.id);
  }
  try {
    job.onSuccess?.();
  } catch (error) {
    console.error(`[jobs] onSuccess ${job.label} (${row.project_id}):`, error);
  }
}

/**
 * Насос: добирает джобы в свободные слоты (до localJobConcurrency параллельно).
 * claimNext атомарен, а уникальный индекс jobs(project_id) WHERE queued/running
 * гарантирует «один джоб на проект» — параллельные слоты всегда о РАЗНЫХ проектах.
 */
function pump(): void {
  if (pausedForTests) return;
  while (activeRuns < config.localJobConcurrency) {
    const row = claimNext();
    if (!row) break;
    activeRuns++;
    void execute(row)
      .catch((e) => console.error(`[jobs] execute упал (${row.id}):`, e instanceof Error ? e.message : e))
      .finally(() => {
        activeRuns--;
        pump(); // слот освободился — добираем следующий
        notifyIdle();
      });
  }
  notifyIdle();
}

export function enqueueProjectJob(opts: ProjectJobOptions): void {
  const db = getDb();
  const id = randomUUID();
  tx(db, () => {
    db.prepare(
      `INSERT INTO jobs (id, project_id, kind, payload_json) VALUES (?, ?, ?, ?)`,
    ).run(id, opts.projectId, opts.label, JSON.stringify(opts.payload ?? {}));
    db.prepare(`UPDATE projects SET status=?, error=NULL WHERE id=?`).run(opts.busyStatus, opts.projectId);
  });
  runtimeJobs.set(id, opts);
  pump();
}

/** Boot recovery: this process is the sole local worker, so old leases can be reclaimed now. */
export function resumeDurableJobs(): number {
  const recovered = Number(
    getDb()
      .prepare(
        `UPDATE jobs SET status='queued', lease_owner=NULL, lease_expires_at=NULL
          WHERE status='running'`,
      )
      .run().changes,
  );
  pump();
  return recovered;
}

export function waitForJobsIdle(): Promise<void> {
  if (activeRuns === 0 && activeCount() === 0) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.add(resolve));
}

export function _pauseJobsForTests(paused: boolean): void {
  pausedForTests = paused;
  if (!paused) pump();
}

export function _discardQueuedJobsForTests(): void {
  getDb()
    .prepare(
      `UPDATE jobs SET status='cancelled', finished_at=datetime('now'), lease_owner=NULL, lease_expires_at=NULL
        WHERE status='queued'`,
    )
    .run();
  runtimeJobs.clear();
  notifyIdle();
}

/** Emulates process memory loss while leaving SQLite rows intact. */
export function _dropRuntimeJobsForTests(): void {
  runtimeJobs.clear();
}
