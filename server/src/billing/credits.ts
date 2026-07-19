// Кредитный движок. Инварианты:
// - Пользовательская цена = полная себестоимость промтов + изображений + видео
//   × (1 + USER_MARGIN_PCT/100). Других скрытых множителей нет.
//   USD не-владельцу не показывается нигде — только кредиты.
// - Леджер append-only; available = SUM(ledger) − SUM(open-холдов).
// - Любая read-then-write инварианта — ТОЛЬКО в sync-коллбеке tx() (BEGIN IMMEDIATE,
//   без await внутри): единственный писатель SQLite делает TOCTOU невозможным.
// - Hold ставится на смету, settle по факту с капом в hold («цена была видна и
//   списана честно»; перерасход поглощает оператор).
// - markFailed С живым ws_prediction_id НЕ освобождает hold: recheck может добрать
//   готовый ролик, и списание обязано состояться. Release — только когда WaveSpeed
//   точно не отдаст результат (ничего не сабмитили / задача мертва / проект удалён).
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { config } from '../config';
import { getDb } from '../db';

export function priceCredits(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 1;
  const marginPct = Number.isFinite(config.userMarginPct) ? Math.max(0, config.userMarginPct) : 25;
  return Math.max(1, Math.ceil(usd * (1 + marginPct / 100) * 100));
}

/** Синхронная транзакция: fn НЕ async — await внутри сломал бы атомарность. */
export function tx<T>(d: DatabaseSync, fn: () => T): T {
  d.exec('BEGIN IMMEDIATE');
  try {
    const res = fn();
    d.exec('COMMIT');
    return res;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

export interface CreditBalance {
  balance: number;
  held: number;
  available: number;
}

export function creditBalance(userId: string): CreditBalance {
  const d = getDb();
  const bal = d
    .prepare(`SELECT COALESCE(SUM(delta_credits), 0) AS s FROM credit_ledger WHERE user_id = ?`)
    .get(userId) as { s: number };
  const held = d
    .prepare(`SELECT COALESCE(SUM(credits), 0) AS s FROM credit_holds WHERE user_id = ? AND status = 'open'`)
    .get(userId) as { s: number };
  return { balance: bal.s, held: held.s, available: bal.s - held.s };
}

export interface HoldRow {
  id: string;
  user_id: string;
  project_id: string;
  generation_id: string | null;
  credits: number;
  status: string;
}

export function openHoldForProject(projectId: string): HoldRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM credit_holds WHERE project_id = ? AND status = 'open'`)
    .get(projectId) as HoldRow | undefined;
}

export type PlaceHoldResult =
  | { ok: true; holdId: string; reused: boolean }
  | { ok: false; needCredits: number; availableCredits: number };

/**
 * Резерв кредитов на запуск. Открытый hold проекта переиспользуется (retry/manual
 * пути не создают второй резерв — зеркало реюза USD-гварда). Баланс перечитывается
 * ВНУТРИ транзакции: любые pre-await проверки снаружи — только advisory.
 */
export function placeHold(userId: string, projectId: string, credits: number): PlaceHoldResult {
  const d = getDb();
  return tx(d, () => {
    const existing = d
      .prepare(`SELECT id FROM credit_holds WHERE project_id = ? AND status = 'open'`)
      .get(projectId) as { id: string } | undefined;
    if (existing) return { ok: true, holdId: existing.id, reused: true };

    const bal = d
      .prepare(`SELECT COALESCE(SUM(delta_credits), 0) AS s FROM credit_ledger WHERE user_id = ?`)
      .get(userId) as { s: number };
    const held = d
      .prepare(`SELECT COALESCE(SUM(credits), 0) AS s FROM credit_holds WHERE user_id = ? AND status = 'open'`)
      .get(userId) as { s: number };
    const available = bal.s - held.s;
    if (credits > available) return { ok: false, needCredits: credits, availableCredits: Math.max(0, available) };

    const id = randomUUID();
    d.prepare(`INSERT INTO credit_holds (id, user_id, project_id, credits) VALUES (?, ?, ?, ?)`).run(
      id,
      userId,
      projectId,
      credits,
    );
    return { ok: true, holdId: id, reused: false };
  });
}

export function attachHoldGeneration(holdId: string, generationId: string): void {
  getDb()
    .prepare(`UPDATE credit_holds SET generation_id = ? WHERE id = ? AND status = 'open'`)
    .run(generationId, holdId);
}

/**
 * Списание по факту: закрывает hold и пишет charge (cap = сумма hold-а).
 * Идемпотентно: второй вызов на закрытом hold — no-op false.
 */
export function settleHold(holdId: string, factCredits: number, generationId?: string | null): boolean {
  const d = getDb();
  return tx(d, () => {
    const hold = d
      .prepare(`SELECT * FROM credit_holds WHERE id = ? AND status = 'open'`)
      .get(holdId) as HoldRow | undefined;
    if (!hold) return false;
    const charge = Math.max(0, Math.min(Math.round(factCredits), hold.credits));
    d.prepare(`UPDATE credit_holds SET status = 'settled', closed_at = datetime('now') WHERE id = ?`).run(holdId);
    if (charge > 0) {
      d.prepare(
        `INSERT INTO credit_ledger (id, user_id, delta_credits, kind, hold_id, generation_id, project_id, note)
         VALUES (?, ?, ?, 'charge', ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        hold.user_id,
        -charge,
        holdId,
        generationId ?? hold.generation_id,
        hold.project_id,
        'списание по факту рендера',
      );
    }
    return true;
  });
}

/** Освобождение резерва (частичное списание chargeCredits допустимо, cap = hold). */
export function releaseHold(holdId: string, chargeCredits = 0, note = ''): boolean {
  const d = getDb();
  return tx(d, () => {
    const hold = d
      .prepare(`SELECT * FROM credit_holds WHERE id = ? AND status = 'open'`)
      .get(holdId) as HoldRow | undefined;
    if (!hold) return false;
    const charge = Math.max(0, Math.min(Math.round(chargeCredits), hold.credits));
    d.prepare(`UPDATE credit_holds SET status = 'released', closed_at = datetime('now') WHERE id = ?`).run(holdId);
    if (charge > 0) {
      d.prepare(
        `INSERT INTO credit_ledger (id, user_id, delta_credits, kind, hold_id, generation_id, project_id, note)
         VALUES (?, ?, ?, 'charge', ?, ?, ?, ?)`,
      ).run(randomUUID(), hold.user_id, -charge, holdId, hold.generation_id, hold.project_id, note || 'частичное списание (LLM)');
    }
    return true;
  });
}

export type GrantResult = 'granted' | 'replay';

/** Зачисление покупки; повтор того же payment_ref (ретраи вебхука) — тихий no-op. */
export function grantPurchase(userId: string, credits: number, paymentRef: string, note: string): GrantResult {
  const d = getDb();
  try {
    d.prepare(
      `INSERT INTO credit_ledger (id, user_id, delta_credits, kind, payment_ref, note)
       VALUES (?, ?, ?, 'purchase', ?, ?)`,
    ).run(randomUUID(), userId, Math.max(0, Math.round(credits)), paymentRef, note.slice(0, 300));
    return 'granted';
  } catch (e) {
    if (e instanceof Error && /UNIQUE/i.test(e.message)) return 'replay';
    throw e;
  }
}

/** Рефанд платежа: минус кредиты (может увести баланс в минус — долг, новые запуски не пройдут). */
export function applyRefund(userId: string, credits: number, paymentRef: string, note: string): GrantResult {
  const d = getDb();
  try {
    d.prepare(
      `INSERT INTO credit_ledger (id, user_id, delta_credits, kind, payment_ref, note)
       VALUES (?, ?, ?, 'refund', ?, ?)`,
    ).run(randomUUID(), userId, -Math.max(0, Math.round(credits)), paymentRef, note.slice(0, 300));
    return 'granted';
  } catch (e) {
    if (e instanceof Error && /UNIQUE/i.test(e.message)) return 'replay';
    throw e;
  }
}

/** Ручная корректировка владельцем (разбор неопознанных платежей и споров). */
export function adjustCredits(
  userId: string,
  delta: number,
  note: string,
  paymentRef?: string,
): GrantResult {
  try {
    getDb()
      .prepare(
        `INSERT INTO credit_ledger (id, user_id, delta_credits, kind, payment_ref, note)
         VALUES (?, ?, ?, 'adjust', ?, ?)`,
      )
      .run(randomUUID(), userId, Math.round(delta), paymentRef ?? null, note.slice(0, 300));
    return 'granted';
  } catch (e) {
    if (paymentRef && e instanceof Error && /UNIQUE/i.test(e.message)) return 'replay';
    throw e;
  }
}

export interface LedgerEntry {
  id: string;
  delta: number;
  kind: string;
  note: string;
  createdAt: string;
}

export function listLedger(userId: string, limit = 50): LedgerEntry[] {
  const rows = getDb()
    .prepare(
      `SELECT id, delta_credits, kind, note, created_at FROM credit_ledger
        WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(userId, limit) as Array<{ id: string; delta_credits: number; kind: string; note: string; created_at: string }>;
  return rows.map((r) => ({ id: r.id, delta: r.delta_credits, kind: r.kind, note: r.note, createdAt: r.created_at }));
}
