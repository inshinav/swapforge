// Apify-клиент: happy-путь, 429-ретрай сабмита, 5xx сабмита НЕ ретраится (анти-задвоение),
// GET-ретраи свободные, не-JSON и таймауты — понятные ошибки.
import { describe, expect, it } from 'vitest';
import { ApifyError, createApify } from '../src/apify';

type FetchLike = typeof fetch;

function fetchQueue(responses: Array<() => Response | Error>): { impl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    const next = responses.shift();
    if (!next) throw new Error('очередь ответов пуста');
    const r = next();
    if (r instanceof Error) throw r;
    return r;
  }) as FetchLike;
  return { impl, calls };
}

const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });
const http = (status: number, body = '{}') => () => new Response(body, { status });

describe('carousel: apify-клиент', () => {
  it('happy: старт рана, статус, элементы датасета', async () => {
    const { impl, calls } = fetchQueue([
      ok({ data: { id: 'run-1', defaultDatasetId: 'ds-1' } }),
      ok({ data: { status: 'SUCCEEDED', defaultDatasetId: 'ds-1' } }),
      ok([{ likes: 1 }, { likes: 2 }]),
    ]);
    const client = createApify({ apiKey: 'k', fetchImpl: impl, retryBaseMs: 1 });
    const run = await client.startActorRun('apify/instagram-profile-scraper', { usernames: ['x'] });
    expect(run).toEqual({ runId: 'run-1', defaultDatasetId: 'ds-1' });
    expect((await client.getRun('run-1')).status).toBe('SUCCEEDED');
    expect(await client.datasetItems('ds-1')).toHaveLength(2);
    expect(calls[0]).toContain('/v2/acts/apify%2Finstagram-profile-scraper/runs');
    expect(calls[2]).toContain('/v2/datasets/ds-1/items');
  });

  it('submit: 429 ретраится, 500 — НЕТ (ран мог создаться)', async () => {
    const retried = createApify({
      apiKey: 'k',
      retryBaseMs: 1,
      fetchImpl: fetchQueue([http(429), ok({ data: { id: 'run-2' } })]).impl,
    });
    expect((await retried.startActorRun('a/b', {})).runId).toBe('run-2');

    const q = fetchQueue([http(500)]);
    const failed = createApify({ apiKey: 'k', retryBaseMs: 1, fetchImpl: q.impl });
    await expect(failed.startActorRun('a/b', {})).rejects.toThrow(ApifyError);
    expect(q.calls).toHaveLength(1); // ровно одна попытка
  });

  it('getRun: сетевые/5xx ретраятся до успеха', async () => {
    const client = createApify({
      apiKey: 'k',
      retryBaseMs: 1,
      fetchImpl: fetchQueue([
        () => new Error('boom'),
        http(503),
        ok({ data: { status: 'RUNNING' } }),
      ]).impl,
    });
    expect((await client.getRun('r')).status).toBe('RUNNING');
  });

  it('без ключа — понятная ошибка; не-JSON — понятная ошибка', async () => {
    const noKey = createApify({ fetchImpl: fetchQueue([]).impl });
    await expect(noKey.getRun('r')).rejects.toThrow(/APIFY_TOKEN/);
    const badJson = createApify({
      apiKey: 'k',
      retryBaseMs: 1,
      fetchImpl: fetchQueue([() => new Response('<html>', { status: 200 })]).impl,
    });
    await expect(badJson.getRun('r')).rejects.toThrow(/не-JSON/);
  });
});
