import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { config, llmKeyPresent, llmModelName } from './config';
import { getDb } from './db';
import { ffmpegAvailable, probe } from './ffmpeg';
import { isQueued } from './jobs';
import {
  dataUsageBytes,
  deleteProjectFiles,
  enforceStorageCap,
  ensureProjectDirs,
  projectDir,
  refsDir,
  safeMediaPath,
} from './storage';
import { startAnalysis, startGeneration, startStoryboard } from './engine/pipeline';
import { toFull, toSummary, type DbProject } from './rows';
import { ARTIFACT_TYPES, type ArtifactType } from '../../shared/taxonomy';
import type { HealthInfo } from '../../shared/api-types';

const BUSY = new Set(['storyboarding', 'analyzing', 'generating']);
const VIDEO_MIME: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'application/octet-stream': '.mp4',
};
const IMAGE_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};
const MEDIA_CT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};

function bad(reply: FastifyReply, code: number, msg: string) {
  return reply.code(code).send({ error: msg });
}

function getProject(id: string): DbProject | undefined {
  return getDb().prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as DbProject | undefined;
}

function fieldValue(fields: unknown, name: string): string {
  const f = (fields as Record<string, { value?: unknown } | undefined>)?.[name];
  return typeof f?.value === 'string' ? f.value : '';
}

let ffmpegOk: boolean | null = null;

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async (): Promise<HealthInfo> => {
    if (ffmpegOk === null) ffmpegOk = await ffmpegAvailable();
    const dataBytes = dataUsageBytes();
    return {
      ok: true,
      version: config.version,
      provider: config.llmProvider,
      model: llmModelName(),
      keyPresent: llmKeyPresent(),
      ffmpeg: ffmpegOk,
      dataBytes,
      storageCapBytes: config.storageCapBytes,
      diskUsedPct: Math.round((dataBytes / config.storageCapBytes) * 100),
    };
  });

  // ── Проекты ──────────────────────────────────────────────────────────────

  app.post('/api/projects', async (req, reply) => {
    const part = await req.file();
    if (!part) return bad(reply, 400, 'Нет файла — приложи ролик (mp4/mov)');
    const ext = VIDEO_MIME[part.mimetype];
    if (!ext) return bad(reply, 415, `Неподдерживаемый тип видео: ${part.mimetype}. Нужен mp4 или mov`);

    const id = randomUUID();
    ensureProjectDirs(id);
    const videoFile = `source${ext}`;
    const dest = path.join(projectDir(id), videoFile);
    try {
      await streamPipeline(part.file, fs.createWriteStream(dest));
      if (part.file.truncated) {
        deleteProjectFiles(id);
        return bad(reply, 413, `Видео больше лимита ${Math.round(config.maxVideoBytes / 1024 ** 2)} МБ`);
      }
      const meta = await probe(dest).catch((e: Error) => {
        throw new Error(`Не удалось прочитать видео: ${e.message}`);
      });
      if (meta.durationSec > 60) {
        deleteProjectFiles(id);
        return bad(reply, 422, `Ролик ${Math.round(meta.durationSec)}с — слишком длинный. Seedance работает с 4–15 с, обрежь до ≤60 с`);
      }
      const title = fieldValue(part.fields, 'title') || part.filename || 'Без названия';
      getDb()
        .prepare(
          `INSERT INTO projects (id, title, status, video_file, video_bytes, meta_json)
           VALUES (?, ?, 'uploaded', ?, ?, ?)`,
        )
        .run(id, title.slice(0, 200), videoFile, meta.sizeBytes, JSON.stringify(meta));
      startStoryboard(id);
      const { purged } = enforceStorageCap();
      if (purged.length) app.log.info({ purged }, 'ротация: удалены исходники старых проектов');
      return { id };
    } catch (e) {
      deleteProjectFiles(id);
      getDb().prepare(`DELETE FROM projects WHERE id = ?`).run(id);
      return bad(reply, 422, e instanceof Error ? e.message : String(e));
    }
  });

  app.get('/api/projects', async () => {
    const rows = getDb()
      .prepare(`SELECT * FROM projects ORDER BY created_at DESC`)
      .all() as unknown as DbProject[];
    return rows.map(toSummary);
  });

  app.get('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = getProject(id);
    if (!p) return bad(reply, 404, 'Проект не найден');
    return toFull(p);
  });

  app.delete('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = getProject(id);
    if (!p) return bad(reply, 404, 'Проект не найден');
    if (BUSY.has(p.status) || isQueued(id)) return bad(reply, 409, 'Дождись окончания текущей задачи');
    getDb().prepare(`DELETE FROM projects WHERE id = ?`).run(id);
    deleteProjectFiles(id);
    return { ok: true };
  });

  // ── Референсы ────────────────────────────────────────────────────────────

  app.post('/api/projects/:id/refs', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = getProject(id);
    if (!p) return bad(reply, 404, 'Проект не найден');
    const part = await req.file();
    if (!part) return bad(reply, 400, 'Нет файла референса');
    const ext = IMAGE_MIME[part.mimetype];
    if (!ext) return bad(reply, 415, `Референс должен быть jpg/png/webp, а не ${part.mimetype}`);
    const role = fieldValue(part.fields, 'role') || 'model';
    if (!['model', 'vehicle', 'object'].includes(role)) return bad(reply, 400, 'Неизвестная роль');
    const note = fieldValue(part.fields, 'note').slice(0, 300);

    const refId = randomUUID();
    const file = `ref_${refId.slice(0, 8)}${ext}`;
    const dest = path.join(refsDir(id), file);
    await streamPipeline(part.file, fs.createWriteStream(dest));
    const size = fs.statSync(dest).size;
    if (part.file.truncated || size > config.maxImageBytes) {
      fs.rmSync(dest, { force: true });
      return bad(reply, 413, `Фото больше лимита ${Math.round(config.maxImageBytes / 1024 ** 2)} МБ`);
    }
    const db = getDb();
    const maxIdx = db
      .prepare(`SELECT COALESCE(MAX(idx), -1) AS m FROM refs WHERE project_id = ?`)
      .get(id) as { m: number };
    db.prepare(`INSERT INTO refs (id, project_id, idx, role, file, note) VALUES (?, ?, ?, ?, ?, ?)`).run(
      refId,
      id,
      maxIdx.m + 1,
      role,
      file,
      note,
    );
    return { id: refId, file };
  });

  app.patch('/api/projects/:id/refs', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getProject(id)) return bad(reply, 404, 'Проект не найден');
    const body = (req.body ?? {}) as {
      order?: string[];
      updates?: Array<{ id: string; role?: string; note?: string }>;
    };
    const db = getDb();
    if (Array.isArray(body.order)) {
      const upd = db.prepare(`UPDATE refs SET idx = ? WHERE id = ? AND project_id = ?`);
      body.order.forEach((refId, i) => upd.run(i, refId, id));
    }
    for (const u of body.updates ?? []) {
      if (u.role && ['model', 'vehicle', 'object'].includes(u.role)) {
        db.prepare(`UPDATE refs SET role = ? WHERE id = ? AND project_id = ?`).run(u.role, u.id, id);
      }
      if (typeof u.note === 'string') {
        db.prepare(`UPDATE refs SET note = ? WHERE id = ? AND project_id = ?`).run(
          u.note.slice(0, 300),
          u.id,
          id,
        );
      }
    }
    return { ok: true };
  });

  app.delete('/api/projects/:id/refs/:refId', async (req, reply) => {
    const { id, refId } = req.params as { id: string; refId: string };
    const db = getDb();
    const ref = db
      .prepare(`SELECT file FROM refs WHERE id = ? AND project_id = ?`)
      .get(refId, id) as { file: string } | undefined;
    if (!ref) return bad(reply, 404, 'Референс не найден');
    db.prepare(`DELETE FROM refs WHERE id = ?`).run(refId);
    fs.rmSync(path.join(refsDir(id), ref.file), { force: true });
    // переупаковка порядка
    const rest = db
      .prepare(`SELECT id FROM refs WHERE project_id = ? ORDER BY idx ASC`)
      .all(id) as Array<{ id: string }>;
    const upd = db.prepare(`UPDATE refs SET idx = ? WHERE id = ?`);
    rest.forEach((r, i) => upd.run(i, r.id));
    return { ok: true };
  });

  // ── Пайплайн ─────────────────────────────────────────────────────────────

  app.post('/api/projects/:id/storyboard', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = getProject(id);
    if (!p) return bad(reply, 404, 'Проект не найден');
    if (BUSY.has(p.status) || isQueued(id)) return bad(reply, 409, 'Уже идёт задача — подожди');
    if (!p.video_file || p.video_purged === 1)
      return bad(reply, 409, 'Исходное видео недоступно (очищено ротацией)');
    startStoryboard(id);
    return { ok: true };
  });

  app.post('/api/projects/:id/analyze', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = getProject(id);
    if (!p) return bad(reply, 404, 'Проект не найден');
    if (BUSY.has(p.status) || isQueued(id)) return bad(reply, 409, 'Уже идёт задача — подожди');
    if (!p.frames_json) return bad(reply, 409, 'Сначала должна завершиться раскадровка');
    if (!llmKeyPresent()) return bad(reply, 503, 'LLM-ключ не настроен на сервере');
    startAnalysis(id);
    return { ok: true };
  });

  app.post('/api/projects/:id/generate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = getProject(id);
    if (!p) return bad(reply, 404, 'Проект не найден');
    if (BUSY.has(p.status) || isQueued(id)) return bad(reply, 409, 'Уже идёт задача — подожди');
    if (!p.analysis_json) return bad(reply, 409, 'Сначала нужен анализ ролика');
    const refCount = getDb()
      .prepare(`SELECT COUNT(*) AS c FROM refs WHERE project_id = ?`)
      .get(id) as { c: number };
    if (refCount.c === 0) return bad(reply, 409, 'Добавь хотя бы один референс (модель)');
    const body = (req.body ?? {}) as { lang?: string; endpoint?: string };
    startGeneration(id, {
      lang: body.lang === 'ru' ? 'ru' : 'en',
      endpoint: body.endpoint === 'seedance-2.0-fast' ? 'seedance-2.0-fast' : 'seedance-2.0',
      iteration: null,
    });
    return { ok: true };
  });

  app.post('/api/projects/:id/feedback', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = getProject(id);
    if (!p) return bad(reply, 404, 'Проект не найден');
    const body = (req.body ?? {}) as {
      version?: number;
      worked?: boolean;
      artifacts?: string[];
      notes?: string;
    };
    if (!body.version) return bad(reply, 400, 'Не указана версия промта');
    const artifacts = (body.artifacts ?? []).filter((a): a is ArtifactType =>
      (ARTIFACT_TYPES as string[]).includes(a),
    );
    getDb()
      .prepare(
        `INSERT INTO feedback (id, project_id, version, worked, artifacts_json, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        id,
        body.version,
        body.worked ? 1 : 0,
        JSON.stringify(artifacts),
        (body.notes ?? '').slice(0, 2000),
      );
    return { ok: true };
  });

  app.post('/api/projects/:id/iterate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = getProject(id);
    if (!p) return bad(reply, 404, 'Проект не найден');
    if (BUSY.has(p.status) || isQueued(id)) return bad(reply, 409, 'Уже идёт задача — подожди');
    const body = (req.body ?? {}) as {
      version?: number;
      artifacts?: string[];
      notes?: string;
      lang?: string;
      endpoint?: string;
    };
    if (!body.version) return bad(reply, 400, 'Не указана версия промта');
    const db = getDb();
    const prev = db
      .prepare(`SELECT kind, text FROM prompts WHERE project_id = ? AND version = ?`)
      .all(id, body.version) as Array<{ kind: string; text: string }>;
    const prevVideo = prev.find((r) => r.kind === 'video')?.text;
    const prevImage = prev.find((r) => r.kind === 'image')?.text;
    if (!prevVideo || !prevImage) return bad(reply, 404, 'Версия промта не найдена');
    const artifacts = (body.artifacts ?? []).filter((a): a is ArtifactType =>
      (ARTIFACT_TYPES as string[]).includes(a),
    );
    const notes = (body.notes ?? '').slice(0, 2000);
    // фидбек «не сработало» фиксируем автоматически
    db.prepare(
      `INSERT INTO feedback (id, project_id, version, worked, artifacts_json, notes)
       VALUES (?, ?, ?, 0, ?, ?)`,
    ).run(randomUUID(), id, body.version, JSON.stringify(artifacts), notes);
    startGeneration(id, {
      lang: body.lang === 'ru' ? 'ru' : 'en',
      endpoint: body.endpoint === 'seedance-2.0-fast' ? 'seedance-2.0-fast' : 'seedance-2.0',
      iteration: { prevVideoPrompt: prevVideo, prevImagePrompt: prevImage, artifacts, notes },
    });
    return { ok: true };
  });

  // ── Медиа ────────────────────────────────────────────────────────────────

  app.get('/api/projects/:id/media/:sub/:file', async (req, reply) => {
    const { id, sub, file } = req.params as { id: string; sub: string; file: string };
    const p = getProject(id);
    if (!p) return bad(reply, 404, 'Проект не найден');
    let full: string | null = null;
    if (sub === 'frames' || sub === 'refs') full = safeMediaPath(id, sub, file);
    else if (sub === 'src' && p.video_file && file === p.video_file) full = safeMediaPath(id, '.', file);
    if (!full) return bad(reply, 404, 'Файл не найден');
    const ct = MEDIA_CT[path.extname(full).toLowerCase()] ?? 'application/octet-stream';
    reply.header('Cache-Control', 'private, max-age=86400');
    reply.type(ct);
    return reply.send(fs.createReadStream(full));
  });
}

export type { FastifyRequest };
