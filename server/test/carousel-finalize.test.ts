// Финализация слайда: 1080×1350 (4:5) и 1080×1080 (1:1), лишний размер кропится по центру;
// провал/отсутствие ffmpeg не роняет слайд (final_file остаётся NULL). Гард: ffmpegAvailable.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-carousel-finalize-'));

const { getDb } = await import('../src/db');
const { finalizeFilter, finalizeSlideFile } = await import('../src/engine/carousel/finalize');
const { carouselSlidesDir, ensureCarouselDirs } = await import('../src/storage');
const { ffmpegAvailable, probe } = await import('../src/ffmpeg');

const haveFfmpeg = await ffmpegAvailable();

function seedSlideWithPng(width: number, height: number): { carouselId: string; slideId: string } {
  const db = getDb();
  const userId = randomUUID();
  db.prepare(`INSERT INTO users (id, telegram_id, tg_username) VALUES (?, ?, ?)`).run(
    userId,
    Math.floor(Math.random() * 1e9),
    'fin-user',
  );
  const carouselId = randomUUID();
  db.prepare(`INSERT INTO carousel_projects (id, user_id) VALUES (?, ?)`).run(carouselId, userId);
  ensureCarouselDirs(carouselId);
  const slideId = randomUUID();
  const file = 'slide_01.png';
  db.prepare(`INSERT INTO carousel_slides (id, carousel_id, idx, status, file) VALUES (?, ?, 1, 'done', ?)`).run(
    slideId,
    carouselId,
    file,
  );
  // Реальный PNG нужного размера — генерим ffmpeg-ом (testsrc детерминирован).
  const dest = path.join(carouselSlidesDir(carouselId), file);
  const r = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `testsrc=size=${width}x${height}:duration=1:rate=1`, '-frames:v', '1', dest], {
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error('не удалось сгенерировать тестовый PNG');
  return { carouselId, slideId };
}

describe('carousel: финализация слайда', () => {
  it('фильтр детерминирован: cover+кроп+sRGB', () => {
    expect(finalizeFilter('4:5')).toBe(
      'scale=1080:1350:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1350,noise=alls=5:allf=t,format=yuvj420p',
    );
    expect(finalizeFilter('1:1')).toContain('1080:1080');
  });

  it.skipIf(!haveFfmpeg)('1024×1280 → 1080×1350 (upscale 4:5)', async () => {
    const { carouselId, slideId } = seedSlideWithPng(1024, 1280);
    const finalName = await finalizeSlideFile(carouselId, slideId, '4:5');
    expect(finalName).toBeTruthy();
    const meta = await probe(path.join(carouselSlidesDir(carouselId), finalName!));
    expect([meta.width, meta.height]).toEqual([1080, 1350]);
    const row = getDb().prepare(`SELECT final_file FROM carousel_slides WHERE id=?`).get(slideId) as {
      final_file: string;
    };
    expect(row.final_file).toBe(finalName);
  });

  it.skipIf(!haveFfmpeg)('1024×1536 (негибкая модель) → центр-кроп до 1080×1350', async () => {
    const { carouselId, slideId } = seedSlideWithPng(1024, 1536);
    const finalName = await finalizeSlideFile(carouselId, slideId, '4:5');
    const meta = await probe(path.join(carouselSlidesDir(carouselId), finalName!));
    expect([meta.width, meta.height]).toEqual([1080, 1350]);
  });

  it('слайд без файла → null, строка не тронута', async () => {
    const db = getDb();
    const userId = randomUUID();
    db.prepare(`INSERT INTO users (id, telegram_id, tg_username) VALUES (?, ?, ?)`).run(
      userId,
      Math.floor(Math.random() * 1e9),
      'fin-user2',
    );
    const carouselId = randomUUID();
    db.prepare(`INSERT INTO carousel_projects (id, user_id) VALUES (?, ?)`).run(carouselId, userId);
    const slideId = randomUUID();
    db.prepare(`INSERT INTO carousel_slides (id, carousel_id, idx) VALUES (?, ?, 1)`).run(slideId, carouselId);
    expect(await finalizeSlideFile(carouselId, slideId)).toBeNull();
  });
});
