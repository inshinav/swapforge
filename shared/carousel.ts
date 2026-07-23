// Carousel Studio: статусы, DTO и схемы движков (docs/carousel-studio/SPEC.md §3–§5, §7).
// Dual-паттерн как в shared/analysis.ts: zod — рантайм-валидация ответа LLM,
// ручная strict JSON Schema (все поля required, additionalProperties:false) — structured output.

import { z } from 'zod';

// ── Статусы (строго = CHECK-констрейнты в server/src/db.ts) ──────────────────

export const CAROUSEL_STATUSES = [
  'draft',
  'storyboard',
  'generating',
  'qc_review',
  'done',
  'failed',
] as const;
export type CarouselStatus = (typeof CAROUSEL_STATUSES)[number];

export const SLIDE_STATUSES = [
  'pending',
  'generating',
  'qc',
  'done',
  'needs_review',
  'moderated',
  'failed',
] as const;
export type SlideStatus = (typeof SLIDE_STATUSES)[number];

export const MINING_STATUSES = ['queued', 'running', 'filtering', 'vision', 'done', 'failed'] as const;
export type MiningStatus = (typeof MINING_STATUSES)[number];

// ── Таблица имён задач (SPEC §7: SEED_TOKENS-ключ == schemaName == recordUsage.task) ──

export const CAROUSEL_TASKS = {
  slide: 'carousel_slide',
  qc: 'carousel_qc',
  idea: 'carousel_idea',
  storyboard: 'carousel_storyboard',
  caption: 'carousel_caption',
} as const;
export type CarouselTask = (typeof CAROUSEL_TASKS)[keyof typeof CAROUSEL_TASKS];

// ── Доменные enum'ы ──────────────────────────────────────────────────────────

export const UgcPresetZ = z.enum(['raw', 'casual', 'polished']);
export type UgcPreset = z.infer<typeof UgcPresetZ>;

export const SlideRoleZ = z.enum(['hook', 'context', 'payoff', 'cta']);
export type SlideRole = z.infer<typeof SlideRoleZ>;

// ── Idea Engine ──────────────────────────────────────────────────────────────

export const CarouselIdeaZ = z.object({
  /** Заголовок идеи для UI (RU). */
  title: z.string(),
  /** Хук первого слайда (RU). */
  hook: z.string(),
  /** Концепция карусели в 2–3 предложениях (RU). */
  concept: z.string(),
  slideCount: z.number().int().min(2).max(10),
  /** id сцен LocationPack в порядке слайдов (может повторяться). */
  sceneIds: z.array(z.string()).min(1),
  ugcPreset: UgcPresetZ,
});
export type CarouselIdea = z.infer<typeof CarouselIdeaZ>;

export const CarouselIdeasZ = z.object({ ideas: z.array(CarouselIdeaZ).min(3).max(5) });
export type CarouselIdeas = z.infer<typeof CarouselIdeasZ>;

// ── Storyboard Engine ────────────────────────────────────────────────────────

export const StoryboardSlideZ = z.object({
  idx: z.number().int().min(1),
  role: SlideRoleZ,
  /** id сцены LocationPack. */
  sceneId: z.string(),
  /** Действие/поза (EN — уходит в промт слайда). */
  action: z.string(),
  /** Заметка об одежде для консистентности (EN). */
  outfit: z.string(),
  /** Камера/кадрирование (EN). */
  camera: z.string(),
  /** Нужен ли product/outfit-референс пользователя на этом слайде. */
  useProductRef: z.boolean(),
});
export type StoryboardSlide = z.infer<typeof StoryboardSlideZ>;

export const StoryboardZ = z.object({
  slides: z.array(StoryboardSlideZ).min(2).max(10),
  /** Что якорь (слайд 1) обязан зафиксировать для 2..N (EN). */
  anchorNote: z.string(),
});
export type Storyboard = z.infer<typeof StoryboardZ>;

// ── Caption Engine ───────────────────────────────────────────────────────────

export const CaptionZ = z.object({
  caption: z.string(),
  hashtags: z.array(z.string()).min(10).max(15),
  /** Первая строка-хук (то, что видно до «ещё»). */
  hookLine: z.string(),
});
export type Caption = z.infer<typeof CaptionZ>;

// ── QC ───────────────────────────────────────────────────────────────────────

export const QcVerdictZ = z.object({
  identity: z.number().min(0).max(10),
  artifacts: z.number().min(0).max(10),
  realism: z.number().min(0).max(10),
  sceneMatch: z.boolean(),
  notes: z.string(),
});
export type QcVerdict = z.infer<typeof QcVerdictZ>;

// ── Reference Miner: PatternCard (структура, НИКОГДА не контент источника) ──

export const PatternCardStructureZ = z.object({
  /** Тип хука первого слайда (напр. "bold text question", "mid-action candid"). */
  hookType: z.string(),
  slideCount: z.number().int().min(1).max(20),
  /** Роль каждого слайда по порядку. */
  slideRoles: z.array(z.string()),
  /** Композиционные приёмы (обобщённо, без уникальных деталей кадра). */
  composition: z.array(z.string()),
  /** Структура подписи (напр. "hook → story → CTA"), НЕ текст подписи. */
  captionStyle: z.string(),
  /** Гипотеза, почему пост залетел. */
  whyItWorks: z.string(),
  nicheTags: z.array(z.string()),
});
export type PatternCardStructure = z.infer<typeof PatternCardStructureZ>;

// ── DTO для API (стиль shared/api-types.ts) ──────────────────────────────────

export interface SlideInfo {
  id: string;
  idx: number;
  status: SlideStatus;
  isAnchor: boolean;
  /** Есть ли готовый файл (URL строится клиентом через api.carouselFileUrl). */
  file: string | null;
  finalFile: string | null;
  qc: QcVerdict | null;
  autoRetries: number;
  manualRetries: number;
  accepted: boolean;
  error: string | null;
}

export interface CarouselQuoteInfo {
  priceUsd: number;
  balanceUsd: number;
  enough: boolean;
  /** Не хватает на балансе (для shortfall→пополнение); 0 если хватает. */
  shortfallUsd: number;
  approximate: boolean;
}

export interface CarouselInfo {
  id: string;
  title: string;
  status: CarouselStatus;
  modelId: string | null;
  variantId: string | null;
  locationPack: string;
  slideCount: number;
  idea: CarouselIdea | null;
  storyboard: Storyboard | null;
  caption: Caption | null;
  slides: SlideInfo[];
  /** Дедлайн ревью-окна (ISO) в статусе qc_review, иначе null. */
  reviewDeadline: string | null;
  error: string | null;
  createdAt: string;
}

export interface PatternCardInfo {
  id: string;
  sourceUrl: string;
  platform: string;
  author: string;
  virality: { likes: number; comments: number; followers: number; er: number };
  structure: PatternCardStructure;
  /** Имя файла миниатюры (атрибуция в подборке; в генерацию не подаётся). */
  thumbFile: string | null;
  liked: boolean;
  archived: boolean;
}

export interface CollectionInfo {
  id: string;
  name: string;
  status: string;
  cardCount: number;
  createdAt: string;
}

export interface MiningRunInfo {
  id: string;
  collectionId: string;
  status: MiningStatus;
  stats: { fetched: number; passedFilter: number; cards: number } | null;
  error: string | null;
  createdAt: string;
}

// ── JSON Schemas (strict) ────────────────────────────────────────────────────

const str = { type: 'string' } as const;
const int = { type: 'integer' } as const;
const bool = { type: 'boolean' } as const;
const en = (...values: string[]) => ({ type: 'string', enum: values }) as const;
const arr = (items: unknown, extra: Record<string, unknown> = {}) =>
  ({ type: 'array', items, ...extra }) as const;
const obj = (properties: Record<string, unknown>) =>
  ({
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  }) as const;

const IDEA_SCHEMA = obj({
  title: str,
  hook: str,
  concept: str,
  slideCount: { type: 'integer', minimum: 2, maximum: 10 },
  sceneIds: arr(str, { minItems: 1 }),
  ugcPreset: en('raw', 'casual', 'polished'),
});

export const IDEAS_JSON_SCHEMA = obj({
  ideas: arr(IDEA_SCHEMA, { minItems: 3, maxItems: 5 }),
});

export const STORYBOARD_JSON_SCHEMA = obj({
  slides: arr(
    obj({
      idx: int,
      role: en('hook', 'context', 'payoff', 'cta'),
      sceneId: str,
      action: str,
      outfit: str,
      camera: str,
      useProductRef: bool,
    }),
    { minItems: 2, maxItems: 10 },
  ),
  anchorNote: str,
});

export const CAPTION_JSON_SCHEMA = obj({
  caption: str,
  hashtags: arr(str, { minItems: 10, maxItems: 15 }),
  hookLine: str,
});

export const QC_JSON_SCHEMA = obj({
  identity: { type: 'number', minimum: 0, maximum: 10 },
  artifacts: { type: 'number', minimum: 0, maximum: 10 },
  realism: { type: 'number', minimum: 0, maximum: 10 },
  sceneMatch: bool,
  notes: str,
});

export const PATTERN_CARD_JSON_SCHEMA = obj({
  hookType: str,
  slideCount: { type: 'integer', minimum: 1, maximum: 20 },
  slideRoles: arr(str),
  composition: arr(str),
  captionStyle: str,
  whyItWorks: str,
  nicheTags: arr(str),
});
