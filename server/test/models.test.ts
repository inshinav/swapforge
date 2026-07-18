// Конструктор моделей: CRUD + ownership, applyModelVariant (обобщение applyPreset),
// m002-сид захардкоженных пресетов в модели владельца, describe-роут (LLM за сеткой не зовём).
import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-models-'));
process.env.AUTH_DEV_BYPASS = '1';
process.env.OWNER_TELEGRAM_ID = '9100';
process.env.OPENAI_API_KEY = 'test-key'; // /swap гейтится llmKeyPresent ДО применения варианта
process.env.PRESETS_DIR = path.resolve('assets/presets');

const { getDb, applySchema } = await import('../src/db');
const { runDataMigrations } = await import('../src/migrations');
const {
  addModelRef,
  addVariant,
  applyModelVariant,
  createModel,
  deleteModel,
  variantRefs,
} = await import('../src/models');
const { makeAuthedApp } = await import('./helpers');
const { modelRefsDir, refsDir } = await import('../src/storage');
const { PRESETS } = await import('../src/presets');
const { DatabaseSync } = await import('node:sqlite');

function mkUser(id: string, tg: number): string {
  getDb().prepare(`INSERT INTO users (id, telegram_id) VALUES (?, ?)`).run(id, tg);
  return id;
}

function mkProject(id: string, userId: string): string {
  getDb()
    .prepare(
      `INSERT INTO projects (id, user_id, title, status, video_file, meta_json)
       VALUES (?, ?, 'p', 'complete', 'source.mp4', '{}')`,
    )
    .run(id, userId);
  return id;
}

/** Модель с одним вариантом и листами на диске. */
function mkModelWithSheet(userId: string): { modelId: string; variantId: string } {
  const m = createModel(userId, 'Тест-Модель');
  const v = addVariant(m.id, 'базовый', 'подсказка');
  fs.mkdirSync(modelRefsDir(m.id), { recursive: true });
  fs.writeFileSync(path.join(modelRefsDir(m.id), 'sheet_a.jpg'), Buffer.alloc(500, 1));
  fs.writeFileSync(path.join(modelRefsDir(m.id), 'bike.jpg'), Buffer.alloc(400, 2));
  addModelRef({ modelId: m.id, variantId: v.id, file: 'sheet_a.jpg', role: 'model', note: 'нота модели КАПС' });
  addModelRef({ modelId: m.id, variantId: null, file: 'bike.jpg', role: 'vehicle', note: 'байк — использовать только если в кадре' });
  return { modelId: m.id, variantId: v.id };
}

describe('модели: домен', () => {
  it('variantRefs: модель первой, общие следом', () => {
    const u = mkUser('u-vr', 201);
    const { modelId, variantId } = mkModelWithSheet(u);
    const refs = variantRefs(modelId, variantId);
    expect(refs.map((r) => r.role)).toEqual(['model', 'vehicle']);
  });

  it('applyModelVariant копирует рефы в чистый проект (role_source=preset), чужой вариант — отказ', () => {
    const u = mkUser('u-av', 202);
    const stranger = mkUser('u-stranger', 203);
    const { modelId, variantId } = mkModelWithSheet(u);
    const pid = mkProject(randomUUID(), u);

    applyModelVariant(u, pid, variantId);
    const refs = getDb()
      .prepare(`SELECT role, file, note, role_source FROM refs WHERE project_id = ? ORDER BY idx`)
      .all(pid) as Array<{ role: string; file: string; note: string; role_source: string }>;
    expect(refs.length).toBe(2);
    expect(refs[0]!.role).toBe('model');
    expect(refs[0]!.note).toContain('КАПС');
    expect(refs.every((r) => r.role_source === 'preset')).toBe(true);
    for (const r of refs) expect(fs.existsSync(path.join(refsDir(pid), r.file))).toBe(true);

    // повторное применение на проект с рефами — отказ
    expect(() => applyModelVariant(u, pid, variantId)).toThrow(/уже есть референсы/);
    // чужой пользователь не может применить мой вариант
    const pid2 = mkProject(randomUUID(), stranger);
    expect(() => applyModelVariant(stranger, pid2, variantId)).toThrow(/не найдена/);
    // вариант без модельного рефа — отказ
    const m2 = createModel(u, 'Пустая');
    const v2 = addVariant(m2.id, 'без листов');
    const pid3 = mkProject(randomUUID(), u);
    expect(() => applyModelVariant(u, pid3, v2.id)).toThrow(/нет реф-листа/);
    expect(deleteModel(u, modelId)).toBe(true);
    // проект самодостаточен: рефы скопированы, удаление модели их не трогает
    for (const r of refs) expect(fs.existsSync(path.join(refsDir(pid), r.file))).toBe(true);
  });
});

describe('m002: сид пресетов в модели владельца', () => {
  function freshDb() {
    const d = new DatabaseSync(':memory:');
    applySchema(d);
    return d;
  }

  it('2 модели × 3 варианта, ноты verbatim, общий байк один (variant_id NULL)', () => {
    const d = freshDb();
    runDataMigrations(d, { ownerTelegramId: '777' });
    const models = d.prepare(`SELECT id, name FROM models ORDER BY name`).all() as Array<{ id: string; name: string }>;
    expect(models.map((m) => m.name).sort()).toEqual(['Lunaria', 'MotoLola']);
    for (const m of models) {
      const variants = d.prepare(`SELECT title FROM model_variants WHERE model_id = ? ORDER BY idx`).all(m.id) as Array<{ title: string }>;
      expect(variants.length).toBe(3);
      const shared = d.prepare(`SELECT file, note FROM model_refs WHERE model_id = ? AND variant_id IS NULL`).all(m.id) as Array<{ file: string; note: string }>;
      expect(shared.length).toBe(1); // один общий байк, не три копии
      expect(shared[0]!.note).toContain('ТОЛЬКО если в исходнике есть мотоцикл');
      const own = d.prepare(`SELECT note FROM model_refs WHERE model_id = ? AND variant_id IS NOT NULL`).all(m.id) as Array<{ note: string }>;
      expect(own.length).toBe(3);
    }
    // ноты модельных листов byte-identical нотам пресетов
    const allNotes = (d.prepare(`SELECT note FROM model_refs`).all() as Array<{ note: string }>).map((r) => r.note);
    for (const p of PRESETS) {
      const modelRef = p.refs.find((r) => r.role === 'model')!;
      expect(allNotes).toContain(modelRef.note);
    }
    // файлы скопированы на диск
    const anyRef = d.prepare(`SELECT model_id, file FROM model_refs LIMIT 1`).get() as { model_id: string; file: string };
    expect(fs.existsSync(path.join(modelRefsDir(anyRef.model_id), anyRef.file))).toBe(true);
    // идемпотентность
    runDataMigrations(d, { ownerTelegramId: '777' });
    expect((d.prepare(`SELECT COUNT(*) AS c FROM models`).get() as { c: number }).c).toBe(2);
  });

  it('без владельца откладывается', () => {
    const d = freshDb();
    runDataMigrations(d, { ownerTelegramId: null });
    expect((d.prepare(`SELECT COUNT(*) AS c FROM models`).get() as { c: number }).c).toBe(0);
    expect(d.prepare(`SELECT 1 FROM schema_migrations WHERE id = 'm002-seed-owner-models'`).get()).toBeUndefined();
  });
});

describe('модели: роуты (ownership)', () => {
  let appA: Awaited<ReturnType<typeof makeAuthedApp>>;
  let appB: Awaited<ReturnType<typeof makeAuthedApp>>;
  let modelId: string;

  beforeAll(async () => {
    appA = await makeAuthedApp(9101, 'Юзер А');
    appB = await makeAuthedApp(9102, 'Юзер Б');
    const created = await appA.app.inject({ method: 'POST', url: '/api/models', payload: { name: 'Приватная' } });
    expect(created.statusCode).toBe(200);
    modelId = (created.json() as { id: string }).id;
    await appA.app.inject({ method: 'POST', url: `/api/models/${modelId}/variants`, payload: { title: 'базовый' } });
  });

  it('B не видит и не мутирует модель A (404 на все роуты)', async () => {
    const listB = (await appB.app.inject({ method: 'GET', url: '/api/models' })).json() as Array<{ id: string }>;
    expect(listB.map((m) => m.id)).not.toContain(modelId);

    const attempts: Array<[string, string]> = [
      ['PATCH', `/api/models/${modelId}`],
      ['DELETE', `/api/models/${modelId}`],
      ['POST', `/api/models/${modelId}/variants`],
      ['GET', `/api/models/${modelId}/file/sheet.jpg`],
    ];
    for (const [method, url] of attempts) {
      const res = await appB.app.inject({ method: method as 'POST', url, payload: { name: 'x', title: 'x' } });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    // A видит свою
    const listA = (await appA.app.inject({ method: 'GET', url: '/api/models' })).json() as Array<{ id: string; variants: unknown[] }>;
    expect(listA.map((m) => m.id)).toContain(modelId);
  });

  it('POST /swap {variantId} чужого варианта → 404; свой без листов → 409', async () => {
    const models = (await appA.app.inject({ method: 'GET', url: '/api/models' })).json() as Array<{
      id: string;
      variants: Array<{ id: string }>;
    }>;
    const myVariant = models.find((m) => m.id === modelId)!.variants[0]!.id;
    // проект A без листов у варианта → 409 с понятным текстом
    const pidA = mkProject(randomUUID(), appA.userId);
    const no = await appA.app.inject({ method: 'POST', url: `/api/projects/${pidA}/swap`, payload: { variantId: myVariant } });
    expect(no.statusCode).toBe(409);
    expect((no.json() as { error: string }).error).toContain('нет реф-листа');
    // B пытается свапнуть МОИМ вариантом на своём проекте → 404
    const pidB = mkProject(randomUUID(), appB.userId);
    const res = await appB.app.inject({ method: 'POST', url: `/api/projects/${pidB}/swap`, payload: { variantId: myVariant } });
    expect(res.statusCode).toBe(404);
  });
});
