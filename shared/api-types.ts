// DTO между сервером и фронтом.
import type { Analysis } from './analysis';
import type { ArtifactType, RefRole } from './taxonomy';

/** Seedance принимает 9 изображений; слот 1 всегда занимает continuity/start frame. */
export const MAX_PROJECT_REFS = 8;

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
  /** Отпечаток порядка/ролей/заметок референсов, чтобы их правка пересобирала промты. */
  refFingerprint?: string;
}

export interface FlowFlagsDto {
  removeText: boolean;
  enhanceFigure: boolean;
  /** Пожелания к ролику ('' = базовый режим; менее стабильно). */
  wish: string;
  /** Звук результата: true = нативная генерация, false = дорожка исходника. */
  generateAudio: boolean;
}

// ── Reality Finish: адаптивный camera/UGC-финиш готового рендера ────────────

export type FinishMode = 'natural' | 'phone' | 'camera';

/**
 * Нормализованные (0..1) замеры готового рендера — база адаптации фильтров.
 * Все значения — доли/пропорции, а не абсолютные величины кодека.
 */
export interface FinishStats {
  /** Средняя яркость кадра (YAVG/255). */
  brightness: number;
  /** Разброс 10–90 перцентилей яркости — прокси контраста. */
  contrast: number;
  /** Средняя насыщенность хромы. */
  saturation: number;
  /** Энергия границ (Собель) — прокси резкости. */
  sharpness: number;
  /** Высокочастотная текстура/шум (residual после лёгкого блюра). */
  noise: number;
  /** Доля пикселей у верхней границы диапазона (пережжённые света). */
  clippedHighlights: number;
  /** Доля пикселей у нижней границы (проваленные тени). */
  crushedShadows: number;
  /** Доля пикселей в диапазоне тонов кожи (YCbCr-маска). */
  skin: number;
  /** Сколько кадров легло в замер. */
  sampledFrames: number;
}

export type FinishStatus = 'processing' | 'done' | 'failed';

export interface GenerationFinishInfo {
  status: FinishStatus;
  mode: FinishMode;
  /** 0.1–1.0 (шаг 0.1) — множитель всех дельт обработки. */
  intensity: number;
  /** Имя обработанного файла в renders (только при status='done'). */
  file: string | null;
  error: string | null;
  finishedAt: string | null;
}

export interface FinishPreviewInfo {
  mode: FinishMode;
  intensity: number;
  /** Имена файлов в медиа-каталоге 'finish' (api.mediaUrl(projectId, 'finish', file)). */
  before: string;
  after: string;
  stats: FinishStats;
  /** Какие адаптации применены под замер этого ролика (RU, для UI). */
  notes: string[];
  fragmentStartSec: number;
  fragmentDurationSec: number;
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
  /** Reality Finish: состояние адаптивной пост-обработки (null — не запускалась). */
  finish: GenerationFinishInfo | null;
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
  /** Бегущий счётчик активного one-click прогона (операторская себестоимость; скрыта от пользователя). */
  activeRun: {
    openaiUsd: number;
    wavespeedEstUsd: number | null;
    wavespeedActualUsd: number | null;
  } | null;
  /** Для не-владельца: открытый резерв проекта в долларах (null = нет). */
  heldUsd?: number | null;
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

/** Пользовательская смета: итоговая цена уже включает сервисную маржу. */
export interface EstimateForUser {
  kind: 'balance';
  /** Durable server quote. Null only while a reliable price is unavailable. */
  quoteId: string | null;
  action: FlowAction;
  expiresAt: string | null;
  refFingerprint: string;
  stages: string[];
  /** Цена запуска в USD (null = живые тарифы недоступны — запуск не дадим). */
  priceUsd: number | null;
  /** Доступный баланс в USD (общий баланс минус открытые резервы). */
  balanceUsd: number;
  approximate: boolean;
  warnings: string[];
}

export type FlowAction = 'first' | 'rerun' | 'retry' | 'iterate' | 'classify' | 'describe';

export interface DollarBalanceInfo {
  balanceUsd: number;
  heldUsd: number;
  availableUsd: number;
}

export interface DollarLedgerEntry {
  id: string;
  deltaUsd: number;
  kind: 'purchase' | 'charge' | 'refund' | 'adjust';
  note: string;
  createdAt: string;
}

export type BillingProviderId = 'cryptopay' | 'lavatop';

export type PaymentIntentStatus =
  | 'creating'
  | 'pending'
  | 'paid'
  | 'credited'
  | 'expired'
  | 'cancelled'
  | 'failed'
  | 'quarantined';

export interface PaymentIntentInfo {
  id: string;
  provider: BillingProviderId;
  amountUsd: number;
  status: PaymentIntentStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  creditedAt: string | null;
}

export interface BillingMethodsInfo {
  minTopupUsd: number;
  maxTopupUsd: number;
  providers: Array<{ id: BillingProviderId; needsEmail: boolean; rubPerUsd?: number }>;
}

export interface OwnerBillingUser {
  id: string;
  telegramId: number;
  username: string;
  firstName: string;
  balance: DollarBalanceInfo;
}

export interface OwnerManualTopupResult {
  ok: true;
  replayed: boolean;
  user: OwnerBillingUser;
}

export interface AdminUserOverview extends OwnerBillingUser {
  photoUrl: string;
  status: 'active' | 'blocked';
  createdAt: string;
  lastLoginAt: string | null;
  lastActivityAt: string;
  projects: number;
  models: number;
  renders: number;
  doneRenders: number;
  failedRenders: number;
  activeRenders: number;
  latestProjectTitle: string | null;
  latestProjectStatus: string | null;
  latestGenerationStatus: string | null;
}

export interface AdminOverview {
  generatedAt: string;
  summary: {
    users: number;
    totalBalanceUsd: number;
    heldUsd: number;
    activeRenders: number;
    completedRenders: number;
  };
  operations: {
    pendingPayments: number;
    quarantinedPayments: number;
    staleJobs: number;
    stuckRenders: number;
    staleHolds: number;
    failedJobs24h: number;
    diskUsedPct: number;
    alerts: string[];
  };
  users: AdminUserOverview[];
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
  releaseSha?: string | null;
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
  /** Тест-клиент владельца: настоящий metered-юзер для проверки пути клиента. */
  sandbox: boolean;
}

// ── Проверка оплаты владельцем ──────────────────────────────────────────────

export interface BillingProviderHealth {
  id: BillingProviderId;
  needsEmail: boolean;
  /** Только у cryptopay: тестовая сеть (клиентам способ скрыт). */
  testnet?: boolean;
  /** Виден ли способ обычным пользователям прямо сейчас. */
  availableToUsers: boolean;
  check: { ok: boolean; detail: string };
}

export interface BillingHealthInfo {
  generatedAt: string;
  providers: BillingProviderHealth[];
  /** Счётчики payment_intents по статусам. */
  intents: Record<string, number>;
  events: Array<{
    provider: string;
    source: string;
    verified: boolean;
    outcome: string;
    reason: string | null;
    createdAt: string;
  }>;
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
