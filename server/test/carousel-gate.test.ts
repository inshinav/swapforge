// Денежный гейт requireActiveAttempt, карусельная ветка (SPEC §7): fail-closed на каждом шаге,
// чужая hold не проходит, owner unmetered, видео-ветки не затронуты (их держит остальной suite).
import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-carousel-gate-'));
process.env.AUTH_DEV_BYPASS = '1';
process.env.OWNER_TELEGRAM_ID = '9600';

const { getDb } = await import('../src/db');
const { BillingAttemptRequiredError, requireActiveAttempt } = await import('../src/billing/attempts');
const { grantPurchase, placeHold } = await import('../src/billing/credits');

let userId: string;
let ownerId: string;

function insertUser(id: string, telegramId: number): void {
  getDb()
    .prepare(`INSERT INTO users (id, telegram_id, tg_username) VALUES (?, ?, ?)`)
    .run(id, telegramId, `u_${telegramId}`);
}

function insertCarousel(id: string, owner: string): void {
  getDb().prepare(`INSERT INTO carousel_projects (id, user_id) VALUES (?, ?)`).run(id, owner);
}

beforeAll(() => {
  userId = randomUUID();
  insertUser(userId, 111222);
  // Владелец уже создан бутом БД по OWNER_TELEGRAM_ID (owner-ротация) — используем его.
  const owner = getDb()
    .prepare(`SELECT id FROM users WHERE role='owner'`)
    .get() as { id: string } | undefined;
  if (!owner) throw new Error('owner не создан бутом');
  ownerId = owner.id;
  grantPurchase(userId, 100_000, `seed-${randomUUID()}`, 'тестовый баланс');
});

describe('carousel: гейт платных вызовов', () => {
  it('неизвестный carouselId → отказ', () => {
    expect(() => requireActiveAttempt({ carouselId: randomUUID() })).toThrow(
      BillingAttemptRequiredError,
    );
  });

  it('карусель не-owner без open-hold → отказ', () => {
    const carouselId = randomUUID();
    insertCarousel(carouselId, userId);
    expect(() => requireActiveAttempt({ carouselId })).toThrow(BillingAttemptRequiredError);
  });

  it('карусель не-owner с собственной open-hold → пропуск, возвращает hold id', () => {
    const carouselId = randomUUID();
    insertCarousel(carouselId, userId);
    const hold = placeHold(userId, carouselId, 500);
    if (!hold.ok) throw new Error('hold не создался');
    expect(requireActiveAttempt({ carouselId })).toBe(hold.holdId);
  });

  it('hold другого пользователя на тот же carouselId не существует по построению, а подложная (другой user_id) — не проходит', () => {
    const carouselId = randomUUID();
    insertCarousel(carouselId, userId);
    // Симулируем подложную hold: открытая hold с тем же scope-id, но чужим user_id.
    const foreign = randomUUID();
    insertUser(foreign, 333444);
    getDb()
      .prepare(`INSERT INTO credit_holds (id, user_id, project_id, credits) VALUES (?, ?, ?, ?)`)
      .run(randomUUID(), foreign, carouselId, 1);
    expect(() => requireActiveAttempt({ carouselId })).toThrow(BillingAttemptRequiredError);
  });

  it('карусель владельца → пропуск без hold (unmetered)', () => {
    const carouselId = randomUUID();
    insertCarousel(carouselId, ownerId);
    expect(requireActiveAttempt({ carouselId })).toBeNull();
  });

  it('settled/released hold не открывает гейт', () => {
    const carouselId = randomUUID();
    insertCarousel(carouselId, userId);
    const hold = placeHold(userId, carouselId, 300);
    if (!hold.ok) throw new Error('hold не создался');
    getDb().prepare(`UPDATE credit_holds SET status='released' WHERE id=?`).run(hold.holdId);
    expect(() => requireActiveAttempt({ carouselId })).toThrow(BillingAttemptRequiredError);
  });

  it('carouselId не проваливается в проектную ветку: несуществующий projectId рядом игнорируется', () => {
    const carouselId = randomUUID();
    insertCarousel(carouselId, userId);
    const hold = placeHold(userId, carouselId, 200);
    if (!hold.ok) throw new Error('hold не создался');
    // Даже с мусорным projectId карусельная ветка обслуживает вызов и не читает projects.
    expect(requireActiveAttempt({ carouselId, projectId: 'no-such-project' })).toBe(hold.holdId);
  });
});
