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

  it('библиотека отдаёт только 20 последних роликов', async () => {
    const insert = getDb().prepare(
      `INSERT INTO projects (id, user_id, title, status, video_file, meta_json, created_at)
       VALUES (?, ?, ?, 'complete', 'source.mp4', '{"durationSec":6,"width":720,"height":1280,"fps":30,"aspect":"9:16","sizeBytes":1000}', ?)`,
    );
    for (let i = 1; i <= 24; i += 1) {
      insert.run(`library-${i}`, userA.userId, `ролик ${i}`, `2099-01-${String(i).padStart(2, '0')} 12:00:00`);
    }

    const res = await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie: userA.cookie } });
    expect(res.statusCode).toBe(200);
    const projects = res.json() as Array<{ id: string }>;
    expect(projects).toHaveLength(20);
    expect(projects[0]?.id).toBe('library-24');
    expect(projects.at(-1)?.id).toBe('library-5');
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
    for (const url of ['/api/pricing', '/api/usage/summary', '/api/admin/overview']) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie: userA.cookie } });
      expect(res.statusCode, url).toBe(403);
    }
    // владельцу /api/usage/summary отвечает (200; /api/pricing зовёт живой WaveSpeed — не дёргаем в тестах)
    const usage = await app.inject({ method: 'GET', url: '/api/usage/summary', headers: { cookie: owner.cookie } });
    expect(usage.statusCode).toBe(200);
  });

  it('админ-обзор показывает владельцу баланс и реальную активность пользователя', async () => {
    getDb()
      .prepare(
        `INSERT INTO projects (id, user_id, title, status, video_file, meta_json, created_at)
         VALUES ('admin-project-b', ?, 'Тестовый ролик B', 'complete', 'source.mp4', '{}', '2099-02-01 12:00:00')`,
      )
      .run(userB.userId);
    getDb()
      .prepare(
        `INSERT INTO generations (id, project_id, version, status, user_id, created_at, finished_at)
         VALUES ('admin-gen-b-done', 'admin-project-b', 1, 'done', ?, '2099-02-01 12:01:00', '2099-02-01 12:02:00')`,
      )
      .run(userB.userId);
    getDb()
      .prepare(
        `INSERT INTO generations (id, project_id, version, status, user_id, created_at, submitted_at)
         VALUES ('admin-gen-b-active', 'admin-project-b', 2, 'rendering', ?, '2099-02-01 12:03:00', '2099-02-01 12:04:00')`,
      )
      .run(userB.userId);
    getDb()
      .prepare(`INSERT INTO models (id, user_id, name) VALUES ('admin-model-b', ?, 'Модель B')`)
      .run(userB.userId);
    getDb()
      .prepare(
        `INSERT INTO credit_ledger (id, user_id, delta_credits, kind, note)
         VALUES ('admin-ledger-b', ?, 2500, 'purchase', 'тест админки')`,
      )
      .run(userB.userId);
    getDb()
      .prepare(
        `INSERT INTO credit_holds (id, user_id, project_id, generation_id, credits, status)
         VALUES ('admin-hold-b', ?, 'admin-project-b', 'admin-gen-b-active', 400, 'open')`,
      )
      .run(userB.userId);

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/overview',
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      summary: { users: number; totalBalanceUsd: number; heldUsd: number; activeRenders: number };
      users: Array<{
        id: string;
        balance: { balanceUsd: number; heldUsd: number; availableUsd: number };
        projects: number;
        models: number;
        renders: number;
        doneRenders: number;
        activeRenders: number;
        latestProjectTitle: string | null;
        latestGenerationStatus: string | null;
        lastActivityAt: string;
      }>;
    };
    const row = body.users.find((user) => user.id === userB.userId);
    expect(row).toMatchObject({
      balance: { balanceUsd: 25, heldUsd: 4, availableUsd: 21 },
      projects: 1,
      models: 1,
      renders: 2,
      doneRenders: 1,
      activeRenders: 1,
      latestProjectTitle: 'Тестовый ролик B',
      latestGenerationStatus: 'rendering',
      lastActivityAt: '2099-02-01 12:04:00',
    });
    expect(body.summary.users).toBeGreaterThanOrEqual(2);
    expect(body.summary.totalBalanceUsd).toBeGreaterThanOrEqual(25);
    expect(body.summary.heldUsd).toBeGreaterThanOrEqual(4);
    expect(body.summary.activeRenders).toBeGreaterThanOrEqual(1);
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
