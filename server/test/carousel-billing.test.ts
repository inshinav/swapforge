// Деньги карусели (SPEC §7): reused-hold=конфликт, settle по атрибуции done-слайдов,
// 0 успешных = полный возврат, кап холдом, идеация-микроцикл, бут-матрица реконсиляции.
import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-carousel-billing-'));
process.env.USER_MARGIN_PCT = '25';
process.env.PRICING_OVERRIDES = JSON.stringify({
  'gpt-image-2': { inPerM: 10, outPerM: 40 },
  'gpt-5.6-luna': { inPerM: 2, outPerM: 8 },
  'gpt-5.6-terra': { inPerM: 0.5, outPerM: 2 },
});

const { getDb } = await import('../src/db');
const {
  HoldConflictError,
  InsufficientCreditsError,
  autoAcceptReview,
  carouselFactUsd,
  carouselQuoteInfo,
  placeCarouselHold,
  reconcileCarouselHolds,
  reviewDeadlineFromNow,
  settleCarousel,
  startGenerationHold,
  withIdeationHold,
} = await import('../src/engine/carousel/billing');
const { creditBalance, grantPurchase, openHoldForProject } = await import('../src/billing/credits');

let userId: string;

function seedUser(credits = 100_000): string {
  const id = randomUUID();
  getDb()
    .prepare(`INSERT INTO users (id, telegram_id, tg_username) VALUES (?, ?, ?)`)
    .run(id, Math.floor(Math.random() * 1e9), 'bill-user');
  grantPurchase(id, credits, `seed-${randomUUID()}`, 'seed');
  return id;
}

function seedCarousel(owner: string, status = 'draft'): string {
  const id = randomUUID();
  getDb()
    .prepare(`INSERT INTO carousel_projects (id, user_id, status, slide_count) VALUES (?, ?, ?, 4)`)
    .run(id, owner, status);
  return id;
}

function seedSlide(carouselId: string, idx: number, status: string): string {
  const id = `${carouselId.slice(0, 8)}-s${idx}`;
  getDb()
    .prepare(`INSERT INTO carousel_slides (id, carousel_id, idx, status) VALUES (?, ?, ?, ?)`)
    .run(id, carouselId, idx, status);
  return id;
}

function seedUsage(carouselId: string, generationId: string, costUsd: number): void {
  getDb()
    .prepare(
      `INSERT INTO usage_events (id, project_id, generation_id, task, model, tokens_in, tokens_out, cost_usd, user_id)
       VALUES (?, ?, ?, 'carousel_slide', 'gpt-image-2', 100, 100, ?, ?)`,
    )
    .run(randomUUID(), carouselId, generationId, costUsd, userId);
}

beforeEach(() => {
  userId = seedUser();
});

describe('carousel: деньги', () => {
  it('placeCarouselHold: свежая ok; вторая на тот же scope → HoldConflictError; бедный юзер → InsufficientCreditsError', () => {
    const carouselId = seedCarousel(userId);
    const holdId = placeCarouselHold(userId, carouselId, 500);
    expect(holdId).toBeTruthy();
    expect(() => placeCarouselHold(userId, carouselId, 300)).toThrow(HoldConflictError);
    const poor = seedUser(10);
    const poorCarousel = seedCarousel(poor);
    expect(() => placeCarouselHold(poor, poorCarousel, 500)).toThrow(InsufficientCreditsError);
  });

  it('carouselQuoteInfo: цена с frozen-маржой, shortfall при нехватке', () => {
    const q = carouselQuoteInfo(userId, 4);
    expect(q.priceUsd).toBeGreaterThan(0);
    expect(q.enough).toBe(true);
    const poor = seedUser(5);
    const qp = carouselQuoteInfo(poor, 4);
    expect(qp.enough).toBe(false);
    expect(qp.shortfallUsd).toBeGreaterThan(0);
  });

  it('startGenerationHold: пишет hold/run/quote; повтор при open-hold → конфликт', () => {
    const carouselId = seedCarousel(userId);
    startGenerationHold(carouselId, userId, 4);
    const row = getDb()
      .prepare(`SELECT hold_id, run_id, quote_json FROM carousel_projects WHERE id=?`)
      .get(carouselId) as { hold_id: string; run_id: string; quote_json: string };
    expect(row.hold_id).toBeTruthy();
    expect(row.run_id).toBeTruthy();
    expect(JSON.parse(row.quote_json).credits).toBeGreaterThan(0);
    expect(() => startGenerationHold(carouselId, userId, 4)).toThrow(HoldConflictError);
  });

  it('settle: факт = done-слайды + ран-левел, moderated исключён, кап = hold', () => {
    const carouselId = seedCarousel(userId, 'done');
    startGenerationHold(carouselId, userId, 3);
    const runId = (getDb().prepare(`SELECT run_id FROM carousel_projects WHERE id=?`).get(carouselId) as { run_id: string }).run_id;
    const s1 = seedSlide(carouselId, 1, 'done');
    const s2 = seedSlide(carouselId, 2, 'moderated');
    const s3 = seedSlide(carouselId, 3, 'done');
    seedUsage(carouselId, s1, 0.3);
    seedUsage(carouselId, s2, 0.25); // исключается
    seedUsage(carouselId, s3, 0.3);
    seedUsage(carouselId, runId, 0.01); // caption
    expect(carouselFactUsd(carouselId)).toBeCloseTo(0.61, 5);

    const before = creditBalance(userId);
    settleCarousel(carouselId);
    const after = creditBalance(userId);
    // priceCredits(0.61) = ceil(0.61×1.25×100) = 77 кредитов.
    expect(before.balance - after.balance).toBe(77);
    expect(after.held).toBe(0);
    const note = getDb()
      .prepare(`SELECT note FROM credit_ledger WHERE user_id=? AND kind='charge'`)
      .get(userId) as { note: string };
    expect(note.note).toBe('списание по факту карусели');
  });

  it('0 успешных слайдов → полный возврат, charge-строк нет', () => {
    const carouselId = seedCarousel(userId, 'failed');
    startGenerationHold(carouselId, userId, 2);
    seedSlide(carouselId, 1, 'moderated');
    seedSlide(carouselId, 2, 'failed');
    seedUsage(carouselId, `${carouselId.slice(0, 8)}-s1`, 0.3);
    const before = creditBalance(userId);
    settleCarousel(carouselId);
    const after = creditBalance(userId);
    expect(after.balance).toBe(before.balance);
    expect(after.held).toBe(0);
    const charges = getDb()
      .prepare(`SELECT COUNT(*) AS c FROM credit_ledger WHERE user_id=? AND kind='charge'`)
      .get(userId) as { c: number };
    expect(charges.c).toBe(0);
  });

  it('кап: факт больше квоты — списывается не больше hold', () => {
    const carouselId = seedCarousel(userId, 'done');
    startGenerationHold(carouselId, userId, 2);
    const holdCredits = (JSON.parse(
      (getDb().prepare(`SELECT quote_json FROM carousel_projects WHERE id=?`).get(carouselId) as { quote_json: string })
        .quote_json,
    ) as { credits: number }).credits;
    const s1 = seedSlide(carouselId, 1, 'done');
    seedUsage(carouselId, s1, 999); // абсурдный перерасход
    const before = creditBalance(userId);
    settleCarousel(carouselId);
    const after = creditBalance(userId);
    expect(before.balance - after.balance).toBe(holdCredits);
  });

  it('идеация: успех settle по opId-факту; двойной клик → конфликт; провал → полный возврат', async () => {
    const carouselId = seedCarousel(userId);
    const before = creditBalance(userId);
    await withIdeationHold({ carouselId, userId, task: 'carousel_idea' }, async (opId) => {
      seedUsage(carouselId, opId, 0.008);
      // Конкурентный клик, пока hold открыта:
      await expect(
        withIdeationHold({ carouselId, userId, task: 'carousel_idea' }, async () => 'x'),
      ).rejects.toThrow(HoldConflictError);
      return 'ideas';
    });
    const afterOk = creditBalance(userId);
    expect(before.balance - afterOk.balance).toBe(1); // ceil(0.008×1.25×100)=1, ниже капа квоты
    expect(afterOk.held).toBe(0);

    await expect(
      withIdeationHold({ carouselId, userId, task: 'carousel_idea' }, async () => {
        throw new Error('llm down');
      }),
    ).rejects.toThrow('llm down');
    const afterFail = creditBalance(userId);
    expect(afterFail.balance).toBe(afterOk.balance);
    expect(afterFail.held).toBe(0);
  });

  it('реконсиляция: draft-сирота released; qc_review жив — не тронут; протухший — авто-принят и settled; generating не тронут', () => {
    reconcileCarouselHolds(); // сброс холдов, оставленных предыдущими тестами файла
    // 1) сирота идеации (draft + open hold)
    const orphan = seedCarousel(userId);
    placeCarouselHold(userId, orphan, 100);
    // 2) живое ревью
    const alive = seedCarousel(userId, 'qc_review');
    startGenerationHold(alive, userId, 2);
    getDb().prepare(`UPDATE carousel_projects SET review_deadline=? WHERE id=?`).run(reviewDeadlineFromNow(), alive);
    seedSlide(alive, 1, 'needs_review');
    // 3) протухшее ревью с done+needs_review слайдами
    const expired = seedCarousel(userId, 'qc_review');
    startGenerationHold(expired, userId, 2);
    getDb().prepare(`UPDATE carousel_projects SET review_deadline=datetime('now','-1 hour') WHERE id=?`).run(expired);
    const e1 = seedSlide(expired, 1, 'done');
    seedSlide(expired, 2, 'needs_review');
    seedUsage(expired, e1, 0.1);
    // 4) generating — не трогать
    const running = seedCarousel(userId, 'generating');
    startGenerationHold(running, userId, 2);

    const res = reconcileCarouselHolds();
    expect(res.released).toBe(1);
    expect(res.settled).toBe(1);
    expect(res.autoAccepted).toBe(1);
    expect(openHoldForProject(orphan)).toBeUndefined();
    expect(openHoldForProject(alive)).toBeDefined();
    expect(openHoldForProject(expired)).toBeUndefined();
    expect(openHoldForProject(running)).toBeDefined();
    const expiredRow = getDb()
      .prepare(`SELECT status FROM carousel_projects WHERE id=?`)
      .get(expired) as { status: string };
    expect(expiredRow.status).toBe('done');
    const acceptedSlide = getDb()
      .prepare(`SELECT status, accepted FROM carousel_slides WHERE carousel_id=? AND idx=2`)
      .get(expired) as { status: string; accepted: number };
    expect(acceptedSlide).toEqual({ status: 'done', accepted: 1 });
  });

  it('autoAcceptReview идемпотентен по деньгам (повторный вызов не создаёт второй charge)', () => {
    const carouselId = seedCarousel(userId, 'qc_review');
    startGenerationHold(carouselId, userId, 2);
    const s1 = seedSlide(carouselId, 1, 'needs_review');
    seedUsage(carouselId, s1, 0.1);
    autoAcceptReview(carouselId);
    autoAcceptReview(carouselId);
    const charges = getDb()
      .prepare(`SELECT COUNT(*) AS c FROM credit_ledger WHERE user_id=? AND kind='charge'`)
      .get(userId) as { c: number };
    expect(charges.c).toBe(1);
  });
});
