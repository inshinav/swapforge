// Простая последовательная очередь: ffmpeg и LLM-джобы не должны толкаться на 2 vCPU.
// Удалённые ожидания (загрузка на WaveSpeed, поллинг рендера) сюда НЕ ставятся — см. engine/render.ts.
import { getDb } from './db';

/** Busy-статусы проекта (локальные стадии). Рендер живёт в generations.status. */
export const BUSY_STATUSES = new Set(['storyboarding', 'analyzing', 'generating', 'startframing']);

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

/** Фактическая длительность стадии — в projects.stage_times_json (кормит степпер UI). */
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
      /* кривой JSON перезапишем */
    }
    times[label] = Math.round(seconds * 10) / 10;
    db.prepare(`UPDATE projects SET stage_times_json = ? WHERE id = ?`).run(JSON.stringify(times), projectId);
  } catch (e) {
    console.warn(`[jobs] stage-time не записан (${label}):`, e instanceof Error ? e.message : e);
  }
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
  /** Хук авто-флоу: зовётся ПОСЛЕ записи doneStatus; его ошибки не роняют джобу. */
  onSuccess?: () => void;
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
      const t0 = Date.now();
      try {
        await opts.fn();
        db.prepare(`UPDATE projects SET status = ?, error = NULL WHERE id = ?`).run(
          opts.doneStatus,
          opts.projectId,
        );
        recordStageTime(opts.projectId, opts.label, (Date.now() - t0) / 1000);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[jobs] ${opts.label} (${opts.projectId}):`, msg);
        db.prepare(`UPDATE projects SET status = ?, error = ? WHERE id = ?`).run(
          opts.errorFallbackStatus,
          msg.slice(0, 500),
          opts.projectId,
        );
        return;
      }
      if (opts.onSuccess) {
        try {
          opts.onSuccess();
        } catch (e) {
          console.error(`[jobs] onSuccess ${opts.label} (${opts.projectId}):`, e);
        }
      }
    },
  });
}
