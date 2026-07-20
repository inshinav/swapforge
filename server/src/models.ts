// Модели пользователей (персонажи) → варианты образа → реф-листы.
// Вариант = одна пресет-кнопка «Кто в кадре?»; applyModelVariant обобщает старый
// applyPreset: копирует рефы варианта + общие рефы модели (variant_id NULL, т.е.
// мотоцикл/объект) в чистый проект как обычные refs c role_source='preset' —
// даунстрим-конвейер (нумерация, старт-кадр, WaveSpeed) не знает о моделях вообще.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { deleteModelFiles, ensureModelDirs, ensureProjectDirs, modelRefsDir, refsDir } from './storage';
import type { RefRole } from '../../shared/taxonomy';
import { MAX_PROJECT_REFS, ReferenceLimitError } from './engine/reference-manifest';

export interface ModelRow {
  id: string;
  user_id: string;
  name: string;
  visibility: string;
  created_at: string;
  updated_at: string | null;
}

export interface VariantRow {
  id: string;
  model_id: string;
  title: string;
  hint: string;
  idx: number;
}

export interface ModelRefRow {
  id: string;
  model_id: string;
  variant_id: string | null;
  file: string;
  role: RefRole;
  note: string;
  auto_note: string;
  idx: number;
}

export function getOwnedModel(userId: string, modelId: string): ModelRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM models WHERE id = ? AND user_id = ?`)
    .get(modelId, userId) as ModelRow | undefined;
}

export function createModel(userId: string, name: string): ModelRow {
  const id = randomUUID();
  getDb()
    .prepare(`INSERT INTO models (id, user_id, name) VALUES (?, ?, ?)`)
    .run(id, userId, name.slice(0, 100));
  ensureModelDirs(id);
  return getOwnedModel(userId, id)!;
}

export function renameModel(userId: string, modelId: string, name: string): boolean {
  const res = getDb()
    .prepare(`UPDATE models SET name = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`)
    .run(name.slice(0, 100), modelId, userId);
  return Number(res.changes) > 0;
}

export function listModels(userId: string): Array<ModelRow & { variants: VariantRow[]; refs: ModelRefRow[] }> {
  const db = getDb();
  const models = db
    .prepare(`SELECT * FROM models WHERE user_id = ? ORDER BY created_at ASC`)
    .all(userId) as unknown as ModelRow[];
  return models.map((m) => ({
    ...m,
    variants: db
      .prepare(`SELECT * FROM model_variants WHERE model_id = ? ORDER BY idx ASC, rowid ASC`)
      .all(m.id) as unknown as VariantRow[],
    refs: db
      .prepare(`SELECT * FROM model_refs WHERE model_id = ? ORDER BY idx ASC, rowid ASC`)
      .all(m.id) as unknown as ModelRefRow[],
  }));
}

export function addVariant(modelId: string, title: string, hint = ''): VariantRow {
  const db = getDb();
  const id = randomUUID();
  const max = db
    .prepare(`SELECT COALESCE(MAX(idx), -1) AS m FROM model_variants WHERE model_id = ?`)
    .get(modelId) as { m: number };
  db.prepare(`INSERT INTO model_variants (id, model_id, title, hint, idx) VALUES (?, ?, ?, ?, ?)`).run(
    id,
    modelId,
    title.slice(0, 80),
    hint.slice(0, 200),
    max.m + 1,
  );
  return db.prepare(`SELECT * FROM model_variants WHERE id = ?`).get(id) as unknown as VariantRow;
}

export function updateVariant(
  modelId: string,
  variantId: string,
  patch: { title?: string; hint?: string },
): boolean {
  const db = getDb();
  let changed = 0;
  if (typeof patch.title === 'string') {
    changed += Number(
      db
        .prepare(`UPDATE model_variants SET title = ? WHERE id = ? AND model_id = ?`)
        .run(patch.title.slice(0, 80), variantId, modelId).changes,
    );
  }
  if (typeof patch.hint === 'string') {
    changed += Number(
      db
        .prepare(`UPDATE model_variants SET hint = ? WHERE id = ? AND model_id = ?`)
        .run(patch.hint.slice(0, 200), variantId, modelId).changes,
    );
  }
  return changed > 0;
}

/** Удаление варианта каскадом сносит его рефы (строки + файлы). */
export function deleteVariant(modelId: string, variantId: string): boolean {
  const db = getDb();
  const files = db
    .prepare(`SELECT file FROM model_refs WHERE model_id = ? AND variant_id = ?`)
    .all(modelId, variantId) as Array<{ file: string }>;
  const res = db
    .prepare(`DELETE FROM model_variants WHERE id = ? AND model_id = ?`)
    .run(variantId, modelId);
  if (Number(res.changes) === 0) return false;
  for (const f of files) fs.rmSync(path.join(modelRefsDir(modelId), f.file), { force: true });
  return true;
}

export interface AddModelRefInput {
  modelId: string;
  variantId: string | null;
  /** Уже сохранённое имя файла в modelRefsDir. */
  file: string;
  role: RefRole;
  note: string;
  autoNote?: string;
}

export function addModelRef(input: AddModelRefInput): ModelRefRow {
  const db = getDb();
  const id = randomUUID();
  const max = db
    .prepare(`SELECT COALESCE(MAX(idx), -1) AS m FROM model_refs WHERE model_id = ?`)
    .get(input.modelId) as { m: number };
  db.prepare(
    `INSERT INTO model_refs (id, model_id, variant_id, file, role, note, auto_note, idx)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.modelId,
    input.variantId,
    input.file,
    input.role,
    input.note.slice(0, 600),
    (input.autoNote ?? '').slice(0, 600),
    max.m + 1,
  );
  return db.prepare(`SELECT * FROM model_refs WHERE id = ?`).get(id) as unknown as ModelRefRow;
}

export function updateModelRef(
  modelId: string,
  refId: string,
  patch: { role?: string; note?: string; variantId?: string | null },
): boolean {
  const db = getDb();
  let changed = 0;
  if (patch.role && ['model', 'vehicle', 'object'].includes(patch.role)) {
    changed += Number(
      db
        .prepare(`UPDATE model_refs SET role = ? WHERE id = ? AND model_id = ?`)
        .run(patch.role, refId, modelId).changes,
    );
  }
  if (typeof patch.note === 'string') {
    changed += Number(
      db
        .prepare(`UPDATE model_refs SET note = ? WHERE id = ? AND model_id = ?`)
        .run(patch.note.slice(0, 600), refId, modelId).changes,
    );
  }
  if (patch.variantId !== undefined) {
    changed += Number(
      db
        .prepare(`UPDATE model_refs SET variant_id = ? WHERE id = ? AND model_id = ?`)
        .run(patch.variantId, refId, modelId).changes,
    );
  }
  return changed > 0;
}

export function deleteModelRef(modelId: string, refId: string): boolean {
  const db = getDb();
  const row = db
    .prepare(`SELECT file FROM model_refs WHERE id = ? AND model_id = ?`)
    .get(refId, modelId) as { file: string } | undefined;
  if (!row) return false;
  db.prepare(`DELETE FROM model_refs WHERE id = ?`).run(refId);
  fs.rmSync(path.join(modelRefsDir(modelId), row.file), { force: true });
  return true;
}

/** Рефы кнопки-варианта: модельные рефы варианта первыми (нумерация!), потом общие. */
export function variantRefs(modelId: string, variantId: string): ModelRefRow[] {
  const db = getDb();
  const own = db
    .prepare(`SELECT * FROM model_refs WHERE model_id = ? AND variant_id = ? ORDER BY idx ASC`)
    .all(modelId, variantId) as unknown as ModelRefRow[];
  const shared = db
    .prepare(`SELECT * FROM model_refs WHERE model_id = ? AND variant_id IS NULL ORDER BY idx ASC`)
    .all(modelId) as unknown as ModelRefRow[];
  // модель первой (ref 2 после старт-кадра), техника/объекты следом
  return [...own, ...shared].sort((a, b) => {
    const aModel = a.role === 'model' ? 0 : 1;
    const bModel = b.role === 'model' ? 0 : 1;
    return aModel - bModel || a.idx - b.idx;
  });
}

/**
 * Кнопка варианта → рефы проекта (зеркало applyPreset): только на чистый проект,
 * файлы копируются (проект самодостаточен — удаление модели не ломает старые проекты).
 */
export function applyModelVariant(userId: string, projectId: string, variantId: string): void {
  const db = getDb();
  const variant = db
    .prepare(
      `SELECT v.*, m.user_id FROM model_variants v JOIN models m ON m.id = v.model_id
        WHERE v.id = ?`,
    )
    .get(variantId) as (VariantRow & { user_id: string }) | undefined;
  if (!variant || variant.user_id !== userId) throw new Error('Кнопка модели не найдена');

  const have = db
    .prepare(`SELECT COUNT(*) AS c FROM refs WHERE project_id = ?`)
    .get(projectId) as { c: number };
  if (have.c > 0) throw new Error('У проекта уже есть референсы — кнопка модели применяется к чистому проекту');

  const refs = variantRefs(variant.model_id, variantId);
  if (refs.length > MAX_PROJECT_REFS) throw new ReferenceLimitError(refs.length);
  if (!refs.some((r) => r.role === 'model')) {
    throw new Error('У этого варианта нет реф-листа модели — добавь фото в конструкторе');
  }
  for (const r of refs) {
    if (!fs.existsSync(path.join(modelRefsDir(variant.model_id), r.file))) {
      throw new Error(`Файл реф-листа пропал на сервере: ${r.file}`);
    }
  }
  ensureProjectDirs(projectId);
  const insert = db.prepare(
    `INSERT INTO refs (id, project_id, idx, role, file, note, role_source, auto_note)
     VALUES (?, ?, ?, ?, ?, ?, 'preset', ?)`,
  );
  refs.forEach((r, i) => {
    const refId = randomUUID();
    const ext = path.extname(r.file) || '.jpg';
    const file = `ref_${refId.slice(0, 8)}${ext}`;
    fs.copyFileSync(path.join(modelRefsDir(variant.model_id), r.file), path.join(refsDir(projectId), file));
    insert.run(refId, projectId, i, r.role, file, r.note, r.auto_note);
  });
}

/** Удаление модели: строки каскадом + каталог файлов. Старые проекты целы (рефы копировались). */
export function deleteModel(userId: string, modelId: string): boolean {
  const res = getDb().prepare(`DELETE FROM models WHERE id = ? AND user_id = ?`).run(modelId, userId);
  if (Number(res.changes) === 0) return false;
  deleteModelFiles(modelId);
  return true;
}
