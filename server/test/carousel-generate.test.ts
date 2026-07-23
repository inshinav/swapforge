// Anchor-цепочка (SPEC §2/§5): порядок рефов и номера, авто-ретрай после QC-провала,
// деградация одиночного слайда, фатальность якоря, resume пропускает готовое.
import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-carousel-gen-'));
process.env.CAROUSEL_QC_IDENTITY_MIN = '7';
process.env.CAROUSEL_QC_ARTIFACTS_MIN = '6';
process.env.CAROUSEL_QC_REALISM_MIN = '6';

const { getDb } = await import('../src/db');
const { CarouselRunError, generateCarouselSlides } = await import('../src/engine/carousel/generate');
const { carouselSlidesDir, ensureModelDirs, modelRefsDir } = await import('../src/storage');
const { RETRY_BOOST } = await import('../src/engine/carousel/blocks');
import type { ImageEditRequest, ImageProvider } from '../src/image/provider';
import type { QcVerdict, Storyboard } from '../../shared/carousel';

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const GOOD_QC: QcVerdict = { identity: 9, artifacts: 8, realism: 8, sceneMatch: true, notes: 'ok' };
const BAD_QC: QcVerdict = { identity: 4, artifacts: 5, realism: 5, sceneMatch: false, notes: 'off' };

let userId: string;
let modelId: string;
let variantId: string;

function seedModel(): void {
  const db = getDb();
  userId = randomUUID();
  db.prepare(`INSERT INTO users (id, telegram_id, tg_username) VALUES (?, ?, ?)`).run(
    userId,
    Math.floor(Math.random() * 1e9),
    'gen-user',
  );
  modelId = randomUUID();
  variantId = randomUUID();
  db.prepare(`INSERT INTO models (id, user_id, name) VALUES (?, ?, 'Lola')`).run(modelId, userId);
  db.prepare(`INSERT INTO model_variants (id, model_id, title, idx) VALUES (?, ?, 'Look 1', 0)`).run(
    variantId,
    modelId,
  );
  ensureModelDirs(modelId);
  for (const [i, file] of ['sheet_a.jpg', 'sheet_b.jpg'].entries()) {
    fs.writeFileSync(path.join(modelRefsDir(modelId), file), PIXEL);
    db.prepare(
      `INSERT INTO model_refs (id, model_id, variant_id, file, role, note, idx) VALUES (?, ?, ?, ?, 'model', ?, ?)`,
    ).run(randomUUID(), modelId, variantId, file, i === 0 ? 'Redhead, green eyes.' : '', i);
  }
  fs.writeFileSync(path.join(modelRefsDir(modelId), 'bike.jpg'), PIXEL);
  db.prepare(
    `INSERT INTO model_refs (id, model_id, variant_id, file, role, note, idx) VALUES (?, ?, NULL, 'bike.jpg', 'vehicle', 'White ZX-6R.', 9)`,
  ).run(randomUUID(), modelId);
}

function storyboard3(): Storyboard {
  const mk = (idx: number, role: 'hook' | 'context' | 'payoff', useProductRef = false) => ({
    idx,
    role,
    sceneId: 'south-beach-sand',
    action: `action ${idx}`,
    outfit: 'white dress',
    camera: 'friend POV',
    useProductRef,
  });
  return { slides: [mk(1, 'hook'), mk(2, 'context', true), mk(3, 'payoff')], anchorNote: 'lock look' };
}

function insertCarousel(storyboard: Storyboard): string {
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO carousel_projects (id, user_id, model_id, variant_id, status, storyboard_json, slide_count, idea_json)
       VALUES (?, ?, ?, ?, 'generating', ?, ?, ?)`,
    )
    .run(id, userId, modelId, variantId, JSON.stringify(storyboard), storyboard.slides.length,
      JSON.stringify({ ugcPreset: 'casual' }));
  return id;
}

function slideRows(carouselId: string): Array<{ idx: number; status: string; file: string | null; auto_retries: number; is_anchor: number }> {
  return getDb()
    .prepare(`SELECT idx, status, file, auto_retries, is_anchor FROM carousel_slides WHERE carousel_id=? ORDER BY idx`)
    .all(carouselId) as never;
}

function okProvider(calls: ImageEditRequest[]): ImageProvider {
  return {
    name: () => 'fake',
    async edit(req) {
      calls.push(req);
      return { b64: PIXEL.toString('base64'), model: 'fake-img', tokensIn: 10, tokensOut: 100 };
    },
  };
}

const qcAlways = (verdicts: QcVerdict[]) => ({
  name: () => 'fake-qc',
  async structured() {
    return verdicts.length > 1 ? verdicts.shift()! : verdicts[0]!;
  },
});

beforeEach(seedModel);

describe('carousel: anchor-цепочка', () => {
  it('happy path: якорь без anchor-блока, 2..N с якорем и product по номерам, все done', async () => {
    const id = insertCarousel(storyboard3());
    const calls: ImageEditRequest[] = [];
    await generateCarouselSlides(id, { provider: okProvider(calls), qcLlm: qcAlways([GOOD_QC]) });

    const rows = slideRows(id);
    expect(rows.map((r) => r.status)).toEqual(['done', 'done', 'done']);
    expect(rows[0]?.is_anchor).toBe(1);
    for (const r of rows) expect(fs.existsSync(path.join(carouselSlidesDir(id), r.file!))).toBe(true);

    // Слайд 1: только 2 identity-рефа, промт без anchor-блока.
    expect(calls[0]?.imagePaths).toHaveLength(2);
    expect(calls[0]?.prompt).not.toContain('previous slide');
    // Слайд 2: identity×2 + anchor(№3) + product(№4), нумерация в промте совпадает.
    expect(calls[1]?.imagePaths).toHaveLength(4);
    expect(calls[1]?.imagePaths[2]).toContain(path.join('carousels', id, 'slides'));
    expect(calls[1]?.prompt).toContain('Reference image 3 is the previous slide');
    expect(calls[1]?.prompt).toContain('Reference image 4 is a product');
    expect(calls[1]?.prompt).toContain('White ZX-6R.');
    // Слайд 3: без product (useProductRef=false) → identity×2 + anchor(№3).
    expect(calls[2]?.imagePaths).toHaveLength(3);
    expect(calls[2]?.prompt).toContain('Reference image 3 is the previous slide');
  });

  it('QC-провал → один авто-ретрай с RETRY_BOOST → done при успехе', async () => {
    const id = insertCarousel(storyboard3());
    const calls: ImageEditRequest[] = [];
    // Слайд 1: провал → буст → успех; остальные сразу успех.
    await generateCarouselSlides(id, {
      provider: okProvider(calls),
      qcLlm: qcAlways([BAD_QC, GOOD_QC, GOOD_QC, GOOD_QC]),
    });
    const rows = slideRows(id);
    expect(rows[0]).toMatchObject({ status: 'done', auto_retries: 1 });
    expect(calls[1]?.prompt).toContain(RETRY_BOOST);
  });

  it('двойной QC-провал не-якорного слайда → needs_review, ран продолжается', async () => {
    const id = insertCarousel(storyboard3());
    // Слайд 1 ok; слайд 2 дважды плохой; слайд 3 ok.
    await generateCarouselSlides(id, {
      provider: okProvider([]),
      qcLlm: qcAlways([GOOD_QC, BAD_QC, BAD_QC, GOOD_QC]),
    });
    expect(slideRows(id).map((r) => r.status)).toEqual(['done', 'needs_review', 'done']);
  });

  it('moderated не-якорный слайд не останавливает ран', async () => {
    const id = insertCarousel(storyboard3());
    let n = 0;
    const provider: ImageProvider = {
      name: () => 'fake',
      async edit() {
        n++;
        if (n === 2) return { b64: '', model: 'fake-img', tokensIn: 0, tokensOut: 0, moderated: true };
        return { b64: PIXEL.toString('base64'), model: 'fake-img', tokensIn: 10, tokensOut: 100 };
      },
    };
    await generateCarouselSlides(id, { provider, qcLlm: qcAlways([GOOD_QC]) });
    expect(slideRows(id).map((r) => r.status)).toEqual(['done', 'moderated', 'done']);
  });

  it('модерация якоря → CarouselRunError, слайды 2..N не трогаются', async () => {
    const id = insertCarousel(storyboard3());
    const provider: ImageProvider = {
      name: () => 'fake',
      async edit() {
        return { b64: '', model: 'fake-img', tokensIn: 0, tokensOut: 0, moderated: true };
      },
    };
    await expect(
      generateCarouselSlides(id, { provider, qcLlm: qcAlways([GOOD_QC]) }),
    ).rejects.toThrow(CarouselRunError);
    expect(slideRows(id).map((r) => r.status)).toEqual(['moderated', 'pending', 'pending']);
  });

  it('resume: готовый якорь пропускается, провайдер зовётся только для остальных', async () => {
    const id = insertCarousel(storyboard3());
    const calls: ImageEditRequest[] = [];
    await generateCarouselSlides(id, { provider: okProvider(calls), qcLlm: qcAlways([GOOD_QC]) });
    expect(calls).toHaveLength(3);
    // Ломаем слайды 2-3 обратно в pending — имитация крэша после якоря.
    getDb()
      .prepare(`UPDATE carousel_slides SET status='pending', file=NULL WHERE carousel_id=? AND idx>1`)
      .run(id);
    const resumeCalls: ImageEditRequest[] = [];
    await generateCarouselSlides(id, { provider: okProvider(resumeCalls), qcLlm: qcAlways([GOOD_QC]) });
    expect(resumeCalls).toHaveLength(2);
    expect(slideRows(id).map((r) => r.status)).toEqual(['done', 'done', 'done']);
  });

  it('ошибка QC-вызова → needs_review (fail-closed к человеку), ретрай не сжигается', async () => {
    const id = insertCarousel(storyboard3());
    let qcCalls = 0;
    await generateCarouselSlides(id, {
      provider: okProvider([]),
      qcLlm: {
        name: () => 'fake-qc',
        async structured() {
          qcCalls++;
          if (qcCalls === 2) throw new Error('llm down');
          return GOOD_QC;
        },
      },
    });
    const rows = slideRows(id);
    expect(rows.map((r) => r.status)).toEqual(['done', 'needs_review', 'done']);
    expect(rows[1]?.auto_retries).toBe(0);
  });

  it('карусель без модели → CarouselRunError', async () => {
    const id = insertCarousel(storyboard3());
    getDb().prepare(`UPDATE carousel_projects SET model_id=NULL WHERE id=?`).run(id);
    await expect(generateCarouselSlides(id, { provider: okProvider([]) })).rejects.toThrow(
      /нет модели/,
    );
  });
});
