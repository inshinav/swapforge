// Apify-клиент Reference Miner (SPEC §3) по шаблону wavespeed.ts: инжектируемый fetch
// (тесты глушат сеть), ретраи только там, где это не задваивает ран, таймауты на вызов.
import { config } from './config';

export class ApifyError extends Error {
  status?: number;
  retryable: boolean;
  constructor(msg: string, status?: number, retryable = false) {
    super(msg);
    this.name = 'ApifyError';
    this.status = status;
    this.retryable = retryable;
  }
}

export interface ApifyRunRef {
  runId: string;
  defaultDatasetId: string | null;
}

export interface ApifyRunStatus {
  status: 'READY' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'ABORTED' | 'TIMED-OUT' | string;
  defaultDatasetId: string | null;
}

export interface ApifyClientOpts {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  retryBaseMs?: number;
}

function toNetError(e: unknown): ApifyError {
  const msg = e instanceof Error ? e.message : String(e);
  const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
  return new ApifyError(timeout ? `таймаут запроса к Apify: ${msg}` : `сеть Apify: ${msg}`, undefined, true);
}

export function createApify(opts: ApifyClientOpts = {}) {
  const baseUrl = opts.baseUrl ?? 'https://api.apify.com';
  const doFetch = opts.fetchImpl ?? fetch;
  const retryBaseMs = opts.retryBaseMs ?? 1000;

  function requireKey(): string {
    const key = opts.apiKey ?? config.apifyToken;
    if (!key) throw new ApifyError('APIFY_TOKEN не настроен — добавь его в env сервиса');
    return key;
  }

  async function api<T>(
    pathname: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<T> {
    const { timeoutMs = 30_000, ...rest } = init;
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${pathname}`, {
        ...rest,
        headers: {
          Authorization: `Bearer ${requireKey()}`,
          'content-type': 'application/json',
          ...(rest.headers ?? {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (e instanceof ApifyError) throw e; // конфиг-ошибки (нет ключа) не «сетевые» и не ретраятся
      throw toNetError(e);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new ApifyError(
        `Apify HTTP ${res.status}: ${text.slice(0, 200)}`,
        res.status,
        res.status === 429 || res.status >= 500,
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApifyError(`Apify вернул не-JSON: ${text.slice(0, 120)}`);
    }
  }

  async function withRetry<T>(
    label: string,
    tries: number,
    fn: () => Promise<T>,
    canRetry: (e: ApifyError) => boolean,
  ): Promise<T> {
    let last: ApifyError | null = null;
    for (let i = 0; i < tries; i++) {
      try {
        return await fn();
      } catch (e) {
        const err = e instanceof ApifyError ? e : toNetError(e);
        last = err;
        if (i < tries - 1 && canRetry(err)) {
          await new Promise((r) => setTimeout(r, retryBaseMs * 2 ** i));
          continue;
        }
        throw err;
      }
    }
    throw last ?? new ApifyError(`${label}: неизвестная ошибка`);
  }

  return {
    /** Старт актора. Ретрай ТОЛЬКО на 429 (5xx/таймаут могли уже создать ран — не задваиваем). */
    async startActorRun(actorId: string, input: Record<string, unknown>): Promise<ApifyRunRef> {
      const res = await withRetry(
        'startActorRun',
        3,
        () =>
          api<{ data: { id: string; defaultDatasetId?: string } }>(
            `/v2/acts/${encodeURIComponent(actorId)}/runs`,
            { method: 'POST', body: JSON.stringify(input), timeoutMs: 60_000 },
          ),
        (e) => e.status === 429,
      );
      return { runId: res.data.id, defaultDatasetId: res.data.defaultDatasetId ?? null };
    },

    /** Статус рана (ретраи свободные — GET идемпотентен). */
    async getRun(runId: string): Promise<ApifyRunStatus> {
      const res = await withRetry(
        'getRun',
        4,
        () =>
          api<{ data: { status: string; defaultDatasetId?: string } }>(
            `/v2/actor-runs/${encodeURIComponent(runId)}`,
            { timeoutMs: 30_000 },
          ),
        (e) => e.retryable,
      );
      return { status: res.data.status as ApifyRunStatus['status'], defaultDatasetId: res.data.defaultDatasetId ?? null };
    },

    /** Элементы датасета (JSON-массив). */
    async datasetItems<T>(datasetId: string, { limit = 200 }: { limit?: number } = {}): Promise<T[]> {
      return withRetry(
        'datasetItems',
        4,
        () =>
          api<T[]>(`/v2/datasets/${encodeURIComponent(datasetId)}/items?format=json&clean=1&limit=${limit}`, {
            timeoutMs: 120_000,
          }),
        (e) => e.retryable,
      );
    },
  };
}

export type Apify = ReturnType<typeof createApify>;
export const apify = createApify();
