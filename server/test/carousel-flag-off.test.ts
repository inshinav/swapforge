// Фича-флаг выключен (default) → карусельных роутов НЕ СУЩЕСТВУЕТ (404 даже с auth),
// видео-роуты живут как прежде (SPEC §0.1).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-carousel-off-'));
process.env.AUTH_DEV_BYPASS = '1';
delete process.env.CAROUSEL_STUDIO;

const { buildApp } = await import('../src/app');
import type { FastifyInstance } from 'fastify';

describe('carousel: флаг выключен', () => {
  let app: FastifyInstance;
  let headers: Record<string, string>;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    const res = await app.inject({ method: 'POST', url: '/api/auth/dev-login', payload: { telegramId: 3001, name: 'X' } });
    const setCookies = res.headers['set-cookie'] as string[];
    const sess = setCookies.find((c) => c.startsWith('sf_sess='))!.split(';')[0]!;
    const csrfPair = setCookies.find((c) => c.startsWith('sf_csrf='))!.split(';')[0]!;
    headers = { cookie: `${sess}; ${csrfPair}`, 'x-sf-csrf': decodeURIComponent(csrfPair.split('=').slice(1).join('=')) };
  });

  afterAll(async () => {
    await app.close();
  });

  it('все карусельные роуты — 404; здоровье сервиса живо', async () => {
    for (const [method, url] of [
      ['GET', '/api/carousel/projects'],
      ['POST', '/api/carousel/projects'],
      ['GET', '/api/carousel/packs'],
      ['GET', '/api/carousel/abc/file/x.png'],
    ] as const) {
      const res = await app.inject({ method, url, headers });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
  });
});
