// Стор карусели (SPEC §10): safe-path гард, учёт байтов юзера, эвикция keep-last-N
// с защитой активных/ревью/холдов, каскад файлов.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-carousel-storage-'));

const { getDb } = await import('../src/db');
const {
  carouselDir,
  carouselSlidesDir,
  cleanupCarousels,
  ensureCarouselDirs,
  safeCarouselPath,
  userUsageBytes,
} = await import('../src/storage');
const { grantPurchase, placeHold } = await import('../src/billing/credits');

function seedUser(): string {
  const id = randomUUID();
  getDb()
    .prepare(`INSERT INTO users (id, telegram_id, tg_username) VALUES (?, ?, ?)`)
    .run(id, Math.floor(Math.random() * 1e9), 'st-user');
  return id;
}

function seedCarousel(userId: string, status = 'done', withFile = true): string {
  const id = randomUUID();
  getDb()
    .prepare(`INSERT INTO carousel_projects (id, user_id, status) VALUES (?, ?, ?)`)
    .run(id, userId, status);
  ensureCarouselDirs(id);
  if (withFile) fs.writeFileSync(path.join(carouselSlidesDir(id), 'slide_01.png'), Buffer.alloc(2048));
  return id;
}

describe('carousel: стор', () => {
  it('safeCarouselPath: валидный файл ок; травёрсал/мусор/чужой путь — null', () => {
    const userId = seedUser();
    const id = seedCarousel(userId);
    expect(safeCarouselPath(id, 'slide_01.png')).toContain(path.join('carousels', id, 'slides'));
    expect(safeCarouselPath(id, '../secrets.txt')).toBeNull();
    expect(safeCarouselPath(id, 'a b.png')).toBeNull();
    expect(safeCarouselPath(id, 'nope.png')).toBeNull();
  });

  it('userUsageBytes учитывает карусельные байты', () => {
    const userId = seedUser();
    expect(userUsageBytes(userId, true)).toBe(0);
    seedCarousel(userId);
    expect(userUsageBytes(userId, true)).toBeGreaterThanOrEqual(2048);
  });

  it('эвикция: за пределами keep удаляются строка и каталог; активные/ревью/холды защищены', () => {
    const userId = seedUser();
    grantPurchase(userId, 10_000, `seed-${randomUUID()}`, 'seed');
    // 3 старых done + защищённые.
    const oldDone = [seedCarousel(userId), seedCarousel(userId), seedCarousel(userId)];
    const generating = seedCarousel(userId, 'generating');
    const review = seedCarousel(userId, 'qc_review');
    const held = seedCarousel(userId, 'draft');
    placeHold(userId, held, 100);
    const fresh = seedCarousel(userId);

    const deleted = cleanupCarousels(userId, 2); // keep=2 последних
    // Свежие 2 из списка (по created_at DESC) остаются; из старых сносятся все не защищённые.
    for (const id of deleted) {
      expect(fs.existsSync(carouselDir(id))).toBe(false);
      expect(getDb().prepare(`SELECT id FROM carousel_projects WHERE id=?`).get(id)).toBeUndefined();
      expect(
        getDb().prepare(`SELECT COUNT(*) AS c FROM carousel_slides WHERE carousel_id=?`).get(id),
      ).toEqual({ c: 0 });
    }
    for (const id of [generating, review, held, fresh]) {
      expect(getDb().prepare(`SELECT id FROM carousel_projects WHERE id=?`).get(id)).toBeDefined();
    }
    expect(deleted.length).toBeGreaterThanOrEqual(2);
    expect(deleted).not.toContain(generating);
    expect(deleted).not.toContain(review);
    expect(deleted).not.toContain(held);
    expect(deleted.some((d) => oldDone.includes(d))).toBe(true);
  });
});
