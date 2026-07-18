// Учёт LLM-расхода: каждое обращение → строка usage_events с ценой по живому тарифу
// на момент записи. Кормит бегущий счётчик, месячные суммы и самообучающийся оценщик.
import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { priceForCached } from './pricing';
import type { UsageSummary } from '../../shared/api-types';

export interface UsageEventInput {
  projectId?: string | null;
  generationId?: string | null;
  task: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
}

/** Никогда не роняет вызвавшую задачу — учёт вторичен по отношению к работе. */
export function recordUsage(ev: UsageEventInput): void {
  try {
    const price = priceForCached(ev.model);
    const cost = price ? (ev.tokensIn * price.inPerM + ev.tokensOut * price.outPerM) / 1e6 : null;
    // user_id денормализуем НА ЗАПИСИ (а не join-ом на чтении): строка расхода
    // обязана пережить удаление проекта с уже присвоенным плательщиком
    const owner = ev.projectId
      ? ((getDb().prepare(`SELECT user_id FROM projects WHERE id = ?`).get(ev.projectId) as
          | { user_id: string | null }
          | undefined)?.user_id ?? null)
      : null;
    getDb()
      .prepare(
        `INSERT INTO usage_events (id, project_id, generation_id, task, model, tokens_in, tokens_out, cost_usd, price_date, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        ev.projectId ?? null,
        ev.generationId ?? null,
        ev.task,
        ev.model,
        Math.max(0, Math.round(ev.tokensIn)),
        Math.max(0, Math.round(ev.tokensOut)),
        cost,
        price?.date ?? null,
        owner,
      );
  } catch (e) {
    console.warn(`[usage] не записал событие: ${e instanceof Error ? e.message : e}`);
  }
}

/** Сумма LLM-расхода по проекту (все события). */
export function projectOpenaiUsd(projectId: string): number {
  const row = getDb()
    .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM usage_events WHERE project_id = ?`)
    .get(projectId) as { s: number };
  return row.s;
}

/** LLM-расход проекта с момента запуска активного флоу (бегущий счётчик). */
export function projectOpenaiUsdSince(projectId: string, sinceIso: string): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS s FROM usage_events WHERE project_id = ? AND created_at >= ?`,
    )
    .get(projectId, sinceIso) as { s: number };
  return row.s;
}

/** Месячная сводка: OpenAI из usage_events, WaveSpeed из фактических списаний генераций. */
export function monthSummary(month: string): UsageSummary {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('месяц должен быть в формате YYYY-MM');
  const db = getDb();
  const openai = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS s FROM usage_events WHERE created_at LIKE ? || '%'`,
    )
    .get(month) as { s: number };
  // По зафиксированной стоимости, не по статусу: failed-рендер с захваченным списанием
  // (recheck после таймаута и т.п.) — это тоже потраченные деньги месяца
  const ws = db
    .prepare(
      `SELECT COALESCE(SUM(cost_actual_usd), 0) AS s, COUNT(*) AS c
         FROM generations WHERE cost_actual_usd IS NOT NULL AND finished_at LIKE ? || '%'`,
    )
    .get(month) as { s: number; c: number };
  return {
    month,
    openaiUsd: openai.s,
    wavespeedUsd: ws.s,
    totalUsd: openai.s + ws.s,
    runs: ws.c,
  };
}
