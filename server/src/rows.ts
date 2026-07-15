// DB-строки → DTO для фронта.
import { getDb } from './db';
import type {
  FeedbackRow,
  ProjectFull,
  ProjectStatus,
  ProjectSummary,
  PromptRow,
  RefInfo,
} from '../../shared/api-types';

export interface DbProject {
  id: string;
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
  };
}

export function toFull(p: DbProject): ProjectFull {
  const db = getDb();
  const refs = db
    .prepare(`SELECT id, idx, role, file, note FROM refs WHERE project_id = ? ORDER BY idx ASC`)
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

  return {
    ...toSummary(p),
    videoFile: p.video_purged === 1 ? null : p.video_file,
    meta: parse(p.meta_json),
    frames: parse(p.frames_json) ?? [],
    refs,
    analysis: parse(p.analysis_json),
    prompts,
    feedback,
  };
}
