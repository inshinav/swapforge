// Склейка кредитов с конвейером. Здесь живёт вся политика «когда hold закрывается»:
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

/** Смета для не-владельца: только кредиты, ни одного USD-поля/знака $. */
export function toUserEstimate(est: EstimateInfo, userId: string): EstimateForUser {
  const { available } = creditBalance(userId);
  const credits = est.totalUsd !== null ? priceCredits(est.totalUsd) : null;
  const warnings = est.warnings.filter((w) => !w.includes('$'));
  if (credits === null) {
    warnings.push('Точная смета временно недоступна — попробуй чуть позже');
  } else if (credits > available) {
    warnings.push(`Не хватает кредитов: нужно ≈ ${credits}, доступно ${available} — пополни на вкладке «Баланс»`);
  }
  return {
    kind: 'credits',
    stages: est.stages,
    credits,
    balanceCredits: available,
    approximate: est.approximate,
    warnings,
  };
}

/** Финал рендера: закрыть hold проекта по факту (WS + LLM с момента резерва). */
export function settleProjectHold(projectId: string, generationId: string, wsUsd: number | null): void {
  try {
    const hold = openHoldForProject(projectId);
    if (!hold) return; // владелец или hold уже закрыт
    const holdRow = getDb()
      .prepare(`SELECT created_at FROM credit_holds WHERE id = ?`)
      .get(hold.id) as { created_at: string };
    const llmUsd = projectOpenaiUsdSince(projectId, holdRow.created_at);
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
export function releaseFlowHoldOnFailure(projectId: string, reason: string): void {
  try {
    const hold = openHoldForProject(projectId);
    if (!hold) return;
    const recoverable = getDb()
      .prepare(
        `SELECT 1 FROM generations WHERE project_id = ?
          AND (status IN ('uploading_assets','submitted','rendering','downloading')
               OR (status = 'failed' AND ws_prediction_id IS NOT NULL)) LIMIT 1`,
      )
      .get(projectId);
    if (recoverable) return;
    const holdRow = getDb()
      .prepare(`SELECT created_at FROM credit_holds WHERE id = ?`)
      .get(hold.id) as { created_at: string };
    const llmUsd = projectOpenaiUsdSince(projectId, holdRow.created_at);
    releaseHold(hold.id, llmUsd > 0 ? priceCredits(llmUsd) : 0, reason);
  } catch (e) {
    console.error(`[billing] release не прошёл (project=${projectId}):`, e instanceof Error ? e.message : e);
  }
}

/**
 * Форс-релиз БЕЗ recoverable-гварда (LLM-часть списывается): для случаев, когда
 * задача точно не даст результата — WS-терминальный fail, удаление проекта.
 */
export function forceReleaseProjectHold(projectId: string, reason: string): void {
  try {
    const hold = openHoldForProject(projectId);
    if (!hold) return;
    const holdRow = getDb()
      .prepare(`SELECT created_at FROM credit_holds WHERE id = ?`)
      .get(hold.id) as { created_at: string };
    const llmUsd = projectOpenaiUsdSince(projectId, holdRow.created_at);
    releaseHold(hold.id, llmUsd > 0 ? priceCredits(llmUsd) : 0, reason);
  } catch (e) {
    console.error(`[billing] force-release не прошёл (project=${projectId}):`, e instanceof Error ? e.message : e);
  }
}

/** Удаление проекта: резерв возвращается (LLM-часть списывается), без гвардов. */
export function releaseHoldForDeletedProject(projectId: string): void {
  forceReleaseProjectHold(projectId, 'проект удалён');
}
