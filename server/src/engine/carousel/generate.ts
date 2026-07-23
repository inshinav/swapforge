// Anchor-цепочка генерации карусели (SPEC §2/§5): слайд 1 → QC → якорь; 2..N с якорем.
// Пер-слайдовые чекпоинты в carousel_slides делают ран резюм-безопасным: повторный вызов
// пропускает завершённые слайды. Биллинг здесь НЕ живёт (worker/billing, P2) — движок
// только генерит и размечает статусы.
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../../db';
import { config } from '../../config';
import { getImageProvider, type ImageProvider } from '../../image/provider';
import type { LlmClient } from '../../llm/provider';
import { carouselRefsDir, carouselSlidesDir, ensureCarouselDirs, minerDir, modelRefsDir } from '../../storage';

import { StoryboardZ, type Storyboard, type StoryboardSlide, type UgcPreset } from '../../../../shared/carousel';
import { buildSlidePrompt } from './prompt';
import { getScene } from './locations';
import { qcPasses, runSlideQc } from './qc';
import { finalizeSlideFile } from './finalize';
import { RETRY_BOOST } from './blocks';
import { variantRefs } from '../../models';

/** Фатальная ошибка рана: worker переводит карусель в failed (полный release, SPEC §7). */
export class CarouselRunError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'CarouselRunError';
  }
}

/**
 * Легальный guardrail (SPEC §0.5/§3): замайненные изображения — только показ в подборке.
 * Любой путь из miner-кэша среди референсов генерации = фатальная ошибка рана.
 */
export function assertNoMinedPaths(paths: string[]): void {
  const minerRoot = path.resolve(minerDir(''));
  for (const p of paths) {
    if (path.resolve(p).startsWith(minerRoot)) {
      throw new CarouselRunError(
        'Замайненные изображения нельзя использовать как референсы генерации — только структура/идеи (SPEC §3)',
      );
    }
  }
}


interface CarouselRow {
  id: string;
  user_id: string;
  model_id: string | null;
  variant_id: string | null;
  storyboard_json: string | null;
  location_pack: string;
  idea_json: string | null;
}

interface SlideRow {
  id: string;
  idx: number;
  status: string;
  file: string | null;
  auto_retries: number;
}

export interface CarouselRunDeps {
  provider?: ImageProvider;
  qcLlm?: LlmClient;
}

function ugcPresetOf(carousel: CarouselRow): UgcPreset {
  try {
    const idea = carousel.idea_json ? (JSON.parse(carousel.idea_json) as { ugcPreset?: UgcPreset }) : null;
    return idea?.ugcPreset ?? 'casual';
  } catch {
    return 'casual';
  }
}

/** Identity-рефы (до 2, role=model) + опциональный product-реф модели. */
function collectModelRefs(carousel: CarouselRow): {
  identityPaths: string[];
  identityNote: string;
  productPath: string | null;
  productNote: string;
} {
  if (!carousel.model_id || !carousel.variant_id) {
    throw new CarouselRunError('У карусели нет модели — выбери модель и вариант заново');
  }
  const refs = variantRefs(carousel.model_id, carousel.variant_id);
  const identity = refs.filter((r) => r.role === 'model').slice(0, 2);
  if (identity.length === 0) {
    throw new CarouselRunError('У модели нет identity-фото (role=model) — добавь листы в конструкторе');
  }
  const dir = modelRefsDir(carousel.model_id);
  const identityPaths = identity.map((r) => path.join(dir, r.file));
  for (const p of identityPaths) {
    if (!fs.existsSync(p)) throw new CarouselRunError('Файлы модели не найдены — модель была изменена');
  }
  const product = refs.find((r) => r.role !== 'model') ?? null;
  return {
    identityPaths,
    identityNote: identity.map((r) => (r.note || r.auto_note).trim()).filter(Boolean).join(' '),
    productPath: product ? path.join(dir, product.file) : null,
    productNote: product ? (product.note || product.auto_note).trim() : '',
  };
}

/** P8: лук (первое фото) и пропсы (до 2) карусели — файлы в carouselRefsDir. */
function collectCarouselRefs(carouselId: string): {
  lookPath: string | null;
  propPaths: string[];
} {
  const rows = getDb()
    .prepare(
      `SELECT kind, file FROM carousel_refs WHERE carousel_id=? ORDER BY kind ASC, idx ASC, rowid ASC`,
    )
    .all(carouselId) as Array<{ kind: 'look' | 'prop'; file: string }>;
  const dir = carouselRefsDir(carouselId);
  const exists = (f: string) => fs.existsSync(path.join(dir, f));
  const look = rows.find((r) => r.kind === 'look' && exists(r.file)) ?? null;
  const props = rows.filter((r) => r.kind === 'prop' && exists(r.file)).slice(0, 2);
  return {
    lookPath: look ? path.join(dir, look.file) : null,
    propPaths: props.map((r) => path.join(dir, r.file)),
  };
}

/** Идемпотентно создаёт чекпоинт-строки слайдов под storyboard (resume-safe). */
export function ensureSlideRows(carouselId: string, storyboard: Storyboard): void {
  const db = getDb();
  const ins = db.prepare(
    `INSERT OR IGNORE INTO carousel_slides (id, carousel_id, idx, is_anchor) VALUES (?, ?, ?, ?)`,
  );
  for (const s of storyboard.slides) {
    ins.run(`${carouselId.slice(0, 8)}-s${s.idx}-${s.role}`, carouselId, s.idx, s.idx === 1 ? 1 : 0);
  }
}

function setSlide(slideId: string, fields: Record<string, unknown>): void {
  const keys = Object.keys(fields);
  getDb()
    .prepare(
      `UPDATE carousel_slides SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=datetime('now') WHERE id=?`,
    )
    .run(...keys.map((k) => fields[k] as never), slideId);
}

/**
 * Основной ран: обрабатывает слайды по порядку idx, пропуская завершённые.
 * Бросает CarouselRunError только на фатальном (нет модели, якорь не получился) —
 * одиночные слайды деградируют в needs_review/moderated/failed без остановки рана.
 */
export async function generateCarouselSlides(carouselId: string, deps: CarouselRunDeps = {}): Promise<void> {
  const db = getDb();
  const carousel = db
    .prepare(
      `SELECT id, user_id, model_id, variant_id, storyboard_json, location_pack, idea_json
         FROM carousel_projects WHERE id=?`,
    )
    .get(carouselId) as CarouselRow | undefined;
  if (!carousel) throw new CarouselRunError('Карусель не найдена');
  if (!carousel.storyboard_json) throw new CarouselRunError('Нет раскадровки — сначала собери storyboard');
  const storyboard = StoryboardZ.parse(JSON.parse(carousel.storyboard_json));
  const preset = ugcPresetOf(carousel);
  const model = collectModelRefs(carousel);
  const extras = collectCarouselRefs(carouselId);
  const provider = deps.provider ?? (await getImageProvider());
  ensureCarouselDirs(carouselId);
  ensureSlideRows(carouselId, storyboard);

  const slides = db
    .prepare(`SELECT id, idx, status, file, auto_retries FROM carousel_slides WHERE carousel_id=? ORDER BY idx ASC`)
    .all(carouselId) as unknown as SlideRow[];

  let anchorPath: string | null = null;
  const doneAnchor = slides.find((s) => s.idx === 1 && s.status === 'done' && s.file);
  if (doneAnchor?.file) anchorPath = path.join(carouselSlidesDir(carouselId), doneAnchor.file);

  for (const slide of slides) {
    if (['done', 'needs_review', 'moderated'].includes(slide.status)) continue;
    const sb = storyboard.slides.find((s) => s.idx === slide.idx);
    if (!sb) {
      setSlide(slide.id, { status: 'failed', error: 'Слайд отсутствует в раскадровке' });
      continue;
    }
    const scene = getScene(carousel.location_pack, sb.sceneId);
    if (!scene) {
      setSlide(slide.id, { status: 'failed', error: `Сцена ${sb.sceneId} не найдена в паке ${carousel.location_pack}` });
      continue;
    }
    const isAnchorSlide = sb.idx === 1;
    const outcome = await generateOneSlide({
      carousel,
      slide,
      sb,
      scenePromptScene: scene,
      preset,
      model,
      extras,
      anchorPath: isAnchorSlide ? null : anchorPath,
      provider,
      qcLlm: deps.qcLlm,
    });
    if (isAnchorSlide) {
      if (outcome.status !== 'done') {
        throw new CarouselRunError(
          outcome.status === 'moderated'
            ? 'Якорный слайд отбит модерацией — переформулируй идею/сцену'
            : 'Якорный слайд не прошёл контроль качества — попробуй другую сцену или рефы',
        );
      }
      anchorPath = outcome.filePath;
    }
  }
}

interface OneSlideInput {
  carousel: CarouselRow;
  slide: SlideRow;
  sb: StoryboardSlide;
  scenePromptScene: NonNullable<ReturnType<typeof getScene>>;
  preset: UgcPreset;
  model: ReturnType<typeof collectModelRefs>;
  extras: ReturnType<typeof collectCarouselRefs>;
  anchorPath: string | null;
  provider: ImageProvider;
  qcLlm?: LlmClient;
}

async function generateOneSlide(
  input: OneSlideInput,
): Promise<{ status: 'done' | 'needs_review' | 'moderated' | 'failed'; filePath: string | null }> {
  const { carousel, slide, sb, preset, model, extras, anchorPath, provider } = input;
  // P8: пропсы слайда — карусельные prop-рефы при propNote; legacy-фолбэк: модельный
  // vehicle/object-реф при useProductRef, если карусельных пропсов нет.
  const wantsProps = sb.propNote.trim().length > 0 && extras.propPaths.length > 0;
  const legacyProduct =
    !wantsProps && extras.propPaths.length === 0 && sb.useProductRef && model.productPath !== null;
  const imagePaths = [...model.identityPaths];
  let anchorRefIndex: number | undefined;
  let lookRefIndex: number | undefined;
  let propsFirstIndex: number | undefined;
  let productRefIndex: number | undefined;
  if (anchorPath) {
    imagePaths.push(anchorPath);
    anchorRefIndex = imagePaths.length;
  }
  if (extras.lookPath) {
    imagePaths.push(extras.lookPath);
    lookRefIndex = imagePaths.length;
  }
  if (wantsProps) {
    propsFirstIndex = imagePaths.length + 1;
    imagePaths.push(...extras.propPaths);
  }
  if (legacyProduct && model.productPath) {
    imagePaths.push(model.productPath);
    productRefIndex = imagePaths.length;
  }

  // Полный набор референсов собран — легальный гард перед платным вызовом.
  assertNoMinedPaths(imagePaths);

  const basePrompt = buildSlidePrompt({
    slide: sb,
    scene: input.scenePromptScene,
    modelNote: model.identityNote,
    identityRefCount: model.identityPaths.length,
    ugcPreset: preset,
    aspect: '4:5',
    anchorRefIndex,
    lookRefIndex,
    propsFirstIndex,
    propsCount: wantsProps ? extras.propPaths.length : undefined,
    productRefIndex,
    productNote: model.productNote,
  });

  // Попытка 0 + один авто-ретрай с усиленным guardrail (SPEC §5, за счёт заведения).
  for (let attemptNo = 0; attemptNo <= 1; attemptNo++) {
    const prompt = attemptNo === 0 ? basePrompt : `${basePrompt} ${RETRY_BOOST}`;
    setSlide(slide.id, {
      status: 'generating',
      prompt_json: JSON.stringify({ prompt, refs: imagePaths.map((p) => path.basename(p)) }),
      auto_retries: attemptNo,
    });
    let res;
    try {
      res = await provider.edit({
        prompt,
        imagePaths,
        size: config.carouselSlideSize,
        quality: config.imageQuality,
        meta: { carouselId: carousel.id, userId: carousel.user_id, slideId: slide.id },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSlide(slide.id, { status: 'failed', error: msg.slice(0, 500) });
      return { status: 'failed', filePath: null };
    }
    if (res.moderated) {
      setSlide(slide.id, { status: 'moderated', error: null });
      return { status: 'moderated', filePath: null };
    }
    const file = `slide_${String(sb.idx).padStart(2, '0')}_${slide.id.slice(-6)}.png`;
    const filePath = path.join(carouselSlidesDir(carousel.id), file);
    fs.writeFileSync(filePath, Buffer.from(res.b64, 'base64'));
    setSlide(slide.id, { status: 'qc', file });

    let verdict;
    try {
      verdict = await runSlideQc(
        {
          slideImagePath: filePath,
          identityRefPaths: model.identityPaths,
          sceneDescription: `${sb.action}. Scene: ${input.scenePromptScene.promptBlock}`,
          carouselId: carousel.id,
          userId: carousel.user_id,
          slideId: slide.id,
        },
        input.qcLlm,
      );
    } catch (e) {
      // QC недоступен — fail-closed в пользу ревью человеком, ретрай не сжигаем.
      const msg = e instanceof Error ? e.message : String(e);
      setSlide(slide.id, {
        status: 'needs_review',
        qc_json: JSON.stringify({ error: `QC недоступен: ${msg.slice(0, 200)}` }),
      });
      return { status: 'needs_review', filePath };
    }
    setSlide(slide.id, { qc_json: JSON.stringify(verdict) });
    if (qcPasses(verdict)) {
      setSlide(slide.id, { status: 'done' });
      // Best-effort доводка до 1080×1350: провал не роняет слайд (экспорт отдаст raw).
      await finalizeSlideFile(carousel.id, slide.id).catch(() => null);
      return { status: 'done', filePath };
    }
    if (attemptNo === 1) {
      setSlide(slide.id, { status: 'needs_review' });
      return { status: 'needs_review', filePath };
    }
    console.warn(
      `[carousel-qc] carousel=${carousel.id} слайд ${sb.idx} не прошёл QC (identity=${verdict.identity} artifacts=${verdict.artifacts} realism=${verdict.realism}) — авто-ретрай с усиленным guardrail`,
    );
  }
  return { status: 'failed', filePath: null };
}
