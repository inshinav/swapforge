import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-operations-'));
process.env.AUTH_DEV_BYPASS = '1';
process.env.OWNER_TELEGRAM_ID = '9900';
process.env.OPENAI_API_KEY = 'test-openai';
process.env.WAVESPEED_API_KEY = 'test-wavespeed';
process.env.CRYPTO_PAY_TOKEN = 'test-crypto';
process.env.BILLING_PROVIDERS = 'cryptopay';
process.env.SWAPFORGE_RELEASE_SHA = 'abc123def456';

const { buildApp } = await import('../src/app');
const { setFfmpegHealthForTests } = await import('../src/routes');

const app = await buildApp({ logger: false });

beforeAll(() => setFfmpegHealthForTests(true));
afterAll(async () => app.close());

describe('operations and release probes', () => {
  it('readiness is public, fail-closed and identifies the immutable release', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, version: '2.0.0', releaseSha: 'abc123def456' });
  });

  it('returns a safe correlation id and preserves a valid upstream id', async () => {
    const generated = await app.inject({ method: 'GET', url: '/api/health' });
    expect(generated.headers['x-request-id']).toMatch(/^[A-Za-z0-9-]{8,80}$/);

    const upstream = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-request-id': 'deploy-check-1234' },
    });
    expect(upstream.headers['x-request-id']).toBe('deploy-check-1234');
  });
});
