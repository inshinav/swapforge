// DTO между сервером и фронтом.
import type { Analysis } from './analysis';
import type { ArtifactType, RefRole } from './taxonomy';

export type ProjectStatus =
  | 'uploaded'
  | 'storyboarding'
  | 'storyboarded'
  | 'analyzing'
  | 'analyzed'
  | 'generating'
  | 'startframing'
  | 'complete'
  | 'error';

export type GenerationStatus =
  | 'queued'
  | 'uploading_assets'
  | 'submitted'
  | 'rendering'
  | 'downloading'
  | 'done'
  | 'failed';

export interface VideoMeta {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  aspect: string; // "9:16"
  sizeBytes: number;
}

export interface FrameInfo {
  file: string;
  t: number;
  kind: 'first' | 'scene' | 'grid';
}

export interface RefInfo {
  id: string;
  idx: number;
  role: RefRole;
  file: string;
  note: string;
  /** Кто назначил роль: эвристика по порядку, vision-классификатор, руками или пресет-пак. */
  roleSource?: 'heuristic' | 'auto' | 'manual' | 'preset';
  autoNote?: string;
}

export interface PromptRow {
  id: string;
  version: number;
  kind: 'image' | 'video';
  lang: string;
  text: string;
  params: SeedanceParams | null;
  createdAt: string;
}

export interface FeedbackRow {
  id: string;
  version: number;
  worked: boolean;
  artifacts: ArtifactType[];
  notes: string;
  createdAt: string;
}

export interface SeedanceParams {
  endpoint: string;
  video: string;
  reference_images: { index: number; whatItIs: string; file: string }[];
  aspect_ratio: string;
  resolution: string;
  enable_web_search: boolean;
  durationNote: string;
}

export interface FlowFlagsDto {
  removeText: boolean;
  enhanceFigure: boolean;
  /** Пожелания к ролику ('' = базовый режим; менее стабильно). */
  wish: string;
  /** Звук результата: true = нативная генерация, false = дорожка исходника. */
  generateAudio: boolean;
}

export interface GenerationRow {
  id: string;
  version: number;
  status: GenerationStatus;
  /** Имя файла в media/renders (null — ещё нет или счищен ротацией). */
  file: string | null;
  bytes: number;
  renderPurged: boolean;
  error: string | null;
  params: Record<string, unknown> | null;
  costEst: { wavespeedUsd: number | null; billedSeconds: number } | null;
  costActualUsd: number | null;
  costSource: 'api' | 'balance_delta' | 'formula' | null;
  rating: number | null; // 1 | -1 | null
  artifacts: ArtifactType[];
  notes: string;
  retryOf: string | null;
  wsPredictionId: string | null;
  createdAt: string;
  submittedAt: string | null;
  finishedAt: string | null;
  /** Фактические длительности, сек: загрузка ассетов (created→submitted) и рендер+скачивание. */
  uploadSec: number | null;
  renderSec: number | null;
  /** Позиция в FIFO-очереди (1 = следующий); только для status='queued'. */
  queuePosition?: number | null;
  /** Для длинного ролика: сколько частей подготовлено из общего числа. */
  segmentCount?: number;
  segmentDone?: number;
}

export interface PresetInfo {
  id: string;
  title: string;
  hint: string;
  refs: Array<{ role: RefRole; note: string }>;
  /** Относительный URL превью (первый реф-лист пресета). */
  thumb: string;
}

// ── v4: модели пользователей (конструктор) ──────────────────────────────────

export interface ModelRefInfo {
  id: string;
  /** null = общий реф модели (техника/объект) — едет с каждым вариантом. */
  variantId: string | null;
  file: string;
  role: RefRole;
  note: string;
  idx: number;
}

export interface ModelVariantInfo {
  id: string;
  title: string;
  hint: string;
  idx: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  createdAt: string;
  variants: ModelVariantInfo[];
  refs: ModelRefInfo[];
}

export interface ProjectCosts {
  /** Всего по проекту: LLM (usage_events) + фактические списания рендеров. Не-владельцу всегда 0. */
  projectUsd: number;
  /** Бегущий счётчик активного one-click прогона (null для не-владельца — у него кредиты). */
  activeRun: {
    openaiUsd: number;
    wavespeedEstUsd: number | null;
    wavespeedActualUsd: number | null;
  } | null;
  /** Для не-владельца: открытый кредитный резерв проекта (null = нет). */
  heldCredits?: number | null;
}

export interface ProjectSummary {
  id: string;
  title: string;
  status: ProjectStatus;
  error: string | null;
  createdAt: string;
  thumb: string | null;
  tags: string[];
  worked: boolean | null; // null = нет фидбека
  videoPurged: boolean;
  promptVersions: number;
  latestRender: { generationId: string; file: string; rating: number | null } | null;
}

export interface ProjectFull extends ProjectSummary {
  videoFile: string | null;
  meta: VideoMeta | null;
  frames: FrameInfo[];
  refs: RefInfo[];
  analysis: Analysis | null;
  prompts: PromptRow[];
  feedback: FeedbackRow[];
  startFrames: Array<{ file: string; version: number }>;
  flow: 'manual' | 'auto';
  flags: FlowFlagsDto | null;
  generations: GenerationRow[];
  costs: ProjectCosts;
  /** Фактические длительности локальных стадий, сек: {storyboard, analyze, generate, startframe}. */
  stageTimes: Record<string, number> | null;
}

// ── v2: смета, тарифы, расход ────────────────────────────────────────────────

export interface EstimateTaskRow {
  task: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  usd: number | null;
  /** history = скользящее среднее реальных прогонов; seed = стартовая эмпирика. */
  basis: 'history' | 'seed';
}

export interface EstimateInfo {
  /** Стадии, которые осталось прогнать (смета честная и для повторных запусков). */
  stages: string[];
  openai: { perTask: EstimateTaskRow[]; usd: number | null; priceDate: string | null };
  wavespeed: {
    usd: number | null;
    billedSeconds: number;
    perSecondUsd: number | null;
    resolution: string;
    priceDate: string | null;
    unavailableReason: string | null;
  };
  totalUsd: number | null;
  approximate: boolean;
  balanceUsd: number | null;
  warnings: string[];
}

/** Смета для НЕ-владельца: только кредиты, USD в payload не существует. */
export interface EstimateForUser {
  kind: 'credits';
  stages: string[];
  /** Смета в кредитах (null = живые тарифы недоступны — запуск не дадим). */
  credits: number | null;
  /** Доступно юзеру (баланс минус открытые резервы). */
  balanceCredits: number;
  approximate: boolean;
  warnings: string[];
}

export interface CreditBalanceInfo {
  balance: number;
  held: number;
  available: number;
}

export interface CreditLedgerEntry {
  id: string;
  delta: number;
  kind: 'purchase' | 'charge' | 'refund' | 'adjust';
  note: string;
  createdAt: string;
}

export type BillingProviderId = 'cryptopay' | 'lavatop';

export interface CreditPackInfo {
  id: string;
  title: string;
  credits: number;
  priceLabel: string;
  /** Какими провайдерами этот пакет оплачивается (есть offer/цена). */
  pay: BillingProviderId[];
}

export interface BillingPacksInfo {
  providers: Array<{ id: BillingProviderId; needsEmail: boolean }>;
  packs: CreditPackInfo[];
}

export interface PricingInfo {
  balanceUsd: number | null;
  litellmFetchedAt: string | null;
  wavespeedFetchedAt: string | null;
}

export interface UsageSummary {
  month: string;
  openaiUsd: number;
  wavespeedUsd: number;
  totalUsd: number;
  runs: number;
}

/**
 * Публичная часть health минимальна; операторские поля приходят ТОЛЬКО владельцу
 * (модель/диск/ключи — внутренняя кухня, не для тенантов).
 */
export interface HealthInfo {
  ok: boolean;
  version: string;
  /** username auth-бота для Login Widget (null = не сконфигурирован). */
  tgBot: string | null;
  /** Дев-режим входа без Telegram (никогда не true в prod). */
  devAuth: boolean;
  provider?: string;
  model?: string;
  keyPresent?: boolean;
  ffmpeg?: boolean;
  dataBytes?: number;
  storageCapBytes?: number;
  diskUsedPct?: number;
}

// ── v4: auth ────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  telegramId: number;
  username: string;
  firstName: string;
  photoUrl: string;
  role: 'user' | 'owner';
}

export interface MeInfo {
  user: AuthUser;
  counts: { projects: number };
}

/** Payload Telegram Login Widget (data-onauth) — уходит на POST /api/auth/telegram как есть. */
export interface TgWidgetPayload {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}
