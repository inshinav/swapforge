// Матрица изоляции тенантов на РЕАЛЬНОМ приложении (buildApp + inject):
// пользователь B не видит и не мутирует ничего у A; аноним получает 401;
// мутации без CSRF — 403; операторские роуты (USD) — только владельцу.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-tenancy-'));
process.env.AUTH_DEV_BYPASS = '1';
process.env.OWNER_TELEGRAM_ID = '9000'; // dev-login с этим id станет владельцем

const { buildApp } = await import('../src/app');
const { getDb } = await import('../src/db');

import type { FastifyInstance } from 'fastify';

interface Creds {
  cookie: string;
  csrf: string;
  userId: string;
}

/** Логин через dev-роут → пара cookie+csrf, как их держит браузер. */
async function login(app: FastifyInstance, telegramId: number, name: string): Promise<Creds> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/dev-login',
    payload: { telegramId, name },
  });
  expect(res.statusCode).toBe(200);
  const setCookies = res.headers['set-cookie'] as string[];
  const sess = setCookies.find((c) => c.startsWith('sf_sess='))!.split(';')[0]!;
  const csrfPair = setCookies.find((c) => c.startsWith('sf_csrf='))!.split(';')[0]!;
  const csrf = decodeURIComponent(csrfPair.split('=').slice(1).join('='));
  return {
    cookie: `${sess}; ${csrfPair}`,
    csrf,
    userId: (res.json() as { user: { id: string } }).user.id,
  };
}

const authed = (c: Creds) => ({ cookie: c.cookie, 'x-sf-csrf': c.csrf });

describe('тенантность роутов', () => {
  let app: FastifyInstance;
  let owner: Creds; // telegram_id 9000 → владелец
  let userA: Creds;
  let userB: Creds;
  let projectA: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    owner = await login(app, 9000, 'Владелец');
    userA = await login(app, 1001, 'Юзер А');
    userB = await login(app, 1002, 'Юзер Б');

    // проект юзера A прямо в БД (upload требует ffmpeg — не про этот тест)
    projectA = 'proj-of-a';
    getDb()
      .prepare(
        `INSERT INTO projects (id, user_id, title, status, video_file, meta_json)
         VALUES (?, ?, 'ролик А', 'complete', 'source.mp4', '{"durationSec":6,"width":720,"height":1280,"fps":30,"aspect":"9:16","sizeBytes":1000}')`,
      )
      .run(projectA, userA.userId);
    getDb()
      .prepare(`INSERT INTO generations (id, project_id, version, status, user_id) VALUES ('gen-of-a', ?, 1, 'done', ?)`)
      .run(projectA, userA.userId);
  });

  afterAll(async () => {
    await app.close();
  });

  it('аноним: 401 на всё приватное, health отдаёт только минимум', async () => {
    for (const url of ['/api/projects', `/api/projects/${projectA}`, '/api/me', '/api/presets']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    const body = health.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.provider).toBeUndefined();
    expect(body.dataBytes).toBeUndefined();
  });

  it('владелец видит расширенный health, юзер — минимальный', async () => {
    const forOwner = (await app.inject({ method: 'GET', url: '/api/health', headers: { cookie: owner.cookie } })).json() as Record<string, unknown>;
    expect(forOwner.provider).toBeDefined();
    const forUser = (await app.inject({ method: 'GET', url: '/api/health', headers: { cookie: userA.cookie } })).json() as Record<string, unknown>;
    expect(forUser.provider).toBeUndefined();
  });

  it('A видит свой проект, B получает 404 на каждый роут проекта A', async () => {
    const mine = await app.inject({ method: 'GET', url: `/api/projects/${projectA}`, headers: { cookie: userA.cookie } });
    expect(mine.statusCode).toBe(200);

    const reads: Array<[string, string]> = [
      ['GET', `/api/projects/${projectA}`],
      ['GET', `/api/projects/${projectA}/estimate`],
      ['GET', `/api/projects/${projectA}/media/refs/x.jpg`],
    ];
    for (const [method, url] of reads) {
      const res = await app.inject({ method: method as 'GET', url, headers: { cookie: userB.cookie } });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }

    const writes: Array<[string, string, Record<string, unknown> | undefined]> = [
      ['DELETE', `/api/projects/${projectA}`, undefined],
      ['PATCH', `/api/projects/${projectA}/flags`, { generateAudio: false }],
      ['POST', `/api/projects/${projectA}/swap`, {}],
      ['POST', `/api/projects/${projectA}/storyboard`, {}],
      ['POST', `/api/projects/${projectA}/analyze`, {}],
      ['POST', `/api/projects/${projectA}/generate`, {}],
      ['POST', `/api/projects/${projectA}/iterate`, { version: 1 }],
      ['POST', `/api/projects/${projectA}/feedback`, { version: 1 }],
      ['POST', `/api/projects/${projectA}/startframe`, {}],
      ['POST', `/api/projects/${projectA}/generations`, {}],
      ['PATCH', `/api/projects/${projectA}/refs`, { updates: [] }],
      ['DELETE', `/api/projects/${projectA}/refs/some-ref`, undefined],
    ];
    for (const [method, url, payload] of writes) {
      const res = await app.inject({
        method: method as 'POST',
        url,
        headers: authed(userB),
        ...(payload !== undefined ? { payload } : {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }

    // проект А цел
    const still = await app.inject({ method: 'GET', url: `/api/projects/${projectA}`, headers: { cookie: userA.cookie } });
    expect(still.statusCode).toBe(200);
  });

  it('генерации: B получает 404 на retry/recheck/rating генерации A', async () => {
    for (const url of ['/api/generations/gen-of-a/retry', '/api/generations/gen-of-a/recheck', '/api/generations/gen-of-a/rating']) {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: authed(userB),
        payload: { rating: 1 },
      });
      expect(res.statusCode, url).toBe(404);
    }
    // A свою генерацию оценивает
    const ok = await app.inject({
      method: 'POST',
      url: '/api/generations/gen-of-a/rating',
      headers: authed(userA),
      payload: { rating: 1, artifacts: [], notes: '' },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('листинг проектов скоупится по владельцу', async () => {
    const forA = (await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie: userA.cookie } })).json() as Array<{ id: string }>;
    expect(forA.map((p) => p.id)).toContain(projectA);
    const forB = (await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie: userB.cookie } })).json() as Array<{ id: string }>;
    expect(forB.map((p) => p.id)).not.toContain(projectA);
  });

  it('мутация с сессией, но БЕЗ CSRF-заголовка — 403', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectA}/flags`,
      headers: { cookie: userA.cookie }, // без x-sf-csrf
      payload: { generateAudio: false },
    });
    expect(res.statusCode).toBe(403);
  });

  it('операторские роуты (USD): юзеру 403, владельцу — можно', async () => {
    for (const url of ['/api/pricing', '/api/usage/summary']) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie: userA.cookie } });
      expect(res.statusCode, url).toBe(403);
    }
    // владельцу /api/usage/summary отвечает (200; /api/pricing зовёт живой WaveSpeed — не дёргаем в тестах)
    const usage = await app.inject({ method: 'GET', url: '/api/usage/summary', headers: { cookie: owner.cookie } });
    expect(usage.statusCode).toBe(200);
  });

  it('/api/me отражает пользователя; logout убивает сессию', async () => {
    const temp = await login(app, 1003, 'Временный');
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: temp.cookie } });
    expect((me.json() as { user: { telegramId: number } }).user.telegramId).toBe(1003);
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: temp.cookie } });
    expect(out.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: temp.cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('владелец из dev-login получает роль owner (OWNER_TELEGRAM_ID)', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: owner.cookie } });
    expect((me.json() as { user: { role: string } }).user.role).toBe('owner');
    const meA = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: userA.cookie } });
    expect((meA.json() as { user: { role: string } }).user.role).toBe('user');
  });
});
