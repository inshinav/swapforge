// Оркестратор one-click флоу. Здесь — чистая решающая логика (таблица переходов nextStageOf
// тестируется без БД) + снапшот состояния проекта. Побочные эффекты (advanceFlow) — отдельно.
import fs from 'node:fs';
import { getDb } from '../db';
import { startDir } from '../storage';
import { loadReferenceManifest } from './reference-manifest';

export interface FlowFlags {
  removeText: boolean;
  enhanceFigure: boolean;
  /** Пожелания к ролику (подчинены доктрине; '' = базовый режим). */
  wish: string;
}

export const DEFAULT_FLAGS: FlowFlags = { removeText: false, enhanceFigure: false, wish: '' };

/** Старые записи без flags_json = оба флага выключены (поведение v1). */
export function parseFlags(json: string | null | undefined): FlowFlags {
  if (!json) return { ...DEFAULT_FLAGS };
  try {
    const raw = JSON.parse(json) as Partial<FlowFlags>;
    return {
      removeText: !!raw.removeText,
      enhanceFigure: !!raw.enhanceFigure,
      wish: typeof raw.wish === 'string' ? raw.wish.slice(0, 500) : '',
    };
  } catch {
    return { ...DEFAULT_FLAGS };
  }
}

/** Смена пожелания = смена флагов = регенерация промтов на следующем свапе. */
export function flagsEqual(a: FlowFlags, b: FlowFlags): boolean {
  return a.removeText === b.removeText && a.enhanceFigure === b.enhanceFigure && a.wish === b.wish;
}

export type StageName = 'storyboard' | 'analyze' | 'generate' | 'startframe' | 'render' | 'done';

export interface StageSnapshot {
  framesReady: boolean;
  analysisReady: boolean;
  /** 0 = промтов ещё нет. */
  latestVersion: number;
  /** Флаги, с которыми сгенерирована последняя версия промтов (null = промтов нет). */
  latestPromptFlags: FlowFlags | null;
  /** false = референсы менялись после этой версии промтов. */
  latestPromptRefsMatch?: boolean;
  /** Чего хочет проект сейчас (галочки на момент запуска). */
  wantedFlags: FlowFlags;
  /** Legacy/manual owner diagnostic; normal video-edit no longer waits for it. */
  startframeReady: boolean;
  /** Статус последней генерации для latestVersion (null = генераций не было). */
  latestGenStatus: string | null;
}

/**
 * Решающая таблица авто-флоу. Смена галочек относительно последней версии промтов
 * означает регенерацию. Failed-рендер НЕ перезапускается автоматически (деньги) —
 * только руками через retry, поэтому любой существующий рендер → 'done'.
 */
export function nextStageOf(s: StageSnapshot): StageName {
  if (!s.framesReady) return 'storyboard';
  if (!s.analysisReady) return 'analyze';
  if (
    s.latestVersion === 0 ||
    !s.latestPromptFlags ||
    !flagsEqual(s.latestPromptFlags, s.wantedFlags) ||
    s.latestPromptRefsMatch === false
  ) {
    return 'generate';
  }
  if (s.latestGenStatus === null) return 'render';
  return 'done';
}

const STAGE_ORDER: StageName[] = ['storyboard', 'analyze', 'generate', 'render'];

/** Что осталось прогнать (для сметы). 'done' = повторный прогон → только рендер. */
export function remainingStages(s: StageSnapshot): StageName[] {
  const next = nextStageOf(s);
  if (next === 'done') return ['render'];
  return STAGE_ORDER.slice(STAGE_ORDER.indexOf(next));
}

export function startframeExists(projectId: string, version: number): boolean {
  try {
    return fs
      .readdirSync(startDir(projectId))
      .some((f) => new RegExp(`^start_v${version}_[A-Za-z0-9-]+\\.png$`).test(f));
  } catch {
    return false;
  }
}

export interface ProjectRowLike {
  id: string;
  frames_json: string | null;
  analysis_json: string | null;
  flags_json?: string | null;
}

export function snapshotProject(p: ProjectRowLike): StageSnapshot {
  const db = getDb();
  const maxV = db
    .prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM prompts WHERE project_id = ?`)
    .get(p.id) as { v: number };
  const latestVersion = maxV.v;
  let latestPromptFlags: FlowFlags | null = null;
  let latestPromptRefsMatch = true;
  if (latestVersion > 0) {
    const row = db
      .prepare(`SELECT flags_json, params_json FROM prompts WHERE project_id = ? AND version = ? AND kind = 'video' LIMIT 1`)
      .get(p.id, latestVersion) as { flags_json: string | null; params_json: string | null } | undefined;
    latestPromptFlags = parseFlags(row?.flags_json);
    try {
      const stored = row?.params_json
        ? (JSON.parse(row.params_json) as { refFingerprint?: unknown }).refFingerprint
        : null;
      const manifest = loadReferenceManifest(p.id);
      const refs = manifest.refs;
      if (typeof stored === 'string') {
        latestPromptRefsMatch = stored === manifest.fingerprint;
      } else {
        // Легаси-проект без нового аудита продолжает работать как раньше. Если же
        // новый аудит уже есть, а отпечатка у промта нет — это первая безопасная
        // пересборка после внедрения/изменения референсов.
        let auditedWithRefs = false;
        try {
          auditedWithRefs = !!(
            p.analysis_json &&
            (JSON.parse(p.analysis_json) as { referenceAudit?: unknown }).referenceAudit
          );
        } catch {
          /* старый битый анализ обрабатывается прежним путём */
        }
        latestPromptRefsMatch = !auditedWithRefs || refs.length === 0;
      }
    } catch {
      // Старые/повреждённые params_json не ломают уже созданные проекты.
      latestPromptRefsMatch = true;
    }
  }
  const gen =
    latestVersion > 0
      ? (db
          .prepare(
            `SELECT status FROM generations WHERE project_id = ? AND version = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
          )
          .get(p.id, latestVersion) as { status: string } | undefined)
      : undefined;
  return {
    framesReady: !!p.frames_json,
    analysisReady: !!p.analysis_json,
    latestVersion,
    latestPromptFlags,
    latestPromptRefsMatch,
    wantedFlags: parseFlags(p.flags_json),
    startframeReady: latestVersion > 0 && startframeExists(p.id, latestVersion),
    latestGenStatus: gen?.status ?? null,
  };
}
