// P8: луки и пропсы — роуты (look_note, upload/from-model/delete, cap, tenancy, статус-гейт),
// порядок референсов генерации (identity→anchor→look→props) и нумерация в промте.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-carousel-looks-'));
process.env.AUTH_DEV_BYPASS = '1';
process.env.CAROUSEL_STUDIO = '1';
process.env.CAROUSEL_QC_IDENTITY_MIN = '7';
process.env.CAROUSEL_QC_ARTIFACTS_MIN = '6';
process.env.CAROUSEL_QC_REALISM_MIN = '6';

const { buildApp } = await import('../src/app');
const { getDb } = await import('../src/db');
const { generateCarouselSlides } = await import('../src/engine/carousel/generate');
const { carouselRefsDir, ensureModelDirs, modelRefsDir } = await import('../src/storage');

import type { FastifyInstance } from 'fastify';
import type { ImageEditRequest, ImageProvider } from '../src/image/provider';
import type { QcVerdict } from '../../shared/carousel';

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const GOOD: QcVerdict = { identity: 9, artifacts: 8, realism: 8, sceneMatch: true, notes: '' };

interface Creds {
  cookie: string;
  csrf: string;
  userId: string;
}

async function login(app: FastifyInstance, telegramId: number): Promise<Creds> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/dev-login', payload: { telegramId, name: 'L' } });
  const setCookies = res.headers['set-cookie'] as string[];
  const sess = setCookies.find((c) => c.startsWith('sf_sess='))!.split(';')[0]!;
  const csrfPair = setCookies.find((c) => c.startsWith('sf_csrf='))!.split(';')[0]!;
  return {
    cookie: `${sess}; ${csrfPair}`,
    csrf: decodeURIComponent(csrfPair.split('=').slice(1).join('=')),
    userId: (res.json() as { user: { id: string } }).user.id,
  };
}

const authed = (c: Creds) => ({ cookie: c.cookie, 'x-sf-csrf': c.csrf });

function multipart(
  fields: Record<string, string>,
  file: { name: string; filename: string; mime: string; data: Buffer },
): { payload: Buffer; headers: Record<string, string> } {
  const b = `----sfb${randomUUID().slice(0, 8)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${b}\r\ncontent-disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${b}\r\ncontent-disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\ncontent-type: ${file.mime}\r\n\r\n`,
    ),
    file.data,
    Buffer.from(`\r\n--${b}--\r\n`),
  );
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${b}` },
  };
}

function seedModelFor(userId: string): { modelId: string; variantId: string; vehicleRefId: string; modelRefId: string } {
  const db = getDb();
  const modelId = randomUUID();
  const variantId = randomUUID();
  db.prepare(`INSERT INTO models (id, user_id, name) VALUES (?, ?, 'M')`).run(modelId, userId);
  db.prepare(`INSERT INTO model_variants (id, model_id, title, idx) VALUES (?, ?, 'V', 0)`).run(variantId, modelId);
  ensureModelDirs(modelId);
  fs.writeFileSync(path.join(modelRefsDir(modelId), 'sheet.jpg'), PIXEL);
  fs.writeFileSync(path.join(modelRefsDir(modelId), 'bike.jpg'), PIXEL);
  const modelRefId = randomUUID();
  db.prepare(
    `INSERT INTO model_refs (id, model_id, variant_id, file, role, note, idx) VALUES (?, ?, ?, 'sheet.jpg', 'model', 'N', 0)`,
  ).run(modelRefId, modelId, variantId);
  const vehicleRefId = randomUUID();
  db.prepare(
    `INSERT INTO model_refs (id, model_id, variant_id, file, role, note, idx) VALUES (?, ?, NULL, 'bike.jpg', 'vehicle', 'Orange ZX-6R.', 1)`,
  ).run(vehicleRefId, modelId);
  return { modelId, variantId, vehicleRefId, modelRefId };
}

describe('carousel: луки и пропсы', () => {
  let app: FastifyInstance;
  let user: Creds;
  let model: ReturnType<typeof seedModelFor>;
  let carouselId: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    user = await login(app, 6001);
    model = seedModelFor(user.userId);
    const created = await app.inject({
      method: 'POST',
      url: '/api/carousel/projects',
      headers: authed(user),
      payload: { modelId: model.modelId, variantId: model.variantId },
    });
    carouselId = (created.json() as { carousel: { id: string } }).carousel.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('look_note сохраняется и отдаётся в CarouselInfo; при generating — 409', async () => {
    const save = await app.inject({
      method: 'PATCH',
      url: `/api/carousel/projects/${carouselId}/look`,
      headers: authed(user),
      payload: { note: 'белое льняное платье, золотая цепочка' },
    });
    expect(save.statusCode).toBe(200);
    const got = await app.inject({ method: 'GET', url: `/api/carousel/projects/${carouselId}`, headers: authed(user) });
    expect((got.json() as { carousel: { lookNote: string } }).carousel.lookNote).toContain('льняное');

    getDb().prepare(`UPDATE carousel_projects SET status='generating' WHERE id=?`).run(carouselId);
    const denied = await app.inject({
      method: 'PATCH',
      url: `/api/carousel/projects/${carouselId}/look`,
      headers: authed(user),
      payload: { note: 'x' },
    });
    expect(denied.statusCode).toBe(409);
    getDb().prepare(`UPDATE carousel_projects SET status='draft' WHERE id=?`).run(carouselId);
  });

  it('upload look/prop: пишет файл и строку; не-image → 415; ref-роут отдаёт и режет травёрсал', async () => {
    const up = multipart({ kind: 'look', note: 'платье' }, { name: 'file', filename: 'look.png', mime: 'image/png', data: PIXEL });
    const res = await app.inject({
      method: 'POST',
      url: `/api/carousel/projects/${carouselId}/refs`,
      headers: { ...authed(user), ...up.headers },
      payload: up.payload,
    });
    expect(res.statusCode).toBe(200);
    const refs = (res.json() as { refs: Array<{ kind: string; file: string }> }).refs;
    expect(refs.filter((r) => r.kind === 'look')).toHaveLength(1);
    const file = refs[0]!.file;
    expect(fs.existsSync(path.join(carouselRefsDir(carouselId), file))).toBe(true);

    const served = await app.inject({ method: 'GET', url: `/api/carousel/${carouselId}/ref/${file}`, headers: authed(user) });
    expect(served.statusCode).toBe(200);
    const trav = await app.inject({ method: 'GET', url: `/api/carousel/${carouselId}/ref/..%2Fslides%2Fx.png`, headers: authed(user) });
    expect(trav.statusCode).toBe(404);

    const bad = multipart({ kind: 'prop', note: '' }, { name: 'file', filename: 'x.txt', mime: 'text/plain', data: Buffer.from('hi') });
    const rejected = await app.inject({
      method: 'POST',
      url: `/api/carousel/projects/${carouselId}/refs`,
      headers: { ...authed(user), ...bad.headers },
      payload: bad.payload,
    });
    expect(rejected.statusCode).toBe(415);
  });

  it('from-model: vehicle копируется как prop с нотой; identity-лист → 422; чужой юзер → 404', async () => {
    const ok = await app.inject({
      method: 'POST',
      url: `/api/carousel/projects/${carouselId}/refs/from-model`,
      headers: authed(user),
      payload: { modelRefId: model.vehicleRefId },
    });
    expect(ok.statusCode).toBe(200);
    const refs = (ok.json() as { refs: Array<{ kind: string; note: string; source: string }> }).refs;
    const prop = refs.find((r) => r.kind === 'prop')!;
    expect(prop.source).toBe('model_ref');
    expect(prop.note).toContain('ZX-6R');

    const identity = await app.inject({
      method: 'POST',
      url: `/api/carousel/projects/${carouselId}/refs/from-model`,
      headers: authed(user),
      payload: { modelRefId: model.modelRefId },
    });
    expect(identity.statusCode).toBe(422);

    const stranger = await login(app, 6002);
    const foreign = await app.inject({
      method: 'POST',
      url: `/api/carousel/projects/${carouselId}/refs/from-model`,
      headers: authed(stranger),
      payload: { modelRefId: model.vehicleRefId },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('генерация: порядок рефов identity→anchor→look→props, нумерация в промте совпадает; без propNote пропсы не прикладываются', async () => {
    getDb()
      .prepare(`UPDATE carousel_projects SET storyboard_json=?, status='generating', idea_json='{"ugcPreset":"casual"}' WHERE id=?`)
      .run(
        JSON.stringify({
          slides: [
            { idx: 1, role: 'hook', sceneId: 'south-beach-sand', action: 'a1', outfit: 'o', camera: 'c', useProductRef: false, propNote: '' },
            { idx: 2, role: 'payoff', sceneId: 'open-air-cafe', action: 'a2', outfit: 'o', camera: 'c', useProductRef: true, propNote: 'sitting on her orange Kawasaki' },
          ],
          anchorNote: 'lock',
        }),
        carouselId,
      );
    const calls: ImageEditRequest[] = [];
    const provider: ImageProvider = {
      name: () => 'fake',
      async edit(req) {
        calls.push(req);
        return { b64: PIXEL.toString('base64'), model: 'f', tokensIn: 1, tokensOut: 1 };
      },
    };
    await generateCarouselSlides(carouselId, {
      provider,
      qcLlm: { name: () => 'q', async structured() { return GOOD; } },
    });
    // Слайд 1 (якорь): identity(1) + look(1); пропсов нет (propNote пуст).
    expect(calls[0]!.imagePaths).toHaveLength(2);
    expect(calls[0]!.imagePaths[1]).toContain(path.join('carousels', carouselId, 'refs'));
    expect(calls[0]!.prompt).toContain('Reference image 2 shows the exact outfit');
    expect(calls[0]!.prompt).not.toContain('show props');
    // Слайд 2: identity(1) + anchor(2) + look(3) + prop(4).
    expect(calls[1]!.imagePaths).toHaveLength(4);
    expect(calls[1]!.prompt).toContain('Reference image 2 is the previous slide');
    expect(calls[1]!.prompt).toContain('Reference image 3 shows the exact outfit');
    expect(calls[1]!.prompt).toContain('Reference image 4 shows a prop');
    expect(calls[1]!.prompt).toContain('sitting on her orange Kawasaki');
    const slides = getDb()
      .prepare(`SELECT status FROM carousel_slides WHERE carousel_id=? ORDER BY idx`)
      .all(carouselId) as Array<{ status: string }>;
    expect(slides.map((s) => s.status)).toEqual(['done', 'done']);
  });
});
