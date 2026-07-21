import path from 'node:path';
import { getDb } from '../db';
import {
  BUSY_STATUSES,
  enqueueProjectJob,
  isQueued,
  registerDurableJobKind,
  type ProjectJobOptions,
} from '../jobs';
import { storyboard } from '../ffmpeg';
import { framesDir, projectDir } from '../storage';
import { config } from '../config';
import { runAnalysis } from './analyze';
import { runGeneration, buildSeedanceParams, type IterationCtx } from './generate';
import { generateStartFrame } from './startframe';
import { nextStageOf, parseFlags, snapshotProject, type FlowFlags } from './orchestrator';
import { startRender } from './render';
import { releaseFlowHoldOnFailure } from '../billing/flow';
import { randomUUID } from 'node:crypto';
import type { Analysis } from '../../../shared/analysis';
import type { FrameInfo, RefInfo, VideoMeta } from '../../../shared/api-types';
import { referenceAuditMessage, referenceAuditPause } from './reference-audit';
import { loadReferenceManifest } from './reference-manifest';

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
  return loadReferenceManifest(projectId).refs;
}

function storyboardJob(projectId: string): ProjectJobOptions {
  return {
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
    onError: (msg) => releaseFlowHoldOnFailure(projectId, null, `стадия упала: ${msg.slice(0, 120)}`),
  };
}

export function startStoryboard(projectId: string): void {
  enqueueProjectJob(storyboardJob(projectId));
}

function analysisJob(projectId: string): ProjectJobOptions {
  return {
    projectId,
    label: 'analyze',
    busyStatus: 'analyzing',
    doneStatus: 'analyzed',
    errorFallbackStatus: 'storyboarded',
    fn: async () => {
      const p = loadProject(projectId);
      if (!p.frames_json || !p.meta_json) throw new Error('Сначала нужна раскадровка');
      const frames = JSON.parse(p.frames_json) as FrameInfo[];
      if (frames.length === 0) throw new Error('Раскадровка пуста — запусти её заново');
      const analysis = await runAnalysis(
        projectId,
        JSON.parse(p.meta_json) as VideoMeta,
        frames,
        loadRefs(projectId),
      );
      getDb()
        .prepare(`UPDATE projects SET analysis_json = ?, tags_json = ? WHERE id = ?`)
        .run(JSON.stringify(analysis), JSON.stringify(analysis.tags), projectId);
    },
    onSuccess: () => advanceFlow(projectId),
    onError: (msg) => releaseFlowHoldOnFailure(projectId, null, `стадия упала: ${msg.slice(0, 120)}`),
  };
}

export function startAnalysis(projectId: string): void {
  enqueueProjectJob(analysisJob(projectId));
}

export interface StartGenerationOpts {
  lang: 'en' | 'ru';
  iteration: IterationCtx | null;
  /** Флаги исходной версии при итерации (edge: галочки проекта могли смениться после). */
  flagsOverride?: FlowFlags | null;
}

function generationJob(projectId: string, opts: StartGenerationOpts): ProjectJobOptions {
  return {
    projectId,
    label: 'generate',
    busyStatus: 'generating',
    doneStatus: 'complete',
    errorFallbackStatus: 'analyzed',
    payload: opts as unknown as Record<string, unknown>,
    fn: async () => {
      const db = getDb();
      const p = loadProject(projectId);
      if (!p.analysis_json || !p.meta_json) throw new Error('Сначала нужен анализ');
      const analysis = JSON.parse(p.analysis_json) as Analysis;
      const meta = JSON.parse(p.meta_json) as VideoMeta;
      const refs = loadRefs(projectId);
      if (refs.length === 0) throw new Error('Добавь хотя бы один референс (модель)');

      const flags = opts.flagsOverride ?? parseFlags(p.flags_json);
      const pair = await runGeneration(projectId, analysis, meta, refs, {
        lang: opts.lang,
        // Старые «удачные» промты закрепляли шаблонность и неподтверждённую
        // start-frame адресацию. Новый direct-edit контракт не наследует их.
        fewshot: [],
        iteration: opts.iteration,
        flags,
      });

      const params = buildSeedanceParams(meta, refs, analysis);
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
    onError: (msg) => releaseFlowHoldOnFailure(projectId, null, `стадия упала: ${msg.slice(0, 120)}`),
  };
}

export function startGeneration(projectId: string, opts: StartGenerationOpts): void {
  enqueueProjectJob(generationJob(projectId, opts));
}

/**
 * Старт-кадр в очереди (для one-click). В авто-флоу кадр всегда 9:16 (1152x2048):
 * выход рендера фиксирован 9:16, и «reference image 1 = точный первый кадр» обязан совпадать.
 */
function startframeJob(projectId: string, version: number): ProjectJobOptions {
  return {
    projectId,
    label: 'startframe',
    busyStatus: 'startframing',
    doneStatus: 'complete',
    errorFallbackStatus: 'complete',
    payload: { version },
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
    onError: (msg) => releaseFlowHoldOnFailure(projectId, null, `стадия упала: ${msg.slice(0, 120)}`),
  };
}

export function startStartframe(projectId: string, version: number): void {
  enqueueProjectJob(startframeJob(projectId, version));
}

registerDurableJobKind('storyboard', (projectId) => storyboardJob(projectId));
registerDurableJobKind('analyze', (projectId) => analysisJob(projectId));
registerDurableJobKind('generate', (projectId, payload) =>
  generationJob(projectId, {
    lang: payload.lang === 'ru' ? 'ru' : 'en',
    iteration: (payload.iteration ?? null) as IterationCtx | null,
    flagsOverride: (payload.flagsOverride ?? undefined) as FlowFlags | null | undefined,
  }),
);
registerDurableJobKind('startframe', (projectId, payload) => {
  const version = Number(payload.version);
  if (!Number.isInteger(version) || version <= 0) throw new Error('Некорректная версия durable startframe job');
  return startframeJob(projectId, version);
});

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

  const analysis = p.analysis_json ? (JSON.parse(p.analysis_json) as Analysis) : null;
  const auditPause = referenceAuditPause(analysis);
  if (analysis?.referenceAudit && auditPause) {
    const msg = referenceAuditMessage(analysis.referenceAudit, auditPause);
    db.prepare(`UPDATE projects SET error = ? WHERE id = ?`).run(msg, projectId);
    releaseFlowHoldOnFailure(projectId, null, auditPause === 'blocked' ? 'референсы требуют исправления' : 'ожидается решение по рискам');
    return;
  }

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
    releaseFlowHoldOnFailure(projectId, null, `флоу остановлен на «${stage}»`);
  }
}
