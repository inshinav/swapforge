import type {
  AuthUser,
  BillingHealthInfo,
  BillingMethodsInfo,
  BillingProviderId,
  DollarBalanceInfo,
  DollarLedgerEntry,
  EstimateForUser,
  EstimateInfo,
  FinishMode,
  FinishPreviewInfo,
  HealthInfo,
  AdminOverview,
  MeInfo,
  ModelInfo,
  OwnerBillingUser,
  OwnerManualTopupResult,
  PaymentIntentInfo,
  PresetInfo,
  PricingInfo,
  ProjectFull,
  ProjectSummary,
  TgWidgetPayload,
  UsageSummary,
} from '@shared/api-types';
import type {
  Caption,
  CarouselIdea,
  CarouselIdeas,
  CarouselInfo,
  CarouselQuoteInfo,
  CollectionInfo,
  MiningRunInfo,
  PatternCardInfo,
  Storyboard,
} from '@shared/carousel';

// База приложения ('/swapforge/'): API и медиа всегда под ней — nginx срезает префикс.
// URL строим АБСОЛЮТНЫМ от location.origin: если страница открыта ссылкой вида
// https://user:pass@host/…, относительный fetch унаследовал бы креды и упал бы
// («Request cannot be constructed from a URL that includes credentials»).
export const appBase = import.meta.env.BASE_URL;
const u = (p: string) => `${window.location.origin}${appBase}${p}`;

/** Ошибка API со статусом: 401 = «не залогинен», UI разводит по-разному. */
export class ApiError extends Error {
  status: number;
  /** Разобранное JSON-тело ошибки (аддитивно; напр. shortfallUsd у 402 карусели). */
  body?: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    let parsed: unknown;
    try {
      const body = (await r.json()) as { error?: string };
      parsed = body;
      if (body.error) msg = body.error;
    } catch {
      /* не-JSON ответ */
    }
    throw new ApiError(r.status, msg, parsed);
  }
  return r.json() as Promise<T>;
}

/** Double-submit CSRF: значение из JS-читаемой cookie уходит заголовком на каждой мутации. */
export function csrfToken(): string {
  const m = /(?:^|;\s*)sf_csrf=([^;]*)/.exec(document.cookie);
  return m ? decodeURIComponent(m[1]!) : '';
}

export const csrfHeader = (): Record<string, string> => ({ 'x-sf-csrf': csrfToken() });

const post = (url: string, body?: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: { ...csrfHeader(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

export const api = {
  // ── auth ─────────────────────────────────────────────────────────────────
  me: () => fetch(u('api/me')).then((r) => j<MeInfo>(r)),
  authTelegram: (payload: TgWidgetPayload) =>
    post(u('api/auth/telegram'), payload).then((r) => j<{ user: AuthUser }>(r)),
  devLogin: (telegramId: number, name?: string) =>
    post(u('api/auth/dev-login'), { telegramId, name }).then((r) => j<{ user: AuthUser }>(r)),
  logout: () => post(u('api/auth/logout')).then((r) => j<{ ok: true }>(r)),
  // Тест-клиент владельца: переключение в настоящего metered-юзера и обратно
  testClient: () => post(u('api/auth/test-client')).then((r) => j<{ user: AuthUser }>(r)),
  testClientExit: () => post(u('api/auth/test-client/exit')).then((r) => j<{ user: AuthUser }>(r)),

  health: () => fetch(u('api/health')).then((r) => j<HealthInfo>(r)),
  projects: () => fetch(u('api/projects')).then((r) => j<ProjectSummary[]>(r)),
  project: (id: string) => fetch(u(`api/projects/${id}`)).then((r) => j<ProjectFull>(r)),
  deleteProject: (id: string) =>
    fetch(u(`api/projects/${id}`), { method: 'DELETE', headers: csrfHeader() }).then((r) =>
      j<{ ok: true }>(r),
    ),

  uploadUrl: () => u('api/projects'),

  addRef: (projectId: string, file: File, role: string, note: string) => {
    const fd = new FormData();
    fd.append('role', role);
    fd.append('note', note);
    fd.append('photo', file);
    return fetch(u(`api/projects/${projectId}/refs`), {
      method: 'POST',
      headers: csrfHeader(),
      body: fd,
    }).then((r) => j<{ id: string }>(r));
  },
  applyVariant: (projectId: string, variantId: string) =>
    post(u(`api/projects/${projectId}/variant`), { variantId }).then((r) => j<{ ok: true }>(r)),
  patchRefs: (
    projectId: string,
    body: { order?: string[]; updates?: Array<{ id: string; role?: string; note?: string }> },
  ) =>
    fetch(u(`api/projects/${projectId}/refs`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...csrfHeader() },
      body: JSON.stringify(body),
    }).then((r) => j<{ ok: true }>(r)),
  deleteRef: (projectId: string, refId: string) =>
    fetch(u(`api/projects/${projectId}/refs/${refId}`), {
      method: 'DELETE',
      headers: csrfHeader(),
    }).then((r) => j<{ ok: true }>(r)),

  storyboardRetry: (id: string) =>
    post(u(`api/projects/${id}/storyboard`)).then((r) => j<{ ok: true }>(r)),
  analyze: (id: string) => post(u(`api/projects/${id}/analyze`)).then((r) => j<{ ok: true }>(r)),
  generate: (id: string, body: { lang: string }) =>
    post(u(`api/projects/${id}/generate`), body).then((r) => j<{ ok: true }>(r)),
  feedback: (
    id: string,
    body: { version: number; worked: boolean; artifacts: string[]; notes: string },
  ) => post(u(`api/projects/${id}/feedback`), body).then((r) => j<{ ok: true }>(r)),
  iterate: (
    id: string,
    body: { version: number; artifacts: string[]; notes: string; lang: string; quoteId?: string },
  ) => post(u(`api/projects/${id}/iterate`), body).then((r) => j<{ ok: true }>(r)),
  startFrame: (id: string, body: { version: number }) =>
    post(u(`api/projects/${id}/startframe`), body).then((r) =>
      j<{ file: string; version: number }>(r),
    ),

  // ── v2: one-click, рендеры, цены ─────────────────────────────────────────
  swap: (
    id: string,
    body: {
      flags: { removeText: boolean; enhanceFigure: boolean };
      wish?: string;
      generateAudio?: boolean;
      confirmUnknownCost?: boolean;
      confirmReferenceRisks?: boolean;
      variantId?: string;
      preset?: string;
      quoteId?: string;
    },
  ) => post(u(`api/projects/${id}/swap`), body).then((r) => j<{ ok: true }>(r)),
  presets: () => fetch(u('api/presets')).then((r) => j<PresetInfo[]>(r)),
  presetThumbUrl: (thumb: string) => u(thumb),

  // ── v4: модели пользователя (конструктор) ────────────────────────────────
  models: () => fetch(u('api/models')).then((r) => j<ModelInfo[]>(r)),
  createModel: (name: string) => post(u('api/models'), { name }).then((r) => j<{ id: string }>(r)),
  renameModel: (id: string, name: string) =>
    fetch(u(`api/models/${id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...csrfHeader() },
      body: JSON.stringify({ name }),
    }).then((r) => j<{ ok: true }>(r)),
  deleteModel: (id: string) =>
    fetch(u(`api/models/${id}`), { method: 'DELETE', headers: csrfHeader() }).then((r) =>
      j<{ ok: true }>(r),
    ),
  addModelVariant: (modelId: string, title: string, hint?: string) =>
    post(u(`api/models/${modelId}/variants`), { title, hint }).then((r) => j<{ id: string }>(r)),
  patchModelVariant: (modelId: string, vid: string, body: { title?: string; hint?: string }) =>
    fetch(u(`api/models/${modelId}/variants/${vid}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...csrfHeader() },
      body: JSON.stringify(body),
    }).then((r) => j<{ ok: true }>(r)),
  deleteModelVariant: (modelId: string, vid: string) =>
    fetch(u(`api/models/${modelId}/variants/${vid}`), {
      method: 'DELETE',
      headers: csrfHeader(),
    }).then((r) => j<{ ok: true }>(r)),
  addModelRef: (modelId: string, file: File, role: string, variantId: string | null, note = '') => {
    const fd = new FormData();
    fd.append('role', role);
    if (variantId) fd.append('variantId', variantId);
    fd.append('note', note);
    fd.append('photo', file);
    return fetch(u(`api/models/${modelId}/refs`), {
      method: 'POST',
      headers: csrfHeader(),
      body: fd,
    }).then((r) => j<{ id: string; file: string; warnings: string[] }>(r));
  },
  patchModelRef: (
    modelId: string,
    refId: string,
    body: { role?: string; note?: string; variantId?: string | null },
  ) =>
    fetch(u(`api/models/${modelId}/refs/${refId}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...csrfHeader() },
      body: JSON.stringify(body),
    }).then((r) => j<{ ok: true }>(r)),
  deleteModelRef: (modelId: string, refId: string) =>
    fetch(u(`api/models/${modelId}/refs/${refId}`), {
      method: 'DELETE',
      headers: csrfHeader(),
    }).then((r) => j<{ ok: true }>(r)),
  describeModelRef: (modelId: string, refId: string) =>
    post(u(`api/models/${modelId}/refs/${refId}/describe`)).then((r) => j<{ note: string }>(r)),
  modelFileUrl: (modelId: string, file: string) =>
    u(`api/models/${modelId}/file/${encodeURIComponent(file)}`),
  estimate: (
    id: string,
    flags?: { removeText: boolean; enhanceFigure: boolean; wish: string },
    previewAsUser = false,
  ) => {
    const query = new URLSearchParams();
    if (flags) {
      query.set('removeText', flags.removeText ? '1' : '0');
      query.set('enhanceFigure', flags.enhanceFigure ? '1' : '0');
      query.set('wish', flags.wish);
    }
    if (previewAsUser) query.set('preview', 'user');
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return fetch(u(`api/projects/${id}/estimate${suffix}`)).then((r) =>
      j<EstimateInfo | EstimateForUser>(r),
    );
  },
  actionQuote: (
    id: string,
    body: { action: 'rerun' | 'retry' | 'iterate'; version: number; sourceGenerationId?: string },
  ) => post(u(`api/projects/${id}/action-quotes`), body).then((r) => j<EstimateForUser>(r)),

  // ── пользовательский баланс в USD ────────────────────────────────────────
  billingBalance: () => fetch(u('api/billing/balance')).then((r) => j<DollarBalanceInfo>(r)),
  billingLedger: () =>
    fetch(u('api/billing/ledger')).then((r) => j<{ entries: DollarLedgerEntry[] }>(r)),
  billingMethods: (previewAsUser = false) =>
    fetch(u(`api/billing/packs${previewAsUser ? '?preview=user' : ''}`)).then((r) => j<BillingMethodsInfo>(r)),
  billingPaymentIntents: () =>
    fetch(u('api/billing/payment-intents')).then((r) => j<{ intents: PaymentIntentInfo[] }>(r)),
  checkout: (amountUsd: number, provider: BillingProviderId, email?: string) =>
    post(u('api/billing/checkout'), { amountUsd, provider, email }).then((r) => j<{ payUrl: string }>(r)),
  ownerBillingUser: (username: string) =>
    fetch(u(`api/billing/manual-user?username=${encodeURIComponent(username)}`)).then((r) =>
      j<{ user: OwnerBillingUser }>(r),
    ),
  ownerManualTopup: (body: { userId: string; amountUsd: number; note: string; requestId: string }) =>
    post(u('api/billing/manual-topup'), body).then((r) => j<OwnerManualTopupResult>(r)),
  adminOverview: () => fetch(u('api/admin/overview')).then((r) => j<AdminOverview>(r)),
  billingHealth: () => fetch(u('api/admin/billing/health')).then((r) => j<BillingHealthInfo>(r)),
  adminPaymentIntents: (status: 'creating' | 'pending' | 'paid' | 'quarantined') =>
    fetch(u(`api/admin/payment-intents?status=${status}`)).then((r) =>
      j<{
        intents: Array<{
          id: string;
          user_id: string;
          provider: BillingProviderId;
          credits_cents: number;
          status: string;
          last_error: string | null;
          created_at: string;
        }>;
      }>(r),
    ),
  adminReconcilePayment: (id: string) =>
    post(u(`api/admin/payment-intents/${id}/reconcile`)).then((r) => j<{ intent: unknown }>(r)),
  swapAudioPref: (id: string, generateAudio: boolean) =>
    fetch(u(`api/projects/${id}/flags`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...csrfHeader() },
      body: JSON.stringify({ generateAudio }),
    }).then((r) => j<{ ok: true }>(r)),
  renderVersion: (id: string, body: { version?: number; quoteId?: string }) =>
    post(u(`api/projects/${id}/generations`), body).then((r) => j<{ id: string }>(r)),
  genRetry: (genId: string, quoteId?: string) =>
    post(u(`api/generations/${genId}/retry`), quoteId ? { quoteId } : undefined).then((r) => j<{ id: string }>(r)),
  genRecheck: (genId: string) =>
    post(u(`api/generations/${genId}/recheck`)).then((r) => j<{ status: string }>(r)),
  genCancelQueue: (genId: string) =>
    post(u(`api/generations/${genId}/cancel-queue`)).then((r) => j<{ ok: true }>(r)),
  genRate: (genId: string, body: { rating: 1 | -1; artifacts: string[]; notes: string }) =>
    post(u(`api/generations/${genId}/rating`), body).then((r) => j<{ ok: true }>(r)),

  // ── Reality Finish: адаптивный camera/UGC-финиш готового рендера ─────────
  finishPreview: (genId: string, body: { mode: FinishMode; intensity: number }) =>
    post(u(`api/generations/${genId}/finish/preview`), body).then((r) => j<FinishPreviewInfo>(r)),
  finishApply: (genId: string, body: { mode: FinishMode; intensity: number }) =>
    post(u(`api/generations/${genId}/finish`), body).then((r) => j<{ ok: true }>(r)),
  finishRemove: (genId: string) =>
    fetch(u(`api/generations/${genId}/finish`), { method: 'DELETE', headers: csrfHeader() }).then((r) =>
      j<{ ok: true }>(r),
    ),
  pricing: () => fetch(u('api/pricing')).then((r) => j<PricingInfo>(r)),
  usageSummary: () => fetch(u('api/usage/summary')).then((r) => j<UsageSummary>(r)),

  mediaUrl: (id: string, sub: 'frames' | 'refs' | 'src' | 'start' | 'renders' | 'finish', file: string) =>
    u(`api/projects/${id}/media/${sub}/${encodeURIComponent(file)}`),

  // ── Carousel Studio (за фича-флагом; роуты 404 при выключенном) ──────────
  carouselPacks: () =>
    fetch(u('api/carousel/packs')).then((r) =>
      j<{ packs: Array<{ id: string; name: string; scenes: Array<{ id: string; name: string }> }> }>(r),
    ),
  carouselIdeationPrices: () =>
    fetch(u('api/carousel/ideation-prices')).then((r) =>
      j<{ ideasUsd: number | null; storyboardUsd: number | null; captionUsd: number | null }>(r),
    ),
  carouselList: () =>
    fetch(u('api/carousel/projects')).then((r) => j<{ carousels: CarouselInfo[] }>(r)),
  carouselCreate: (body: { modelId: string; variantId: string; slideCount?: number; title?: string }) =>
    post(u('api/carousel/projects'), body).then((r) => j<{ carousel: CarouselInfo }>(r)),
  carouselGet: (id: string) =>
    fetch(u(`api/carousel/projects/${id}`)).then((r) =>
      j<{ carousel: CarouselInfo; queuePosition: number }>(r),
    ),
  carouselDelete: (id: string) =>
    fetch(u(`api/carousel/projects/${id}`), { method: 'DELETE', headers: csrfHeader() }).then((r) =>
      j<{ ok: true }>(r),
    ),
  carouselIdeas: (id: string, opts?: { wish?: string; patternCardIds?: string[] }) =>
    post(u(`api/carousel/projects/${id}/ideas`), opts ?? {}).then((r) => j<CarouselIdeas>(r)),
  carouselPickIdea: (id: string, idea: CarouselIdea) =>
    post(u(`api/carousel/projects/${id}/idea`), { idea }).then((r) => j<{ ok: true }>(r)),
  carouselStoryboardGen: (id: string) =>
    post(u(`api/carousel/projects/${id}/storyboard`)).then((r) => j<{ storyboard: Storyboard }>(r)),
  carouselStoryboardSave: (id: string, storyboard: Storyboard) =>
    fetch(u(`api/carousel/projects/${id}/storyboard`), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...csrfHeader() },
      body: JSON.stringify({ storyboard }),
    }).then((r) => j<{ storyboard: Storyboard }>(r)),
  carouselCaption: (id: string, language?: 'en' | 'ru') =>
    post(u(`api/carousel/projects/${id}/caption`), { language }).then((r) => j<{ caption: Caption }>(r)),
  carouselQuote: (id: string, slides?: number) =>
    fetch(u(`api/carousel/projects/${id}/quote${slides ? `?slides=${slides}` : ''}`)).then((r) =>
      j<{ quote: CarouselQuoteInfo }>(r),
    ),
  carouselGenerate: (id: string) =>
    post(u(`api/carousel/projects/${id}/generate`)).then((r) => j<{ ok: true; queuePosition: number }>(r)),
  carouselSlideAction: (id: string, slideId: string, action: 'accept' | 'retry') =>
    post(u(`api/carousel/projects/${id}/slides/${slideId}/${action}`)).then((r) => j<{ ok: true }>(r)),
  carouselFileUrl: (id: string, file: string) => u(`api/carousel/${id}/file/${encodeURIComponent(file)}`),

  // ── Reference Miner («Подборки») ─────────────────────────────────────────
  minerCollections: () =>
    fetch(u('api/miner/collections')).then((r) => j<{ collections: CollectionInfo[] }>(r)),
  minerCreate: (body: { name: string; usernames: string[]; limit?: number }) =>
    post(u('api/miner/collections'), body).then((r) => j<{ collection: CollectionInfo }>(r)),
  minerDelete: (id: string) =>
    fetch(u(`api/miner/collections/${id}`), { method: 'DELETE', headers: csrfHeader() }).then((r) =>
      j<{ ok: true }>(r),
    ),
  minerGet: (id: string) =>
    fetch(u(`api/miner/collections/${id}`)).then((r) =>
      j<{ collection: CollectionInfo; runs: MiningRunInfo[]; cards: PatternCardInfo[] }>(r),
    ),
  minerQuote: (limit?: number) =>
    fetch(u(`api/miner/quote${limit ? `?limit=${limit}` : ''}`)).then((r) =>
      j<{ priceUsd: number | null }>(r),
    ),
  minerMine: (id: string) => post(u(`api/miner/collections/${id}/mine`)).then((r) => j<{ runId: string }>(r)),
  minerCardPatch: (cardId: string, body: { liked?: boolean; archived?: boolean }) =>
    fetch(u(`api/miner/cards/${cardId}`), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...csrfHeader() },
      body: JSON.stringify(body),
    }).then((r) => j<{ ok: true }>(r)),
  minerThumbUrl: (collectionId: string, file: string) =>
    u(`api/miner/collections/${collectionId}/thumb/${encodeURIComponent(file)}`),
};
