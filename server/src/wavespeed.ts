// WaveSpeed API-клиент: загрузка файлов, сабмит Seedance video-edit, поллинг, скачивание
// результата, баланс и каталог моделей (живой тариф). Ключ никогда не попадает в логи и ошибки.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';

const BASE = 'https://api.wavespeed.ai';

export class WsError extends Error {
  status?: number;
  retryable: boolean;
  constructor(message: string, opts: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = 'WsError';
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
  }
}

interface Envelope<T> {
  code?: number;
  message?: string;
  data?: T;
}

export interface WsPrediction {
  id: string;
  status: string; // created | processing | completed | failed
  outputs: string[];
  error: string;
  /** Полный data-объект — для cost/executionTime/has_nsfw_contents (поля сверяем на смоке). */
  raw: Record<string, unknown>;
}

export interface WsModelEntry {
  model_id: string;
  base_price?: number;
  formula?: string;
  [k: string]: unknown;
}

export interface CreateWsOpts {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** База экспоненциального бэкоффа (тестовый рычаг). */
  retryBaseMs?: number;
}

export function createWaveSpeed(opts: CreateWsOpts = {}) {
  const baseUrl = opts.baseUrl ?? BASE;
  const f = opts.fetchImpl ?? fetch;
  const retryBaseMs = opts.retryBaseMs ?? 1000;

  function requireKey(): string {
    const k = opts.apiKey ?? config.wavespeedApiKey;
    if (!k) throw new WsError('WAVESPEED_API_KEY не настроен — добавь его в env сервиса');
    return k;
  }

  function toNetError(e: unknown): WsError {
    if (e instanceof WsError) return e;
    const name = e instanceof Error ? e.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return new WsError('WaveSpeed не ответил вовремя (таймаут)', { retryable: true });
    }
    const m = e instanceof Error ? e.message : String(e);
    return new WsError(`Сеть до WaveSpeed недоступна: ${m.slice(0, 160)}`, { retryable: true });
  }

  async function api<T>(
    pathname: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<T> {
    const { timeoutMs = 30_000, ...rest } = init;
    let res: Response;
    try {
      res = await f(`${baseUrl}${pathname}`, {
        ...rest,
        headers: { Authorization: `Bearer ${requireKey()}`, ...(rest.headers ?? {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw toNetError(e);
    }
    let body: Envelope<T> | null = null;
    try {
      body = (await res.json()) as Envelope<T>;
    } catch {
      /* не-JSON тело (например, «404 page not found») */
    }
    if (!res.ok) {
      const msg = body?.message ? ` — ${String(body.message).slice(0, 200)}` : '';
      throw new WsError(`WaveSpeed HTTP ${res.status}${msg}`, {
        status: res.status,
        retryable: res.status === 429 || res.status >= 500,
      });
    }
    if (!body || body.code !== 200) {
      throw new WsError(`WaveSpeed: ${String(body?.message ?? 'пустой ответ').slice(0, 300)}`, {
        status: body?.code,
      });
    }
    return body.data as T;
  }

  async function withRetry<T>(
    label: string,
    tries: number,
    fn: () => Promise<T>,
    canRetry: (e: unknown) => boolean = (e) => e instanceof WsError && e.retryable,
  ): Promise<T> {
    let last: unknown;
    for (let i = 0; i < tries; i++) {
      try {
        return await fn();
      } catch (e) {
        last = e;
        if (!canRetry(e) || i === tries - 1) break;
        const delay = retryBaseMs * 2 ** i;
        console.warn(
          `[wavespeed] ${label}: попытка ${i + 1}/${tries} не удалась (${e instanceof Error ? e.message.slice(0, 120) : e}), повтор через ${delay}мс`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw last;
  }

  return {
    /** Загрузка файла → публичный URL (живёт 7 дней на стороне WaveSpeed). */
    async uploadBinary(filePath: string): Promise<string> {
      const stat = fs.statSync(filePath);
      if (stat.size > 1024 ** 3) throw new WsError('Файл больше 1 ГБ — WaveSpeed не примет');
      return withRetry('upload', 2, async () => {
        // openAsBlob стримит с диска без загрузки в память (важно для 300МБ исходников)
        const blob: Blob =
          typeof fs.openAsBlob === 'function'
            ? await fs.openAsBlob(filePath)
            : new Blob([fs.readFileSync(filePath)]);
        const fd = new FormData();
        fd.append('file', blob, path.basename(filePath));
        const data = await api<{ url?: string; download_url?: string }>(
          '/api/v3/media/upload/binary',
          { method: 'POST', body: fd, timeoutMs: 15 * 60_000 },
        );
        const url = data?.url || data?.download_url;
        if (!url) throw new WsError('WaveSpeed не вернул URL загруженного файла');
        return url;
      });
    },

    /**
     * Сабмит Seedance video-edit → prediction id.
     * Ретраим ТОЛЬКО 429: на 5xx/таймауте задача может уже существовать на стороне WaveSpeed,
     * и слепой повтор = двойное списание. Пользовательский «Повторить рендер» дёшев —
     * загруженные ассеты переиспользуются.
     */
    async submitVideoEdit(payload: Record<string, unknown>): Promise<string> {
      return withRetry(
        'submit',
        3,
        async () => {
          const data = await api<{ id?: string }>(`/api/v3/${config.seedanceEndpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            timeoutMs: 60_000,
          });
          if (!data?.id) throw new WsError('WaveSpeed не вернул id задачи');
          return data.id;
        },
        (e) => e instanceof WsError && e.status === 429,
      );
    },

    /** Один опрос результата (ретраи и толерантность к сети — в поллере рендера). */
    async pollResult(predictionId: string): Promise<WsPrediction> {
      const data = await api<Record<string, unknown>>(
        `/api/v3/predictions/${encodeURIComponent(predictionId)}/result`,
        { timeoutMs: 30_000 },
      );
      return {
        id: String(data?.id ?? predictionId),
        status: String(data?.status ?? 'unknown'),
        outputs: Array.isArray(data?.outputs) ? (data.outputs as string[]) : [],
        error: typeof data?.error === 'string' ? data.error : '',
        raw: data ?? {},
      };
    },

    /** Скачивание готового ролика: стрим в `.part` + rename, санити-кап размера. */
    async downloadOutput(url: string, destPath: string, maxBytes: number): Promise<number> {
      let res: Response;
      try {
        res = await f(url, { signal: AbortSignal.timeout(10 * 60_000) });
      } catch (e) {
        throw toNetError(e);
      }
      if (!res.ok || !res.body) {
        throw new WsError(`Не удалось скачать результат (HTTP ${res.status})`, {
          status: res.status,
          retryable: res.status === 429 || res.status >= 500,
        });
      }
      const part = `${destPath}.part`;
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const out = fs.createWriteStream(part);
      let bytes = 0;
      try {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maxBytes) {
            await reader.cancel();
            throw new WsError(
              `Результат больше санити-лимита ${Math.round(maxBytes / 1024 ** 2)} МБ — что-то не так`,
            );
          }
          if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
        }
        await new Promise<void>((resolve, reject) => {
          out.on('error', reject);
          out.end(() => resolve());
        });
        fs.renameSync(part, destPath);
        return bytes;
      } catch (e) {
        out.destroy();
        fs.rmSync(part, { force: true });
        throw e instanceof WsError ? e : toNetError(e);
      }
    },

    /** Живой остаток аккаунта в USD. */
    async getBalance(): Promise<number> {
      const data = await api<{ balance?: number }>('/api/v3/balance', { timeoutMs: 15_000 });
      if (typeof data?.balance !== 'number') throw new WsError('WaveSpeed не вернул баланс');
      return data.balance;
    },

    /** Запись каталога моделей (живой тариф: base_price + formula + api_schema). */
    async fetchModelEntry(modelId: string): Promise<WsModelEntry> {
      const data = await api<WsModelEntry[]>('/api/v3/models', { timeoutMs: 60_000 });
      const entry = Array.isArray(data) ? data.find((m) => m?.model_id === modelId) : undefined;
      if (!entry) throw new WsError(`Модель ${modelId} не найдена в каталоге WaveSpeed`);
      return entry;
    },
  };
}

export type WaveSpeed = ReturnType<typeof createWaveSpeed>;

/** Прод-клиент на config (ключ читается лениво — тесты его не требуют). */
export const wavespeed: WaveSpeed = createWaveSpeed();
