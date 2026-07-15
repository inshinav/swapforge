import path from 'node:path';
import { getDb } from '../db';
import { enqueueProjectJob } from '../jobs';
import { storyboard } from '../ffmpeg';
import { framesDir, projectDir } from '../storage';
import { config } from '../config';
import { runAnalysis } from './analyze';
import { runGeneration, buildSeedanceParams, type IterationCtx } from './generate';
import { findSimilarWorked } from './similar';
import { randomUUID } from 'node:crypto';
import type { Analysis } from '../../../shared/analysis';
import type { RefInfo, VideoMeta } from '../../../shared/api-types';

interface ProjectRow {
  id: string;
  video_file: string | null;
  video_purged: number;
  meta_json: string | null;
  frames_json: string | null;
  analysis_json: string | null;
  tags_json: string | null;
}

function loadProject(id: string): ProjectRow {
  const row = getDb()
    .prepare(
      `SELECT id, video_file, video_purged, meta_json, frames_json, analysis_json, tags_json
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
  });
}

export function startAnalysis(projectId: string, model?: string): void {
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
        model,
      );
      getDb()
        .prepare(`UPDATE projects SET analysis_json = ?, tags_json = ? WHERE id = ?`)
        .run(JSON.stringify(analysis), JSON.stringify(analysis.tags), projectId);
    },
  });
}

export interface StartGenerationOpts {
  lang: 'en' | 'ru';
  endpoint: 'seedance-2.0' | 'seedance-2.0-fast';
  iteration: IterationCtx | null;
  model?: string;
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

      const fewshot = findSimilarWorked(projectId, analysis.tags);
      const pair = await runGeneration(projectId, analysis, meta, refs, {
        lang: opts.lang,
        fewshot,
        iteration: opts.iteration,
        model: opts.model,
      });

      const params = buildSeedanceParams(meta, refs, opts.endpoint);
      const maxV = db
        .prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM prompts WHERE project_id = ?`)
        .get(projectId) as { v: number };
      const version = maxV.v + 1;
      const insert = db.prepare(
        `INSERT INTO prompts (id, project_id, version, kind, lang, text, params_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      db.exec('BEGIN');
      try {
        insert.run(randomUUID(), projectId, version, 'image', opts.lang, pair.imagePrompt, null);
        insert.run(
          randomUUID(),
          projectId,
          version,
          'video',
          'en',
          pair.videoPrompt,
          JSON.stringify({ ...params, notes: pair.notes }),
        );
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  });
}
