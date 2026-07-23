// Carousel Studio: аддитивная схема — таблицы создаются на буте, существующие нетронуты,
// каскады и уникальные индексы работают (SPEC §8).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-carousel-db-'));
process.env.AUTH_DEV_BYPASS = '1';

const { getDb } = await import('../src/db');

function insertUser(id: string): void {
  getDb()
    .prepare(`INSERT INTO users (id, telegram_id, tg_username) VALUES (?, ?, ?)`)
    .run(id, Math.floor(Math.random() * 1e9), `u_${id.slice(0, 8)}`);
}

describe('carousel: схема', () => {
  it('все шесть таблиц существуют после getDb()', () => {
    const rows = getDb()
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN
        ('carousel_projects','carousel_slides','collections','pattern_cards','mining_runs')`)
      .all() as Array<{ name: string }>;
    expect(rows.map((r) => r.name).sort()).toEqual([
      'carousel_projects',
      'carousel_slides',
      'collections',
      'mining_runs',
      'pattern_cards',
    ]);
  });

  it('carousel_projects + carousel_slides: insert/select, каскад удаления, уникальность (carousel_id, idx)', () => {
    const db = getDb();
    const userId = randomUUID();
    insertUser(userId);
    const carouselId = randomUUID();
    db.prepare(`INSERT INTO carousel_projects (id, user_id, slide_count) VALUES (?, ?, 4)`).run(
      carouselId,
      userId,
    );
    const slideId = randomUUID();
    db.prepare(`INSERT INTO carousel_slides (id, carousel_id, idx) VALUES (?, ?, 1)`).run(
      slideId,
      carouselId,
    );
    expect(() =>
      db.prepare(`INSERT INTO carousel_slides (id, carousel_id, idx) VALUES (?, ?, 1)`).run(
        randomUUID(),
        carouselId,
      ),
    ).toThrow(/UNIQUE/i);
    const proj = db
      .prepare(`SELECT status, location_pack FROM carousel_projects WHERE id=?`)
      .get(carouselId) as { status: string; location_pack: string };
    expect(proj).toEqual({ status: 'draft', location_pack: 'miami' });
    db.prepare(`DELETE FROM carousel_projects WHERE id=?`).run(carouselId);
    const orphan = db.prepare(`SELECT id FROM carousel_slides WHERE id=?`).get(slideId);
    expect(orphan).toBeUndefined();
  });

  it('carousel_projects: CHECK статусов отклоняет неизвестный статус', () => {
    const db = getDb();
    const userId = randomUUID();
    insertUser(userId);
    expect(() =>
      db.prepare(`INSERT INTO carousel_projects (id, user_id, status) VALUES (?, ?, 'rendering')`).run(
        randomUUID(),
        userId,
      ),
    ).toThrow(/CHECK/i);
  });

  it('collections → pattern_cards/mining_runs: insert + каскад', () => {
    const db = getDb();
    const userId = randomUUID();
    insertUser(userId);
    const collectionId = randomUUID();
    db.prepare(`INSERT INTO collections (id, user_id, name) VALUES (?, ?, 'Miami girls')`).run(
      collectionId,
      userId,
    );
    const cardId = randomUUID();
    db.prepare(
      `INSERT INTO pattern_cards (id, collection_id, source_url, platform) VALUES (?, ?, ?, 'instagram')`,
    ).run(cardId, collectionId, 'https://example.com/p/1');
    const runId = randomUUID();
    db.prepare(`INSERT INTO mining_runs (id, collection_id, user_id) VALUES (?, ?, ?)`).run(
      runId,
      collectionId,
      userId,
    );
    db.prepare(`DELETE FROM collections WHERE id=?`).run(collectionId);
    expect(db.prepare(`SELECT id FROM pattern_cards WHERE id=?`).get(cardId)).toBeUndefined();
    expect(db.prepare(`SELECT id FROM mining_runs WHERE id=?`).get(runId)).toBeUndefined();
  });

  it('существующие таблицы видео-пайплайна на месте (санити «ноль изменений»)', () => {
    const names = (
      getDb().prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    for (const t of ['projects', 'refs', 'prompts', 'generations', 'jobs', 'credit_holds', 'credit_ledger']) {
      expect(names).toContain(t);
    }
  });
});
