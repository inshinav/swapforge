import path from 'node:path';
import { getDb } from '../db';
import { BUSY_STATUSES, enqueueProjectJob, isQueued } from '../jobs';
import { storyboard } from '../ffmpeg';
import { framesDir, projectDir } from '../storage';
import { config } from '../config';
import { runAnalysis } from './analyze';
import { runGeneration, buildSeedanceParams, type IterationCtx } from './generate';
import { findSimilarWorked } from './similar';
import { generateStartFrame } from './startframe';
import { nextStageOf, parseFlags, snapshotProject, type FlowFlags } from './orchestrator';
import { startRender } from './render';
import { releaseFlowHoldOnFailure } from '../billing/flow';
import { randomUUID } from 'node:crypto';
import type { Analysis } from '../../../shared/analysis';
import type { RefInfo, VideoMeta } from '../../../shared/api-types';

interface ProjectRow {
  id: string;
  user_id: string | null;
  video_file: string | null;
  video_purged: number;
  meta_json: string | null;
  frames_json: string | null;
  analysis_json: string | null;
  tags_json: string | null;
  flags_json: string | null;
  flow: string;
  status: string;
}

function loadProject(id: string): ProjectRow {
  const row = getDb()
    .prepare(
      `SELECT id, user_id, video_file, video_purged, meta_json, frames_json, analysis_json, tags_json, flags_json, flow, status
         FROM projects WHERE id = ?`,
    )
    .get(id) as ProjectRow | undefined;
  if (!row) throw new Error('Проект не найден');
  return row;
}

function loadRefs(projectId: string): RefInfo[] {
  return getDb()
    .prepare(`SELECT id, idx, role, file, note FROM refs WHERE project_id = ? ORDER BY idx ASC`)
    .all(projectId) as unknown as RefInfo[];
}

export function startStoryboard(projectId: string): void {
  enqueueProjectJob({
    projectId,
    label: 'storyboard',
    busyStatus: 'storyboarding',
    doneStatus: 'storyboarded',
    errorFallbackStatus: 'uploaded',
    fn: async () => {
      const p = loadProject(projectId);
      if (!p.video_file || p.video_purged) throw new Error('Исходное видео недоступно');
      if (!p.meta_json) throw new Error('Нет метаданных видео');
      const meta = JSON.parse(p.meta_json) as VideoMeta;
      const frames = await storyboard(
        path.join(projectDir(projectId), p.video_file),
        framesDir(projectId),
        meta.durationSec,
        config.maxFrames,
      );
      getDb()
        .prepare(`UPDATE projects SET frames_json = ? WHERE id = ?`)
        .run(JSON.stringify(frames), projectId);
    },
    onSuccess: () => advanceFlow(projectId),
    onError: (msg) => releaseFlowHoldOnFailure(projectId, `стадия упала: ${msg.slice(0, 120)}`),
  });
}

export function startAnalysis(projectId: string): void {
  enqueueProjectJob({
    projectId,
    label: 'analyze',
    busyStatus: 'analyzing',
    doneStatus: 'analyzed',
    errorFallbackStatus: 'storyboarded',
    fn: async () => {
      const p = loadProject(projectId);
      if (!p.frames_json || !p.meta_json) throw new Error('Сначала нужна раскадровка');
      const analysis = await runAnalysis(
        projectId,
        JSON.parse(p.meta_json) as VideoMeta,
        JSON.parse(p.frames_json),
      );
      getDb()
        .prepare(`UPDATE projects SET analysis_json = ?, tags_json = ? WHERE id = ?`)
        .run(JSON.stringify(analysis), JSON.stringify(analysis.tags), projectId);
    },
    onSuccess: () => advanceFlow(projectId),
    onError: (msg) => releaseFlowHoldOnFailure(projectId, `стадия упала: ${msg.slice(0, 120)}`),
  });
}

export interface StartGenerationOpts {
  lang: 'en' | 'ru';
  iteration: IterationCtx | null;
  /** Флаги исходной версии при итерации (edge: галочки проекта могли смениться после). */
  flagsOverride?: FlowFlags | null;
}

export function startGeneration(projectId: string, opts: StartGenerationOpts): void {
  enqueueProjectJob({
    projectId,
    label: 'generate',
    busyStatus: 'generating',
    doneStatus: 'complete',
    errorFallbackStatus: 'analyzed',
    fn: async () => {
      const db = getDb();
      const p = loadProject(projectId);
      if (!p.analysis_json || !p.meta_json) throw new Error('Сначала нужен анализ');
      const analysis = JSON.parse(p.analysis_json) as Analysis;
      const meta = JSON.parse(p.meta_json) as VideoMeta;
      const refs = loadRefs(projectId);
      if (refs.length === 0) throw new Error('Добавь хотя бы один референс (модель)');

      const flags = opts.flagsOverride ?? parseFlags(p.flags_json);
      // few-shot строго из проектов ЭТОГО пользователя; проект без владельца
      // (легаси до m001) — пустой ретрив, не чужие примеры
      const fewshot = p.user_id ? findSimilarWorked(p.user_id, projectId, analysis.tags) : [];
      const pair = await runGeneration(projectId, analysis, meta, refs, {
        lang: opts.lang,
        fewshot,
        iteration: opts.iteration,
        flags,
      });

      const params = buildSeedanceParams(meta, refs);
      const maxV = db
        .prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM prompts WHERE project_id = ?`)
        .get(projectId) as { v: number };
      const version = maxV.v + 1;
      const flagsJson = JSON.stringify(flags);
      const insert = db.prepare(
        `INSERT INTO prompts (id, project_id, version, kind, lang, text, params_json, flags_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      db.exec('BEGIN');
      try {
        insert.run(randomUUID(), projectId, version, 'image', opts.lang, pair.imagePrompt, null, flagsJson);
        insert.run(
          randomUUID(),
          projectId,
          version,
          'video',
          'en',
          pair.videoPrompt,
          JSON.stringify({ ...params, notes: pair.notes }),
          flagsJson,
        );
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    onSuccess: () => advanceFlow(projectId),
    onError: (msg) => releaseFlowHoldOnFailure(projectId, `стадия упала: ${msg.slice(0, 120)}`),
  });
}

/**
 * Старт-кадр в очереди (для one-click). В авто-флоу кадр всегда 9:16 (1152x2048):
 * выход рендера фиксирован 9:16, и «reference image 1 = точный первый кадр» обязан совпадать.
 */
export function startStartframe(projectId: string, version: number): void {
  enqueueProjectJob({
    projectId,
    label: 'startframe',
    busyStatus: 'startframing',
    doneStatus: 'complete',
    errorFallbackStatus: 'complete',
    fn: async () => {
      const db = getDb();
      const p = loadProject(projectId);
      if (!p.meta_json) throw new Error('Нет метаданных видео');
      const promptRow = db
        .prepare(
          `SELECT text FROM prompts WHERE project_id = ? AND version = ? AND kind = 'image' LIMIT 1`,
        )
        .get(projectId, version) as { text: string } | undefined;
      if (!promptRow) throw new Error('Нет imagePrompt этой версии — сгенерируй промты');
      const refs = loadRefs(projectId);
      if (refs.length === 0) throw new Error('Нет референсов');
      await generateStartFrame(projectId, version, promptRow.text, refs, JSON.parse(p.meta_json), {
        forceNineSixteen: true,
      });
    },
    onSuccess: () => advanceFlow(projectId),
    onError: (msg) => releaseFlowHoldOnFailure(projectId, `стадия упала: ${msg.slice(0, 120)}`),
  });
}

/**
 * Двигатель one-click: после каждой успешной стадии решает следующий шаг по чистой таблице
 * nextStageOf. Живёт здесь (не в orchestrator.ts), чтобы не создавать цикл импортов —
 * orchestrator остаётся чистым и тестируется без стадий.
 * Failed-рендер отсюда НЕ перезапускается (деньги) — только ручной retry.
 */
export function advanceFlow(projectId: string): void {
  const db = getDb();
  const p = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId) as
    | (ProjectRow & { error: string | null })
    | undefined;
  if (!p || p.flow !== 'auto') return;
  if (BUSY_STATUSES.has(p.status) || isQueued(projectId)) return;

  const snap = snapshotProject(p);
  const stage = nextStageOf(snap);
  try {
    switch (stage) {
      case 'storyboard':
        if (!p.video_file || p.video_purged) throw new Error('Исходник очищен ротацией — залей ролик заново');
        startStoryboard(projectId);
        break;
      case 'analyze':
        startAnalysis(projectId);
        break;
      case 'generate':
        startGeneration(projectId, { lang: 'en', iteration: null });
        break;
      case 'startframe':
        startStartframe(projectId, snap.latestVersion);
        break;
      case 'render':
        startRender(projectId, snap.latestVersion);
        break;
      case 'done':
        break;
    }
  } catch (e) {
    // Стадия не стартовала (гейт рендера, ротация, баланс) — фиксируем причину в проекте
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[flow] ${projectId} стадия ${stage} не запустилась: ${msg}`);
    db.prepare(`UPDATE projects SET error = ? WHERE id = ?`).run(
      `Авто-флоу остановлен на стадии «${stage}»: ${msg}`.slice(0, 500),
      projectId,
    );
    releaseFlowHoldOnFailure(projectId, `флоу остановлен на «${stage}»`);
  }
}
