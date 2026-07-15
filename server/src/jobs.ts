// Простая последовательная очередь: ffmpeg и LLM-джобы не должны толкаться на 2 vCPU.
import { getDb } from './db';

interface Job {
  projectId: string;
  label: string;
  run: () => Promise<void>;
}

const queue: Job[] = [];
let running = false;

export function enqueue(job: Job): void {
  queue.push(job);
  void pump();
}

export function isQueued(projectId: string): boolean {
  return queue.some((j) => j.projectId === projectId);
}

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift();
      if (!job) break;
      try {
        await job.run();
      } catch (e) {
        // Ошибки конкретной джобы фиксируются внутри runProjectJob; сюда попадают только неожиданные
        console.error(`[jobs] ${job.label} (${job.projectId}) упала вне обработчика:`, e);
      }
    }
  } finally {
    running = false;
  }
}

/**
 * Обёртка джобы над проектом: выставляет busy-статус, по завершении — done,
 * при ошибке — status='error' с человекочитаемым сообщением (+ статус для повтора).
 */
export function enqueueProjectJob(opts: {
  projectId: string;
  label: string;
  busyStatus: string;
  doneStatus: string;
  errorFallbackStatus: string;
  fn: () => Promise<void>;
}): void {
  const db = getDb();
  db.prepare(`UPDATE projects SET status = ?, error = NULL WHERE id = ?`).run(
    opts.busyStatus,
    opts.projectId,
  );
  enqueue({
    projectId: opts.projectId,
    label: opts.label,
    run: async () => {
      try {
        await opts.fn();
        db.prepare(`UPDATE projects SET status = ?, error = NULL WHERE id = ?`).run(
          opts.doneStatus,
          opts.projectId,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[jobs] ${opts.label} (${opts.projectId}):`, msg);
        db.prepare(`UPDATE projects SET status = ?, error = ? WHERE id = ?`).run(
          opts.errorFallbackStatus,
          msg.slice(0, 500),
          opts.projectId,
        );
      }
    },
  });
}
