// Склейка внутреннего долларового баланса с конвейером. В БД суммы хранятся в центах.
// - settle — единый финал рендера (completeFromResult): факт = WS-факт + LLM с момента
//   постановки hold-а, cap = hold;
// - release при падении флоу — ТОЛЬКО если у проекта нет живой/добираемой WS-задачи
//   (failed с ws_prediction_id recheck может довести до done — списание обязано
//   состояться, поэтому такой hold не трогаем);
// - удаление проекта = осознанный отказ: hold освобождаем, списав только LLM-часть.
import { getDb } from '../db';
import { projectOpenaiUsdSince } from '../usage';
import {
  creditBalance,
  openHoldForProject,
  priceCredits,
  releaseHold,
  settleHold,
} from './credits';
import type { EstimateForUser, EstimateInfo } from '../../../shared/api-types';

/** role='owner' не метрится вообще (его расход — расход оператора). */
export function isMeteredUserId(userId: string | null | undefined): boolean {
  if (!userId) return true; // проект без владельца — не должен существовать пост-m001, но fail-closed
  const u = getDb().prepare(`SELECT role FROM users WHERE id = ?`).get(userId) as
    | { role: string }
    | undefined;
  return u?.role !== 'owner';
}

/** Смета для не-владельца: публичная цена в USD уже включает все наценки. */
export function toUserEstimate(est: EstimateInfo, userId: string): EstimateForUser {
  const { available } = creditBalance(userId);
  const priceCents = est.totalUsd !== null ? priceCredits(est.totalUsd) : null;
  const warnings: string[] = [];
  if (priceCents === null) {
    warnings.push('Точная смета временно недоступна — попробуй чуть позже');
  } else if (priceCents > available) {
    warnings.push(`Нужно $${(priceCents / 100).toFixed(2)}, на балансе $${(available / 100).toFixed(2)}`);
  }
  return {
    kind: 'balance',
    stages: est.stages,
    priceUsd: priceCents === null ? null : priceCents / 100,
    balanceUsd: available / 100,
    approximate: est.approximate,
    warnings,
  };
}

/**
 * Открытый hold проекта, ЕСЛИ он принадлежит указанной генерации.
 * `genId=undefined` — любой (удаление проекта). `genId=null` — только ещё не
 * привязанный к рендеру flow-hold (стадия упала до старта рендера). Иначе — только
 * когда generation_id совпадает: событие СТАРОЙ генерации не должно тронуть hold,
 * переклеенный на НОВУЮ (retry) — F2 из адверс-ревью.
 */
function holdOwnedBy(
  projectId: string,
  genId: string | null | undefined,
): { id: string; created_at: string } | null {
  const hold = openHoldForProject(projectId);
  if (!hold) return null;
  if (genId !== undefined && (hold.generation_id ?? null) !== genId) return null;
  const row = getDb()
    .prepare(`SELECT created_at FROM credit_holds WHERE id = ?`)
    .get(hold.id) as { created_at: string };
  return { id: hold.id, created_at: row.created_at };
}

/** Финал рендера: закрыть hold ЭТОЙ генерации по факту (WS + LLM с момента резерва). */
export function settleProjectHold(projectId: string, generationId: string, wsUsd: number | null): void {
  try {
    const hold = holdOwnedBy(projectId, generationId);
    if (!hold) return; // владелец, hold закрыт, или принадлежит другой генерации
    const llmUsd = projectOpenaiUsdSince(projectId, hold.created_at);
    settleHold(hold.id, priceCredits((wsUsd ?? 0) + llmUsd), generationId);
  } catch (e) {
    console.error(`[billing] settle не прошёл (project=${projectId}):`, e instanceof Error ? e.message : e);
  }
}

/**
 * Флоу умер до результата (стадия упала / не стартовала): вернуть резерв, списав
 * LLM-часть. Гвард: живая или добираемая (failed + prediction_id) WS-задача —
 * hold остаётся открытым до её исхода.
 */
export function releaseFlowHoldOnFailure(projectId: string, genId: string | null, reason: string): void {
  try {
    const hold = holdOwnedBy(projectId, genId);
    if (!hold) return;
    const recoverable = getDb()
      .prepare(
        `SELECT 1 FROM generations WHERE project_id = ?
          AND (status IN ('queued','uploading_assets','submitted','rendering','downloading')
               OR (status = 'failed' AND ws_prediction_id IS NOT NULL)) LIMIT 1`,
      )
      .get(projectId);
    if (recoverable) return;
    const llmUsd = projectOpenaiUsdSince(projectId, hold.created_at);
    releaseHold(hold.id, llmUsd > 0 ? priceCredits(llmUsd) : 0, reason);
  } catch (e) {
    console.error(`[billing] release не прошёл (project=${projectId}):`, e instanceof Error ? e.message : e);
  }
}

/**
 * Форс-релиз БЕЗ recoverable-гварда (LLM-часть списывается): WS-терминальный fail
 * конкретной генерации (genId) или удаление проекта (genId=undefined = любой hold).
 */
export function forceReleaseProjectHold(projectId: string, genId: string | null | undefined, reason: string): void {
  try {
    const hold = holdOwnedBy(projectId, genId);
    if (!hold) return;
    const llmUsd = projectOpenaiUsdSince(projectId, hold.created_at);
    releaseHold(hold.id, llmUsd > 0 ? priceCredits(llmUsd) : 0, reason);
  } catch (e) {
    console.error(`[billing] force-release не прошёл (project=${projectId}):`, e instanceof Error ? e.message : e);
  }
}

/** Удаление проекта: любой открытый резерв возвращается (LLM-часть списывается). */
export function releaseHoldForDeletedProject(projectId: string): void {
  forceReleaseProjectHold(projectId, undefined, 'проект удалён');
}

/**
 * Осиротевшие open-холды на буте (краш между записью 'done' и settle — F3, либо
 * ранний выход /swap до запуска — F1): закрываем по факту. Дешёвая сверка, чинит
 * зависшие в held кредиты.
 */
export function reconcileOrphanHolds(): number {
  const db = getDb();
  const orphans = db
    .prepare(
      `SELECT h.id AS hold_id, h.project_id, h.generation_id, g.status AS gen_status, g.cost_actual_usd
         FROM credit_holds h JOIN generations g ON g.id = h.generation_id
        WHERE h.status = 'open' AND g.status IN ('done','failed')`,
    )
    .all() as Array<{
    hold_id: string;
    project_id: string;
    generation_id: string;
    gen_status: string;
    cost_actual_usd: number | null;
  }>;
  let fixed = 0;
  for (const o of orphans) {
    try {
      const row = db.prepare(`SELECT created_at FROM credit_holds WHERE id = ?`).get(o.hold_id) as { created_at: string };
      const llmUsd = projectOpenaiUsdSince(o.project_id, row.created_at);
      if (o.gen_status === 'done') {
        settleHold(o.hold_id, priceCredits((o.cost_actual_usd ?? 0) + llmUsd), o.generation_id);
      } else {
        releaseHold(o.hold_id, llmUsd > 0 ? priceCredits(llmUsd) : 0, 'сверка на старте: рендер завершился');
      }
      fixed++;
    } catch (e) {
      console.error(`[billing] сверка hold=${o.hold_id} не прошла:`, e instanceof Error ? e.message : e);
    }
  }
  if (fixed) console.log(`[billing] сверка холдов на старте: закрыто ${fixed}`);
  return fixed;
}
