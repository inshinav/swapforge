import type {
  AuthUser,
  BillingPacksInfo,
  BillingProviderId,
  CreditBalanceInfo,
  CreditLedgerEntry,
  EstimateForUser,
  EstimateInfo,
  HealthInfo,
  MeInfo,
  ModelInfo,
  PresetInfo,
  PricingInfo,
  ProjectFull,
  ProjectSummary,
  TgWidgetPayload,
  UsageSummary,
} from '@shared/api-types';

// База приложения ('/swapforge/'): API и медиа всегда под ней — nginx срезает префикс.
// URL строим АБСОЛЮТНЫМ от location.origin: если страница открыта ссылкой вида
// https://user:pass@host/…, относительный fetch унаследовал бы креды и упал бы
// («Request cannot be constructed from a URL that includes credentials»).
export const appBase = import.meta.env.BASE_URL;
const u = (p: string) => `${window.location.origin}${appBase}${p}`;

/** Ошибка API со статусом: 401 = «не залогинен», UI разводит по-разному. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      const body = (await r.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      /* не-JSON ответ */
    }
    throw new ApiError(r.status, msg);
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
    body: { version: number; artifacts: string[]; notes: string; lang: string },
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
      variantId?: string;
      preset?: string;
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
  estimate: (id: string) =>
    fetch(u(`api/projects/${id}/estimate`)).then((r) => j<EstimateInfo | EstimateForUser>(r)),

  // ── v4: кредиты ──────────────────────────────────────────────────────────
  creditBalance: () => fetch(u('api/billing/balance')).then((r) => j<CreditBalanceInfo>(r)),
  creditLedger: () =>
    fetch(u('api/billing/ledger')).then((r) => j<{ entries: CreditLedgerEntry[] }>(r)),
  creditPacks: () => fetch(u('api/billing/packs')).then((r) => j<BillingPacksInfo>(r)),
  checkout: (packId: string, provider: BillingProviderId, email?: string) =>
    post(u('api/billing/checkout'), { packId, provider, email }).then((r) => j<{ payUrl: string }>(r)),
  swapAudioPref: (id: string, generateAudio: boolean) =>
    fetch(u(`api/projects/${id}/flags`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...csrfHeader() },
      body: JSON.stringify({ generateAudio }),
    }).then((r) => j<{ ok: true }>(r)),
  renderVersion: (id: string, body: { version?: number }) =>
    post(u(`api/projects/${id}/generations`), body).then((r) => j<{ id: string }>(r)),
  genRetry: (genId: string) =>
    post(u(`api/generations/${genId}/retry`)).then((r) => j<{ id: string }>(r)),
  genRecheck: (genId: string) =>
    post(u(`api/generations/${genId}/recheck`)).then((r) => j<{ status: string }>(r)),
  genCancelQueue: (genId: string) =>
    post(u(`api/generations/${genId}/cancel-queue`)).then((r) => j<{ ok: true }>(r)),
  genRate: (genId: string, body: { rating: 1 | -1; artifacts: string[]; notes: string }) =>
    post(u(`api/generations/${genId}/rating`), body).then((r) => j<{ ok: true }>(r)),
  pricing: () => fetch(u('api/pricing')).then((r) => j<PricingInfo>(r)),
  usageSummary: () => fetch(u('api/usage/summary')).then((r) => j<UsageSummary>(r)),

  mediaUrl: (id: string, sub: 'frames' | 'refs' | 'src' | 'start' | 'renders', file: string) =>
    u(`api/projects/${id}/media/${sub}/${encodeURIComponent(file)}`),
};
