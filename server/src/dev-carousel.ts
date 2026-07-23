// Дев-энтрипоинт Carousel Studio (tsx watch): полный E2E-цикл БЕЗ трат и БЕЗ API-ключей —
// image-провайдер mock, LLM-движки/QC подменены детерминированным фейком.
// В прод-бандл не попадает (esbuild собирает src/index.ts); флаги только на этот процесс.
process.env.AUTH_DEV_BYPASS ??= '1';
process.env.CAROUSEL_STUDIO ??= '1';
process.env.CAROUSEL_IMAGE_PROVIDER ??= 'mock';
process.env.PRICING_OVERRIDES ??= JSON.stringify({
  'gpt-image-2': { inPerM: 10, outPerM: 40 },
  'gpt-5.6-luna': { inPerM: 2, outPerM: 8 },
  'gpt-5.6-terra': { inPerM: 0.5, outPerM: 2 },
});

const { setCarouselLlmForTests } = await import('./engine/carousel/engines');
const { recordUsage } = await import('./usage');

const IDEA = (n: number) => ({
  title: `Дев-идея №${n}: утро в Майами`,
  hook: 'Проснулась — а за окном океан',
  concept: 'Пляж на рассвете, кофе в летнем кафе, прогулка по променаду. Живой день из жизни.',
  slideCount: 3,
  sceneIds: ['south-beach-sand', 'open-air-cafe', 'boardwalk-golden-hour'],
  ugcPreset: 'casual',
});

setCarouselLlmForTests({
  name: () => 'dev-mock',
  async structured(req) {
    recordUsage({
      projectId: req.meta?.projectId ?? req.meta?.carouselId,
      generationId: req.meta?.generationId,
      userId: req.meta?.userId,
      task: req.schemaName,
      model: 'gpt-5.6-luna',
      tokensIn: 500,
      tokensOut: 500,
    });
    await new Promise((r) => setTimeout(r, 400)); // видимая задержка для UI
    if (req.schemaName === 'carousel_idea') return { ideas: [IDEA(1), IDEA(2), IDEA(3)] };
    if (req.schemaName === 'carousel_storyboard') {
      return {
        slides: [
          { idx: 1, role: 'hook', sceneId: 'south-beach-sand', action: 'walking out of the ocean, laughing', outfit: 'white linen dress', camera: 'friend POV a few steps away', useProductRef: false },
          { idx: 2, role: 'context', sceneId: 'open-air-cafe', action: 'sipping iced coffee', outfit: 'white linen dress', camera: 'across-the-table candid', useProductRef: false },
          { idx: 3, role: 'payoff', sceneId: 'boardwalk-golden-hour', action: 'looking back over shoulder into sunset', outfit: 'white linen dress', camera: 'arm-length selfie', useProductRef: false },
        ],
        anchorNote: 'lock white dress, loose hair, warm daylight grade',
      };
    }
    if (req.schemaName === 'carousel_caption') {
      return {
        caption: 'tuesday reset: ocean, iced latte, zero plans.\n\nsave this if you need a sign to book the ticket 🌴',
        hashtags: ['#miami', '#beachlife', '#morningroutine', '#saltair', '#goldenhour', '#oceanview', '#slowliving', '#travelgirl', '#sunset', '#vibes', '#reset'],
        hookLine: 'tuesday reset: ocean edition',
      };
    }
    if (req.schemaName === 'carousel_qc') {
      return { identity: 9, artifacts: 8, realism: 8, sceneMatch: true, notes: 'dev mock pass' };
    }
    if (req.schemaName === 'carousel_discover') {
      return {
        themes: [
          { label: 'Мото-девушка', hashtags: ['bikerlifestyle', 'motogirl'] },
          { label: 'Пляж Майами', hashtags: ['miamibeach', 'beachmodel'] },
          { label: 'Спортзал', hashtags: ['gymgirl', 'fitmodel'] },
        ],
      };
    }
    if (req.schemaName === 'carousel_pattern') {
      return {
        hookType: 'mid-action candid',
        slideCount: 4,
        slideRoles: ['hook', 'context', 'payoff', 'cta'],
        composition: ['tight crop'],
        captionStyle: 'hook → story → CTA',
        whyItWorks: 'relatable moment',
        nicheTags: ['lifestyle'],
      };
    }
    throw new Error(`dev-mock: неожиданный schemaName ${req.schemaName}`);
  },
});

console.log('[dev-carousel] Carousel Studio E2E-режим: image=mock, LLM=dev-mock, трат нет');
await import('./index');

export {};
