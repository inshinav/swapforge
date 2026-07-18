// Роуты конструктора моделей. Живут в protected-scope (default-deny в app.ts):
// каждый вход дополнительно скоупится владельцем через getOwnedModel.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline as streamPipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config';
import {
  addModelRef,
  addVariant,
  createModel,
  deleteModel,
  deleteModelRef,
  deleteVariant,
  getOwnedModel,
  listModels,
  renameModel,
  updateModelRef,
  updateVariant,
} from './models';
import { describeRefSheet } from './engine/describe';
import { getDb } from './db';
import { modelRefsDir, safeModelRefPath } from './storage';
import { probe } from './ffmpeg';
import type { ModelInfo } from '../../shared/api-types';
import type { RefRole } from '../../shared/taxonomy';

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
};

function bad(reply: FastifyReply, code: number, msg: string) {
  return reply.code(code).send({ error: msg });
}

function fieldValue(fields: unknown, name: string): string {
  const f = (fields as Record<string, { value?: unknown } | undefined>)?.[name];
  return typeof f?.value === 'string' ? f.value : '';
}

function toModelInfo(m: ReturnType<typeof listModels>[number]): ModelInfo {
  return {
    id: m.id,
    name: m.name,
    createdAt: m.created_at,
    variants: m.variants.map((v) => ({ id: v.id, title: v.title, hint: v.hint, idx: v.idx })),
    refs: m.refs.map((r) => ({
      id: r.id,
      variantId: r.variant_id,
      file: r.file,
      role: r.role,
      note: r.note,
      idx: r.idx,
    })),
  };
}

/**
 * Советы по качеству листа — best-effort через ffprobe (jpg/png для него валидный
 * «видеопоток»); совет НЕ блокирует загрузку, при недоступном ffprobe молчим.
 */
async function sheetWarnings(fullPath: string): Promise<string[]> {
  try {
    const meta = await probe(fullPath);
    const warnings: string[] = [];
    const longSide = Math.max(meta.width, meta.height);
    if (longSide < 1024) {
      warnings.push('Лист мелковат (<1024px) — identity лочится хуже; лучше залить крупнее');
    }
    return warnings;
  } catch {
    return [];
  }
}

export function registerModelRoutes(app: FastifyInstance): void {
  app.get('/api/models', async (req: FastifyRequest) => {
    return listModels(req.user!.id).map(toModelInfo);
  });

  app.post('/api/models', async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string };
    const name = (body.name ?? '').trim();
    if (!name) return bad(reply, 400, 'Дай модели имя');
    const m = createModel(req.user!.id, name);
    return { id: m.id };
  });

  app.patch('/api/models/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getOwnedModel(req.user!.id, id)) return bad(reply, 404, 'Модель не найдена');
    const body = (req.body ?? {}) as { name?: string };
    const name = (body.name ?? '').trim();
    if (!name) return bad(reply, 400, 'Имя не может быть пустым');
    renameModel(req.user!.id, id, name);
    return { ok: true };
  });

  app.delete('/api/models/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getOwnedModel(req.user!.id, id)) return bad(reply, 404, 'Модель не найдена');
    deleteModel(req.user!.id, id);
    return { ok: true };
  });

  // ── Варианты (кнопки) ────────────────────────────────────────────────────

  app.post('/api/models/:id/variants', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getOwnedModel(req.user!.id, id)) return bad(reply, 404, 'Модель не найдена');
    const body = (req.body ?? {}) as { title?: string; hint?: string };
    const title = (body.title ?? '').trim();
    if (!title) return bad(reply, 400, 'Дай варианту название (например «распущенные»)');
    const v = addVariant(id, title, body.hint ?? '');
    return { id: v.id };
  });

  app.patch('/api/models/:id/variants/:vid', async (req, reply) => {
    const { id, vid } = req.params as { id: string; vid: string };
    if (!getOwnedModel(req.user!.id, id)) return bad(reply, 404, 'Модель не найдена');
    const body = (req.body ?? {}) as { title?: string; hint?: string };
    if (!updateVariant(id, vid, body)) return bad(reply, 404, 'Вариант не найден');
    return { ok: true };
  });

  app.delete('/api/models/:id/variants/:vid', async (req, reply) => {
    const { id, vid } = req.params as { id: string; vid: string };
    if (!getOwnedModel(req.user!.id, id)) return bad(reply, 404, 'Модель не найдена');
    if (!deleteVariant(id, vid)) return bad(reply, 404, 'Вариант не найден');
    return { ok: true };
  });

  // ── Реф-листы ────────────────────────────────────────────────────────────

  app.post('/api/models/:id/refs', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getOwnedModel(req.user!.id, id)) return bad(reply, 404, 'Модель не найдена');
    const part = await req.file({ limits: { fileSize: config.maxImageBytes } });
    if (!part) return bad(reply, 400, 'Нет файла реф-листа');
    const ext = IMAGE_MIME[part.mimetype];
    if (!ext) {
      part.file.resume();
      return bad(reply, 415, `Реф-лист должен быть jpg/png/webp, а не ${part.mimetype}`);
    }
    const role = (fieldValue(part.fields, 'role') || 'model') as RefRole;
    if (!['model', 'vehicle', 'object'].includes(role)) {
      part.file.resume();
      return bad(reply, 400, 'Неизвестная роль');
    }
    const variantId = fieldValue(part.fields, 'variantId') || null;
    if (variantId) {
      const v = getDb()
        .prepare(`SELECT 1 FROM model_variants WHERE id = ? AND model_id = ?`)
        .get(variantId, id);
      if (!v) {
        part.file.resume();
        return bad(reply, 404, 'Вариант не найден');
      }
    }
    const note = fieldValue(part.fields, 'note').slice(0, 600);

    const file = `sheet_${randomUUID().slice(0, 8)}${ext}`;
    const dest = path.join(modelRefsDir(id), file);
    fs.mkdirSync(modelRefsDir(id), { recursive: true });
    try {
      await streamPipeline(part.file, fs.createWriteStream(dest));
    } catch (e) {
      fs.rmSync(dest, { force: true });
      throw e;
    }
    if (part.file.truncated) {
      fs.rmSync(dest, { force: true });
      return bad(reply, 413, `Фото больше лимита ${Math.round(config.maxImageBytes / 1024 ** 2)} МБ`);
    }
    const ref = addModelRef({ modelId: id, variantId, file, role, note });
    const warnings = await sheetWarnings(dest);
    return { id: ref.id, file, warnings };
  });

  app.patch('/api/models/:id/refs/:refId', async (req, reply) => {
    const { id, refId } = req.params as { id: string; refId: string };
    if (!getOwnedModel(req.user!.id, id)) return bad(reply, 404, 'Модель не найдена');
    const body = (req.body ?? {}) as { role?: string; note?: string; variantId?: string | null };
    if (body.variantId) {
      const v = getDb()
        .prepare(`SELECT 1 FROM model_variants WHERE id = ? AND model_id = ?`)
        .get(body.variantId, id);
      if (!v) return bad(reply, 404, 'Вариант не найден');
    }
    if (!updateModelRef(id, refId, body)) return bad(reply, 404, 'Реф не найден');
    return { ok: true };
  });

  app.delete('/api/models/:id/refs/:refId', async (req, reply) => {
    const { id, refId } = req.params as { id: string; refId: string };
    if (!getOwnedModel(req.user!.id, id)) return bad(reply, 404, 'Модель не найдена');
    if (!deleteModelRef(id, refId)) return bad(reply, 404, 'Реф не найден');
    return { ok: true };
  });

  // Автоописание: платный vision-вызов, результат — черновик в редактируемое поле
  app.post('/api/models/:id/refs/:refId/describe', async (req, reply) => {
    const { id, refId } = req.params as { id: string; refId: string };
    const model = getOwnedModel(req.user!.id, id);
    if (!model) return bad(reply, 404, 'Модель не найдена');
    const ref = getDb()
      .prepare(`SELECT file, role FROM model_refs WHERE id = ? AND model_id = ?`)
      .get(refId, id) as { file: string; role: RefRole } | undefined;
    if (!ref) return bad(reply, 404, 'Реф не найден');
    const siblings = getDb()
      .prepare(`SELECT note FROM model_refs WHERE model_id = ? AND id != ? AND note != ''`)
      .all(id, refId) as Array<{ note: string }>;
    try {
      const note = await describeRefSheet({
        modelId: id,
        file: ref.file,
        role: ref.role,
        modelName: model.name,
        siblingNotes: siblings.map((s) => s.note),
        userId: req.user!.id,
      });
      return { note };
    } catch (e) {
      return bad(reply, 502, e instanceof Error ? e.message : String(e));
    }
  });

  app.get('/api/models/:id/file/:file', async (req, reply) => {
    const { id, file } = req.params as { id: string; file: string };
    if (!getOwnedModel(req.user!.id, id)) return bad(reply, 404, 'Модель не найдена');
    const full = safeModelRefPath(id, file);
    if (!full) return bad(reply, 404, 'Файл не найден');
    reply.header('Cache-Control', 'private, max-age=86400');
    reply.type(MEDIA_CT[path.extname(full).toLowerCase()] ?? 'application/octet-stream');
    return reply.send(fs.createReadStream(full));
  });
}
