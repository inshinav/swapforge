// Экспорт и доставка (SPEC §6): STORED-zip корректен по формату (сигнатуры/CRC/имена),
// export-роут отдаёт архив, send-tg — фолбэки sendPhoto/needStart, уведомление о готовности.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-carousel-export-'));
process.env.AUTH_DEV_BYPASS = '1';
process.env.CAROUSEL_STUDIO = '1';
process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token';

const { buildApp } = await import('../src/app');
const { getDb } = await import('../src/db');
const { buildStoredZip, crc32 } = await import('../src/zip-store');
const { sendCarouselToTelegram } = await import('../src/telegram/notify');
const { carouselSlidesDir, ensureCarouselDirs } = await import('../src/storage');

import type { FastifyInstance } from 'fastify';

describe('carousel: zip-store', () => {
  it('STORED-zip: сигнатуры, имена, размеры, CRC, EOCD', () => {
    const a = Buffer.from('hello world');
    const b = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const zip = buildStoredZip(
      [
        { name: 'caption.txt', data: a },
        { name: 'slide-01.png', data: b },
      ],
      new Date('2026-07-23T12:00:00'),
    );
    // local header 1
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.readUInt16LE(8)).toBe(0); // STORED
    expect(zip.readUInt32LE(14)).toBe(crc32(a));
    expect(zip.readUInt32LE(18)).toBe(a.length);
    expect(zip.subarray(30, 30 + 11).toString()).toBe('caption.txt');
    expect(zip.subarray(41, 41 + a.length).equals(a)).toBe(true);
    // EOCD в хвосте
    const eocd = zip.length - 22;
    expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
    expect(zip.readUInt16LE(eocd + 10)).toBe(2); // записей
    // central directory находится по offset из EOCD и указывает на правильные offsets
    const cdOffset = zip.readUInt32LE(eocd + 16);
    expect(zip.readUInt32LE(cdOffset)).toBe(0x02014b50);
    expect(zip.readUInt32LE(cdOffset + 42)).toBe(0); // первый local offset
  });

  it('crc32 совпадает с эталоном ("123456789" → 0xCBF43926)', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
});

describe('carousel: export-роут и send-tg', () => {
  let app: FastifyInstance;
  let headers: Record<string, string>;
  let userId: string;
  let carouselId: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    const res = await app.inject({ method: 'POST', url: '/api/auth/dev-login', payload: { telegramId: 5001, name: 'E' } });
    const setCookies = res.headers['set-cookie'] as string[];
    const sess = setCookies.find((c) => c.startsWith('sf_sess='))!.split(';')[0]!;
    const csrfPair = setCookies.find((c) => c.startsWith('sf_csrf='))!.split(';')[0]!;
    headers = { cookie: `${sess}; ${csrfPair}`, 'x-sf-csrf': decodeURIComponent(csrfPair.split('=').slice(1).join('=')) };
    userId = (res.json() as { user: { id: string } }).user.id;

    carouselId = randomUUID();
    getDb()
      .prepare(
        `INSERT INTO carousel_projects (id, user_id, status, caption_json, idea_json, title)
         VALUES (?, ?, 'done', ?, ?, 'Тест')`,
      )
      .run(
        carouselId,
        userId,
        JSON.stringify({ caption: 'hey', hashtags: ['#a', '#b'], hookLine: 'x' }),
        JSON.stringify({ title: 'Идея' }),
      );
    ensureCarouselDirs(carouselId);
    for (const [i, name] of ['slide_01.png', 'slide_02.png'].entries()) {
      fs.writeFileSync(path.join(carouselSlidesDir(carouselId), name), Buffer.from([0x89, 0x50, i]));
      getDb()
        .prepare(`INSERT INTO carousel_slides (id, carousel_id, idx, status, file) VALUES (?, ?, ?, 'done', ?)`)
        .run(randomUUID(), carouselId, i + 1, name);
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('export.zip: 200, application/zip, содержит слайды+caption+meta', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/carousel/projects/${carouselId}/export.zip`, headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/zip');
    expect(res.headers['content-disposition']).toContain('.zip');
    const body = res.rawPayload;
    expect(body.readUInt32LE(0)).toBe(0x04034b50);
    const text = body.toString('latin1');
    expect(text).toContain('slide-01.png');
    expect(text).toContain('slide-02.png');
    expect(text).toContain('caption.txt');
    expect(text).toContain('meta.json');
  });

  it('export.zip на draft-карусели → 409', async () => {
    const draft = randomUUID();
    getDb().prepare(`INSERT INTO carousel_projects (id, user_id, status) VALUES (?, ?, 'draft')`).run(draft, userId);
    const res = await app.inject({ method: 'GET', url: `/api/carousel/projects/${draft}/export.zip`, headers });
    expect(res.statusCode).toBe(409);
  });

  it('send-tg: happy (медиагруппа 2 слайда + подпись), 403-прекол → подсказка Start', async () => {
    const calls: string[] = [];
    const okFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const s = String(url);
      calls.push(s.split('/').pop()!.split('?')[0]!);
      if (s.includes('sendMediaGroup')) {
        expect(init?.body instanceof FormData).toBe(true);
        const media = JSON.parse(String((init!.body as FormData).get('media')));
        expect(media).toHaveLength(2);
        expect(media[0].media).toBe('attach://slide0');
      }
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const files = ['slide_01.png', 'slide_02.png'].map((f) => path.join(carouselSlidesDir(carouselId), f));
    const res = await sendCarouselToTelegram(
      { telegramId: 5001, filePaths: files, caption: 'hey #a' },
      { fetchImpl: okFetch },
    );
    expect(res).toEqual({ ok: true });
    expect(calls).toEqual(['sendChatAction', 'sendMediaGroup', 'sendMessage']);

    const blockedFetch = (async () => new Response('{"ok":false}', { status: 403 })) as unknown as typeof fetch;
    const blocked = await sendCarouselToTelegram(
      { telegramId: 5001, filePaths: files, caption: null },
      { fetchImpl: blockedFetch },
    );
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.needStart).toBe(true);
  });

  it('send-tg: один слайд → sendPhoto-фолбэк', async () => {
    const calls: string[] = [];
    const okFetch = (async (url: string | URL | Request) => {
      calls.push(String(url).split('/').pop()!);
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const one = [path.join(carouselSlidesDir(carouselId), 'slide_01.png')];
    const res = await sendCarouselToTelegram({ telegramId: 5001, filePaths: one, caption: null }, { fetchImpl: okFetch });
    expect(res.ok).toBe(true);
    expect(calls).toEqual(['sendChatAction', 'sendPhoto']);
  });
});
