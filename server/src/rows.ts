// DB-строки → DTO для фронта.
import fs from 'node:fs';
import { getDb } from './db';
import { startDir } from './storage';
import { parseFlags } from './engine/orchestrator';
import { parseGenerateAudio, queuePositionOf } from './engine/render';
import { projectOpenaiUsd, projectOpenaiUsdSince } from './usage';
import type {
  FeedbackRow,
  GenerationRow,
  GenerationStatus,
  ProjectCosts,
  ProjectFull,
  ProjectStatus,
  ProjectSummary,
  PromptRow,
  RefInfo,
} from '../../shared/api-types';
import type { ArtifactType } from '../../shared/taxonomy';

export interface DbProject {
  id: string;
  user_id?: string | null;
  title: string;
  status: string;
  error: string | null;
  video_file: string | null;
  video_bytes: number;
  video_purged: number;
  meta_json: string | null;
  frames_json: string | null;
  analysis_json: string | null;
  tags_json: string | null;
  created_at: string;
  flow: string;
  flags_json: string | null;
  flow_started_at: string | null;
  stage_times_json?: string | null;
}

/** 'YYYY-MM-DD HH:MM:SS' (sqlite, UTC) → ms; null при отсутствии. */
function dbMs(s: string | null): number | null {
  if (!s) return null;
  const t = Date.parse(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? t : null;
}

function secsBetween(a: string | null, b: string | null): number | null {
  const ma = dbMs(a);
  const mb = dbMs(b);
  if (ma === null || mb === null || mb < ma) return null;
  return Math.round((mb - ma) / 100) / 10;
}

function parse<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

export function workedOf(projectId: string): boolean | null {
  const rows = getDb()
    .prepare(`SELECT worked FROM feedback WHERE project_id = ? ORDER BY created_at DESC`)
    .all(projectId) as Array<{ worked: number }>;
  if (rows.length === 0) return null;
  return rows.some((r) => r.worked === 1);
}

function latestRenderOf(projectId: string): ProjectSummary['latestRender'] {
  const g = getDb()
    .prepare(
      `SELECT id, file, rating FROM generations
        WHERE project_id = ? AND status = 'done' AND render_purged = 0 AND file IS NOT NULL
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(projectId) as { id: string; file: string; rating: number | null } | undefined;
  return g ? { generationId: g.id, file: g.file, rating: g.rating } : null;
}

export function toSummary(p: DbProject): ProjectSummary {
  const frames = parse<Array<{ file: string }>>(p.frames_json);
  const maxV = getDb()
    .prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM prompts WHERE project_id = ?`)
    .get(p.id) as { v: number };
  return {
    id: p.id,
    title: p.title,
    status: p.status as ProjectStatus,
    error: p.error,
    createdAt: p.created_at,
    // имя файла, не URL: публичный префикс знает только фронт (api.mediaUrl)
    thumb: frames?.length ? 'first.jpg' : null,
    tags: parse<string[]>(p.tags_json) ?? [],
    worked: workedOf(p.id),
    videoPurged: p.video_purged === 1,
    promptVersions: maxV.v,
    latestRender: latestRenderOf(p.id),
  };
}

interface DbGeneration {
  id: string;
  version: number;
  status: string;
  ws_prediction_id: string | null;
  params_json: string;
  file: string | null;
  bytes: number;
  render_purged: number;
  error: string | null;
  cost_est_json: string | null;
  cost_actual_usd: number | null;
  cost_source: string | null;
  rating: number | null;
  artifacts_json: string;
  notes: string;
  retry_of: string | null;
  created_at: string;
  submitted_at: string | null;
  finished_at: string | null;
}

function toGeneration(g: DbGeneration): GenerationRow {
  return {
    id: g.id,
    version: g.version,
    status: g.status as GenerationStatus,
    file: g.render_purged === 1 ? null : g.file,
    bytes: g.bytes,
    renderPurged: g.render_purged === 1,
    error: g.error,
    params: parse(g.params_json),
    costEst: parse(g.cost_est_json),
    costActualUsd: g.cost_actual_usd,
    costSource: g.cost_source as GenerationRow['costSource'],
    rating: g.rating,
    artifacts: parse<ArtifactType[]>(g.artifacts_json) ?? [],
    notes: g.notes,
    retryOf: g.retry_of,
    wsPredictionId: g.ws_prediction_id,
    createdAt: g.created_at,
    submittedAt: g.submitted_at,
    finishedAt: g.finished_at,
    uploadSec: secsBetween(g.created_at, g.submitted_at),
    renderSec: g.status === 'done' || g.status === 'failed' ? secsBetween(g.submitted_at, g.finished_at) : null,
    queuePosition: g.status === 'queued' ? queuePositionOf(g.id) : null,
  };
}

function costsOf(p: DbProject, generations: GenerationRow[]): ProjectCosts {
  const wsActual = generations.reduce((s, g) => s + (g.costActualUsd ?? 0), 0);
  const projectUsd = projectOpenaiUsd(p.id) + wsActual;
  let activeRun: ProjectCosts['activeRun'] = null;
  if (p.flow === 'auto' && p.flow_started_at) {
    const since = p.flow_started_at;
    const sinceMs = Date.parse(`${since.replace(' ', 'T')}Z`);
    const inRun = (t: string | null) =>
      !!t && Date.parse(`${t.replace(' ', 'T')}Z`) >= sinceMs - 1000;
    const runGen = generations.find((g) => inRun(g.createdAt));
    activeRun = {
      openaiUsd: projectOpenaiUsdSince(p.id, since),
      wavespeedEstUsd: runGen?.costEst?.wavespeedUsd ?? null,
      wavespeedActualUsd: runGen?.costActualUsd ?? null,
    };
  }
  return { projectUsd, activeRun };
}

export function toFull(p: DbProject): ProjectFull {
  const db = getDb();
  const refs = db
    .prepare(
      `SELECT id, idx, role, file, note, role_source AS roleSource, auto_note AS autoNote
         FROM refs WHERE project_id = ? ORDER BY idx ASC`,
    )
    .all(p.id) as unknown as RefInfo[];
  const prompts = (
    db
      .prepare(
        `SELECT id, version, kind, lang, text, params_json, created_at
           FROM prompts WHERE project_id = ? ORDER BY version DESC, kind ASC`,
      )
      .all(p.id) as Array<{
      id: string;
      version: number;
      kind: 'image' | 'video';
      lang: string;
      text: string;
      params_json: string | null;
      created_at: string;
    }>
  ).map(
    (r): PromptRow => ({
      id: r.id,
      version: r.version,
      kind: r.kind,
      lang: r.lang,
      text: r.text,
      params: parse(r.params_json),
      createdAt: r.created_at,
    }),
  );
  const feedback = (
    db
      .prepare(
        `SELECT id, version, worked, artifacts_json, notes, created_at
           FROM feedback WHERE project_id = ? ORDER BY created_at DESC`,
      )
      .all(p.id) as Array<{
      id: string;
      version: number;
      worked: number;
      artifacts_json: string;
      notes: string;
      created_at: string;
    }>
  ).map(
    (r): FeedbackRow => ({
      id: r.id,
      version: r.version,
      worked: r.worked === 1,
      artifacts: parse(r.artifacts_json) ?? [],
      notes: r.notes,
      createdAt: r.created_at,
    }),
  );

  let startFrames: Array<{ file: string; version: number }> = [];
  try {
    startFrames = fs
      .readdirSync(startDir(p.id))
      .filter((f) => /^start_v\d+_[A-Za-z0-9-]+\.png$/.test(f))
      .map((f) => ({ file: f, version: Number(/^start_v(\d+)_/.exec(f)?.[1] ?? 0) }))
      .sort((a, b) => b.file.localeCompare(a.file));
  } catch {
    /* папки может не быть */
  }

  const generations = (
    db
      .prepare(
        `SELECT * FROM generations WHERE project_id = ? ORDER BY created_at DESC, rowid DESC`,
      )
      .all(p.id) as unknown as DbGeneration[]
  ).map(toGeneration);

  return {
    ...toSummary(p),
    videoFile: p.video_purged === 1 ? null : p.video_file,
    meta: parse(p.meta_json),
    frames: parse(p.frames_json) ?? [],
    refs,
    analysis: parse(p.analysis_json),
    prompts,
    feedback,
    startFrames,
    flow: p.flow === 'auto' ? 'auto' : 'manual',
    flags: p.flags_json
      ? { ...parseFlags(p.flags_json), generateAudio: parseGenerateAudio(p.flags_json) }
      : null,
    generations,
    costs: costsOf(p, generations),
    stageTimes: parse(p.stage_times_json ?? null),
  };
}
