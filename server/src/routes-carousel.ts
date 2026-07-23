// Carousel Studio API v1 (SPEC §9). Auth+CSRF — глобальным default-deny (auth/middleware),
// тенантность — user_id в каждом запросе. Регистрируется ТОЛЬКО при config.carouselStudio;
// carouselOwnerOnly дополнительно прячет фичу от не-владельцев (404, не 403 — не палим).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getDb } from './db';
import { config } from './config';
import { getOwnedModel } from './models';
import { carouselQueuePosition, enqueueCarouselRun } from './engine/carousel/worker';
import {
  acceptSlide,
  carouselQuoteInfo,
  HoldConflictError,
  InsufficientCreditsError,
  startGenerationHold,
  withIdeationHold,
} from './engine/carousel/billing';
import { openHoldForProject, priceCredits } from './billing/credits';
import { deleteCarouselFiles, safeCarouselPath } from './storage';
import { getScene, listLocationPacks } from './engine/carousel/locations';
import { runIdeaEngine } from './engine/carousel/ideas';
import { runStoryboardEngine } from './engine/carousel/storyboard';
import { runCaptionEngine } from './engine/carousel/caption';
import { buildIdeationQuote } from './engine/carousel/pricing';
import {
  CarouselIdeaZ,
  StoryboardZ,
  type CarouselInfo,
  type SlideInfo,
} from '../../shared/carousel';

const MEDIA_CT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function bad(reply: FastifyReply, code: number, msg: string) {
  return reply.code(code).send({ error: msg });
}

/** carouselOwnerOnly: фича видна только владельцу (роуты отвечают 404). */
function hiddenFrom(req: FastifyRequest, reply: FastifyReply): boolean {
  if (config.carouselOwnerOnly && req.user!.role !== 'owner') {
    void bad(reply, 404, 'Не найдено');
    return true;
  }
  return false;
}

interface CarouselRow {
  id: string;
  user_id: string;
  model_id: string | null;
  variant_id: string | null;
  title: string;
  status: string;
  idea_json: string | null;
  storyboard_json: string | null;
  caption_json: string | null;
  location_pack: string;
  slide_count: number;
  review_deadline: string | null;
  error: string | null;
  created_at: string;
}

interface SlideRow {
  id: string;
  idx: number;
  status: string;
  file: string | null;
  final_file: string | null;
  is_anchor: number;
  qc_json: string | null;
  auto_retries: number;
  manual_retries: number;
  accepted: number;
  error: string | null;
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function toSlideInfo(s: SlideRow): SlideInfo {
  return {
    id: s.id,
    idx: s.idx,
    status: s.status as SlideInfo['status'],
    isAnchor: s.is_anchor === 1,
    file: s.file,
    finalFile: s.final_file,
    qc: parseJson(s.qc_json),
    autoRetries: s.auto_retries,
    manualRetries: s.manual_retries,
    accepted: s.accepted === 1,
    error: s.error,
  };
}

function toCarouselInfo(row: CarouselRow, slides: SlideRow[]): CarouselInfo {
  return {
    id: row.id,
    title: row.title,
    status: row.status as CarouselInfo['status'],
    modelId: row.model_id,
    variantId: row.variant_id,
    locationPack: row.location_pack,
    slideCount: row.slide_count,
    idea: parseJson(row.idea_json),
    storyboard: parseJson(row.storyboard_json),
    caption: parseJson(row.caption_json),
    slides: slides.map(toSlideInfo),
    reviewDeadline: row.review_deadline,
    error: row.error,
    createdAt: row.created_at,
  };
}

function getOwnedCarousel(userId: string, id: string): CarouselRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM carousel_projects WHERE id=? AND user_id=?`)
    .get(id, userId) as CarouselRow | undefined;
}

function slidesOf(carouselId: string): SlideRow[] {
  return getDb()
    .prepare(`SELECT * FROM carousel_slides WHERE carousel_id=? ORDER BY idx ASC`)
    .all(carouselId) as unknown as SlideRow[];
}

export function registerCarouselRoutes(app: FastifyInstance): void {
  app.get('/api/carousel/packs', async (req, reply) => {
    if (hiddenFrom(req, reply)) return;
    return {
      packs: listLocationPacks().map((p) => ({
        id: p.id,
        name: p.name,
        scenes: p.scenes.map((s) => ({ id: s.id, name: s.name })),
      })),
    };
  });

  app.get('/api/carousel/projects', async (req, reply) => {
    if (hiddenFrom(req, reply)) return;
    const rows = getDb()
      .prepare(`SELECT * FROM carousel_projects WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 50`)
      .all(req.user!.id) as unknown as CarouselRow[];
    return { carousels: rows.map((r) => toCarouselInfo(r, [])) };
  });

  app.post('/api/carousel/projects', async (req, reply) => {
    if (hiddenFrom(req, reply)) return;
    const body = (req.body ?? {}) as { modelId?: string; variantId?: string; slideCount?: number; title?: string };
    if (!body.modelId || !body.variantId) return bad(reply, 422, 'Выбери модель и вариант');
    const model = getOwnedModel(req.user!.id, body.modelId);
    if (!model) return bad(reply, 404, 'Модель не найдена');
    const variant = getDb()
      .prepare(`SELECT id FROM model_variants WHERE id=? AND model_id=?`)
      .get(body.variantId, body.modelId);
    if (!variant) return bad(reply, 404, 'Вариант модели не найден');
    const slideCount = Math.max(2, Math.min(config.carouselMaxSlides, Math.round(body.slideCount ?? 6)));
    const id = randomUUID();
    getDb()
      .prepare(
        `INSERT INTO carousel_projects (id, user_id, model_id, variant_id, title, slide_count)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, req.user!.id, body.modelId, body.variantId, (body.title ?? '').slice(0, 120), slideCount);
    const row = getOwnedCarousel(req.user!.id, id)!;
    return { carousel: toCarouselInfo(row, []) };
  });

  app.get('/api/carousel/projects/:id', async (req, reply) => {
    if (hiddenFrom(req, reply)) return;
    const { id } = req.params as { id: string };
    const row = getOwnedCarousel(req.user!.id, id);
    if (!row) return bad(reply, 404, 'Карусель не найдена');
    const info = toCarouselInfo(row, slidesOf(id));
    return {
      carousel: info,
      queuePosition: row.status === 'generating' ? carouselQueuePosition(id) : 0,
    };
  });

  app.delete('/api/carousel/projects/:id', async (req, reply) => {
    if (hiddenFrom(req, reply)) return;
    const { id } = req.params as { id: string };
    const row = getOwnedCarousel(req.user!.id, id);
    if (!row) return bad(reply, 404, 'Карусель не найдена');
    if (['generating', 'qc_review'].includes(row.status) || openHoldForProject(id)) {
      return bad(reply, 409, 'Карусель в работе или в окне ревью — сначала дождись завершения');
    }
    getDb().prepare(`DELETE FROM carousel_projects WHERE id=?`).run(id);
    deleteCarouselFiles(id);
    return { ok: true };
  });

  app.get('/api/carousel/projects/:id/quote', async (req, reply) => {
    if (hiddenFrom(req, reply)) return;
    const { id } = req.params as { id: string };
    const row = getOwnedCarousel(req.user!.id, id);
    if (!row) return bad(reply, 404, 'Карусель не найдена');
    const q = (req.query ?? {}) as { slides?: string };
    const slides = Math.max(2, Math.min(config.carouselMaxSlides, Number(q.slides) || row.slide_count));
    return { quote: carouselQuoteInfo(req.user!.id, slides) };
  });

  app.post('/api/carousel/projects/:id/generate', async (req, reply) => {
    if (hiddenFrom(req, reply)) return;
    const { id } = req.params as { id: string };
    const row = getOwnedCarousel(req.user!.id, id);
    if (!row) return bad(reply, 404, 'Карусель не найдена');
    if (!row.storyboard_json) return bad(reply, 409, 'Сначала собери раскадровку');
    if (!['draft', 'storyboard', 'failed'].includes(row.status)) {
      return bad(reply, 409, 'Карусель уже в работе или завершена');
    }
    const slideCount = (parseJson<{ slides: unknown[] }>(row.storyboard_json)?.slides ?? []).length;
    if (slideCount < 2) return bad(reply, 409, 'В раскадровке меньше двух слайдов');
    try {
      startGenerationHold(id, req.user!.id, slideCount);
    } catch (e) {
      if (e instanceof HoldConflictError) return bad(reply, 409, e.message);
      if (e instanceof InsufficientCreditsError) {
        return reply.code(402).send({
          error: e.message,
          needUsd: e.needCredits / 100,
          balanceUsd: Math.max(0, e.availableCredits) / 100,
          shortfallUsd: Math.ceil(e.needCredits - e.availableCredits) / 100,
        });
      }
      throw e;
    }
    getDb()
      .prepare(`UPDATE carousel_projects SET status='generating', error=NULL, updated_at=datetime('now') WHERE id=?`)
      .run(id);
    enqueueCarouselRun(id);
    return { ok: true, queuePosition: carouselQueuePosition(id) };
  });

  // ── Движки (SPEC §4): синхронные микро-холды, цена видна на кнопке ──

  /** Единый маппер ошибок идеационных вызовов. */
  async function ideationCall<T>(
    reply: FastifyReply,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof HoldConflictError) {
        void bad(reply, 409, e.message);
        return undefined;
      }
      if (e instanceof InsufficientCreditsError) {
        void reply.code(402).send({
          error: e.message,
          shortfallUsd: Math.ceil(e.needCredits - e.availableCredits) / 100,
        });
        return undefined;
      }
      void bad(reply, 502, e instanceof Error ? e.message : String(e));
      return undefined;
    }
  }

  /** Цены идеационных кнопок для UI («Идеи · ≈$0.03»). */
  app.get('/api/carousel/ideation-prices', async (req, reply) => {
    if (hiddenFrom(req, reply)) return;
    const price = (task: 'carousel_idea' | 'carousel_storyboard' | 'carousel_caption') => {
      const q = buildIdeationQuote(task);
      return q.totalUsd === null ? null : priceCredits(q.totalUsd) / 100;
    };
    return {
      ideasUsd: price('carousel_idea'),
      storyboardUsd: price('carousel_storyboard'),
      captionUsd: price('carousel_caption'),
    };
  });

  app.post('/api/carousel/projects/:id/ideas', async (req, reply) => {
    if (hiddenFrom(req, reply)) return;
    const { id } = req.params as { id: string };
    const row = getOwnedCarousel(req.user!.id, id);
    if (!row) return bad(reply, 404, 'Карусель не найдена');
    if (!['draft', 'storyboard'].includes(row.status)) {
      return bad(reply, 409, 'Идеи доступны до запуска генерации');
    }
    const body = (req.body ?? {}) as { wish?: string; patternCardIds?: string[] };
    // Few-shot из СВОИХ PatternCards: только structure_json — контент источника
    // в карточках не хранится по построению (SPEC §3, легальный гард).
    let patternHints: string[] = [];
    if (Array.isArray(body.patternCardIds) && body.patternCardIds.length > 0) {
      const ids = body.patternCardIds.slice(0, 5);
      const rows = getDb()
        .prepare(
          `SELECT pc.structure_json FROM pattern_cards pc JOIN collections c ON c.id=pc.collection_id
            WHERE c.user_id=? AND pc.id IN (${ids.map(() => '?').join(',')})`,
        )
        .all(req.user!.id, ...ids) as Array<{ structure_json: string }>;
      patternHints = rows.map((r) => r.structure_json);
    }
    const ideas = await ideationCall(reply, () =>
      withIdeationHold({ carouselId: id, userId: req.user!.id, task: 'carousel_idea' }, (opId) =>
        runIdeaEngine({ carouselId: id, userId: req.user!.id, opId, wish: body.wish, patternHints }),
      ),
    );
    if (!ideas) return;
    return ideas;
  });

  app.post('/api/carousel/projects/:id/idea', async (req, reply) => {
    if (hiddenFrom(req, reply)) return;
    const { id } = req.params as { id: string };
    const row = getOwnedCarousel(req.user!.id, id);
    if (!row) return bad(reply, 404, 'Карусель не найдена');
    if (!['draft', 'storyboard'].includes(row.status)) {
      return bad(reply, 409, 'Идею можно менять до запуска генерации');
    }
    const parsed = CarouselIdeaZ.safeParse(((req.body ?? {}) as { idea?: unknown }).idea);
    if (!parsed.success) return bad(reply, 422, 'Идея не прошла валидацию');
    for (const sceneId of parsed.data.sceneIds) {
      if (!getScene(row.location_pack, sceneId)) {
        return bad(reply, 422, `Сцена ${sceneId} не из пака ${row.location_pack}`);
      }
    }
    getDb()
      .prepare(
        `UPDATE carousel_projects SET idea_json=?, slide_count=?, updated_at=datetime('now') WHERE id=?`,
      )
      .run(JSON.stringify(parsed.data), parsed.data.slideCount, id);
    return { ok: true };
  });

  app.post('/api/carousel/projects/:id/storyboard', async (req, reply) => {
    if (hiddenFrom(req, reply)) return;
    const { id } = req.params as { id: string };
    const row = getOwnedCarousel(req.user!.id, id);
    if (!row) return bad(reply, 404, 'Карусель не найдена');
    if (!['draft', 'storyboard'].includes(row.status)) {
      return bad(reply, 409, 'Раскадровка доступна до запуска генерации');
    }
    if (!row.idea_json) return bad(reply, 409, 'Сначала выбери идею');
    const storyboard = await ideationCall(reply, () =>
      withIdeationHold({ carouselId: id, userId: req.user!.id, task: 'carousel_storyboard' }, (opId) =>
        runStoryboardEngine({ carouselId: id, userId: req.user!.id, opId }),
      ),
    );
    if (!storyboard) return;
    getDb()
      .prepare(
        `UPDATE carousel_projects SET storyboard_json=?, slide_count=?, status='storyboard', updated_at=datetime('now') WHERE id=?`,
      )
      .run(JSON.stringify(storyboard), storyboard.slides.length, id);
    return { storyboard };
  });

  app.patch('/api/carousel/projects/:id/storyboard', async (req, reply) => {
    if (hiddenFrom(req, reply)) return;
    const { id } = req.params as { id: string };
    const row = getOwnedCarousel(req.user!.id, id);
    if (!row) return bad(reply, 404, 'Карусель не найдена');
    if (!['draft', 'storyboard'].includes(row.status)) {
      return bad(reply, 409, 'Раскадровку можно править до запуска генерации');
    }
    const parsed = StoryboardZ.safeParse(((req.body ?? {}) as { storyboard?: unknown }).storyboard);
    if (!parsed.success) return bad(reply, 422, 'Раскадровка не прошла валидацию');
    if (parsed.data.slides.length > config.carouselMaxSlides) {
      return bad(reply, 422, `Максимум ${config.carouselMaxSlides} слайдов`);
    }
    for (const s of parsed.data.slides) {
      if (!getScene(row.location_pack, s.sceneId)) {
        return bad(reply, 422, `Сцена ${s.sceneId} не из пака ${row.location_pack}`);
      }
    }
    // Нормализуем idx строго в 1..N в порядке массива.
    const normalized = {
      ...parsed.data,
      slides: parsed.data.slides.map((s, i) => ({ ...s, idx: i + 1 })),
    };
    getDb()
      .prepare(
        `UPDATE carousel_projects SET storyboard_json=?, slide_count=?, status='storyboard', updated_at=datetime('now') WHERE id=?`,
      )
      .run(JSON.stringify(normalized), normalized.slides.length, id);
    return { storyboard: normalized };
  });

  app.post('/api/carousel/projects/:id/caption', async (req, reply) => {
    if (hiddenFrom(req, reply)) return;
    const { id } = req.params as { id: string };
    const row = getOwnedCarousel(req.user!.id, id);
    if (!row) return bad(reply, 404, 'Карусель не найдена');
    if (row.status === 'generating') return bad(reply, 409, 'Дождись окончания генерации');
    if (!row.idea_json) return bad(reply, 409, 'Сначала выбери идею');
    const language = ((req.body ?? {}) as { language?: 'en' | 'ru' }).language;
    const caption = await ideationCall(reply, () =>
      withIdeationHold({ carouselId: id, userId: req.user!.id, task: 'carousel_caption' }, (opId) =>
        runCaptionEngine({ carouselId: id, userId: req.user!.id, opId, language }),
      ),
    );
    if (!caption) return;
    getDb()
      .prepare(`UPDATE carousel_projects SET caption_json=?, updated_at=datetime('now') WHERE id=?`)
      .run(JSON.stringify(caption), id);
    return { caption };
  });

  // ── Ревью-окно (SPEC §5): accept/retry только пока hold открыта ──

  app.post('/api/carousel/projects/:id/slides/:slideId/accept', async (req, reply) => {
    if (hiddenFrom(req, reply)) return;
    const { id, slideId } = req.params as { id: string; slideId: string };
    const row = getOwnedCarousel(req.user!.id, id);
    if (!row) return bad(reply, 404, 'Карусель не найдена');
    if (row.status !== 'qc_review') return bad(reply, 409, 'Слайды принимаются только в окне ревью');
    if (!acceptSlide(id, slideId)) return bad(reply, 409, 'Слайд не в статусе needs_review');
    return { ok: true };
  });

  app.post('/api/carousel/projects/:id/slides/:slideId/retry', async (req, reply) => {
    if (hiddenFrom(req, reply)) return;
    const { id, slideId } = req.params as { id: string; slideId: string };
    const row = getOwnedCarousel(req.user!.id, id);
    if (!row) return bad(reply, 404, 'Карусель не найдена');
    if (row.status !== 'qc_review') return bad(reply, 409, 'Ретраи доступны только в окне ревью');
    const slide = getDb()
      .prepare(`SELECT status, manual_retries FROM carousel_slides WHERE id=? AND carousel_id=?`)
      .get(slideId, id) as { status: string; manual_retries: number } | undefined;
    if (!slide || slide.status !== 'needs_review') return bad(reply, 409, 'Слайд не в статусе needs_review');
    if (slide.manual_retries >= 2) {
      return bad(reply, 409, 'Лимит ручных ретраев исчерпан (2) — прими слайд или удали его из экспорта');
    }
    // Слайд обратно в pending; ран докатит его по чекпоинтам под ТОЙ ЖЕ hold (SPEC §5/§7).
    getDb()
      .prepare(
        `UPDATE carousel_slides SET status='pending', file=NULL, final_file=NULL,
                manual_retries=manual_retries+1, auto_retries=0, updated_at=datetime('now')
          WHERE id=?`,
      )
      .run(slideId);
    getDb()
      .prepare(`UPDATE carousel_projects SET status='generating', review_deadline=NULL, updated_at=datetime('now') WHERE id=?`)
      .run(id);
    enqueueCarouselRun(id);
    return { ok: true };
  });

  app.get('/api/carousel/:id/file/:file', async (req, reply) => {
    if (hiddenFrom(req, reply)) return;
    const { id, file } = req.params as { id: string; file: string };
    if (!getOwnedCarousel(req.user!.id, id)) return bad(reply, 404, 'Не найдено');
    const full = safeCarouselPath(id, file);
    if (!full) return bad(reply, 404, 'Файл не найден');
    reply.header('Cache-Control', 'private, max-age=86400');
    reply.type(MEDIA_CT[path.extname(full).toLowerCase()] ?? 'application/octet-stream');
    return reply.send(fs.createReadStream(full));
  });
}
