// Дневные анти-абьюз лимиты (порт reserve-and-decide паттерна из ai-dash usage.ts:
// счётчик читается и инкрементится в ОДНОЙ sync-транзакции — TOCTOU исключён;
// отклонённая попытка НЕ персистится). Кредиты — главный ограничитель денег;
// эти капы прикрывают бесплатные/микро-платные поверхности (владелец exempt).
import { getDb } from './db';
import { tx } from './billing/credits';

export type DailyLimitKind =
  | 'projects'
  | 'classify'
  | 'describe'
  | 'manual_llm'
  | 'finish'
  | 'finish_preview';

/** 'YYYY-MM-DD' (UTC) — сбрасывается в 00:00 UTC. */
export function dayKey(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export interface LimitVerdict {
  allowed: boolean;
  count: number;
  limit: number;
}

export function consumeDailyLimit(
  userId: string,
  kind: DailyLimitKind,
  limit: number,
  nowMs = Date.now(),
): LimitVerdict {
  const d = getDb();
  const day = dayKey(nowMs);
  return tx(d, () => {
    const row = d
      .prepare(`SELECT count FROM usage_counters WHERE user_id = ? AND day = ? AND kind = ?`)
      .get(userId, day, kind) as { count: number } | undefined;
    const next = (row?.count ?? 0) + 1;
    if (next > limit) return { allowed: false, count: row?.count ?? 0, limit };
    if (row) {
      d.prepare(`UPDATE usage_counters SET count = ? WHERE user_id = ? AND day = ? AND kind = ?`).run(
        next,
        userId,
        day,
        kind,
      );
    } else {
      d.prepare(`INSERT INTO usage_counters (user_id, day, kind, count) VALUES (?, ?, ?, 1)`).run(
        userId,
        day,
        kind,
      );
    }
    return { allowed: true, count: next, limit };
  });
}

export const LIMIT_MESSAGE = 'Дневной лимит исчерпан — сбросится в 00:00 UTC';
