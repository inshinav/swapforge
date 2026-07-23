// Прайсинг карусели (SPEC §7): carousel-модель ОБЯЗАНА проходить litellm-фильтр
// (иначе settle 0), смета детерминирована и растёт со slide_count, идеация — центы.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-carousel-pricing-'));
// Отдельная carousel-модель, чтобы доказать её независимое попадание в фильтр манифеста.
process.env.CAROUSEL_IMAGE_MODEL = 'test-carousel-img';

const { _resetPricingMemory, ensureLitellmFresh, priceForCached, taskModel } = await import(
  '../src/pricing'
);
const { buildCarouselQuote, buildIdeationQuote } = await import('../src/engine/carousel/pricing');
const { config } = await import('../src/config');

const MANIFEST: Record<string, { input_cost_per_token: number; output_cost_per_token: number }> = {
  'test-carousel-img': { input_cost_per_token: 10e-6, output_cost_per_token: 40e-6 },
  'gpt-image-2': { input_cost_per_token: 10e-6, output_cost_per_token: 40e-6 },
  'gpt-5.6-luna': { input_cost_per_token: 2e-6, output_cost_per_token: 8e-6 },
  'gpt-5.6-terra': { input_cost_per_token: 0.5e-6, output_cost_per_token: 2e-6 },
  'gpt-5.5': { input_cost_per_token: 1e-6, output_cost_per_token: 4e-6 },
  'gpt-5.4-mini': { input_cost_per_token: 0.2e-6, output_cost_per_token: 0.8e-6 },
};

const fakeFetch = (async () =>
  new Response(JSON.stringify(MANIFEST), { status: 200 })) as unknown as typeof fetch;

describe('carousel: прайсинг', () => {
  it('carousel-модель проходит фильтр манифеста: priceForCached не null', async () => {
    _resetPricingMemory();
    await ensureLitellmFresh(fakeFetch);
    expect(config.carouselImageModel).toBe('test-carousel-img');
    expect(priceForCached('test-carousel-img')).not.toBeNull();
  });

  it('маппинг задач: слайд → carousel-модель, QC → analyze-tier, идеация → generate-tier', () => {
    expect(taskModel('carousel_slide')).toBe('test-carousel-img');
    expect(taskModel('carousel_qc')).toBe('gpt-5.6-terra');
    expect(taskModel('carousel_idea')).toBe('gpt-5.6-luna');
    expect(taskModel('carousel_storyboard')).toBe('gpt-5.6-luna');
    expect(taskModel('carousel_caption')).toBe('gpt-5.6-luna');
  });

  it('смета детерминирована по сид-токенам и растёт со slide_count', async () => {
    _resetPricingMemory();
    await ensureLitellmFresh(fakeFetch);
    const q4 = buildCarouselQuote(4);
    const q8 = buildCarouselQuote(8);
    expect(q4.totalUsd).not.toBeNull();
    expect(q8.totalUsd!).toBeGreaterThan(q4.totalUsd!);
    expect(q4.approximate).toBe(true); // истории прогонов нет — сид-эмпирика
    // Ручная сверка слайдовой строки: (3400×10 + 5700×40)/1e6 = 0.262 $/слайд.
    const slideRow = q4.rows.find((r) => r.task === 'carousel_slide')!;
    expect(slideRow.count).toBe(4);
    expect(slideRow.usdEach).toBeCloseTo(0.262, 3);
  });

  it('идеация — центы; отсутствие тарифа → totalUsd null (не 0!)', async () => {
    _resetPricingMemory();
    await ensureLitellmFresh(fakeFetch);
    const idea = buildIdeationQuote('carousel_idea');
    expect(idea.totalUsd).not.toBeNull();
    expect(idea.totalUsd!).toBeLessThan(0.05);

    // Манифест без carousel-модели → смета честно null, никакого «бесплатно».
    _resetPricingMemory();
    const withoutCarousel = Object.fromEntries(
      Object.entries(MANIFEST).filter(([m]) => m !== 'test-carousel-img'),
    );
    const partialFetch = (async () =>
      new Response(JSON.stringify(withoutCarousel), { status: 200 })) as unknown as typeof fetch;
    // Кэш в БД уже содержит полный манифест — подменяем свежей выборкой без модели.
    await ensureLitellmFresh(partialFetch);
    const q = buildCarouselQuote(4);
    expect(q.totalUsd).toBeNull();
  });
});
