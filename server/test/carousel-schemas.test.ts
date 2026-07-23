// Carousel Studio: zod-схемы движков валидируют фикстуры и отклоняют брак;
// JSON Schema (strict) синхронна с zod по обязательным ключам (SPEC §4/§5/§7).
import { describe, expect, it } from 'vitest';
import {
  CAROUSEL_TASKS,
  CAPTION_JSON_SCHEMA,
  CaptionZ,
  CarouselIdeasZ,
  IDEAS_JSON_SCHEMA,
  PATTERN_CARD_JSON_SCHEMA,
  PatternCardStructureZ,
  QC_JSON_SCHEMA,
  QcVerdictZ,
  STORYBOARD_JSON_SCHEMA,
  StoryboardZ,
} from '../../shared/carousel';

const idea = {
  title: 'Утро в Майами',
  hook: 'Проснулась — а за окном океан',
  concept: 'Девушка показывает своё утро: пляж, кофе, прогулка по Ocean Drive.',
  slideCount: 5,
  sceneIds: ['south-beach-sand', 'open-air-cafe'],
  ugcPreset: 'casual',
};

const storyboard = {
  slides: [
    {
      idx: 1,
      role: 'hook',
      sceneId: 'south-beach-sand',
      action: 'walking toward camera, laughing',
      outfit: 'white linen dress',
      camera: 'phone selfie arm length',
      useProductRef: false,
    },
    {
      idx: 2,
      role: 'payoff',
      sceneId: 'open-air-cafe',
      action: 'sipping iced coffee',
      outfit: 'same white linen dress',
      camera: 'friend POV across table',
      useProductRef: false,
    },
  ],
  anchorNote: 'lock outfit, hair, daylight color grade',
};

describe('carousel: схемы движков', () => {
  it('валидные фикстуры проходят', () => {
    expect(CarouselIdeasZ.parse({ ideas: [idea, idea, idea] }).ideas).toHaveLength(3);
    expect(StoryboardZ.parse(storyboard).slides[0]?.role).toBe('hook');
    expect(
      CaptionZ.parse({
        caption: 'morning in miami…',
        hashtags: Array.from({ length: 12 }, (_, i) => `#tag${i}`),
        hookLine: 'you woke up here',
      }).hashtags,
    ).toHaveLength(12);
    expect(
      QcVerdictZ.parse({ identity: 8, artifacts: 7, realism: 9, sceneMatch: true, notes: 'ok' })
        .identity,
    ).toBe(8);
    expect(
      PatternCardStructureZ.parse({
        hookType: 'bold text question',
        slideCount: 7,
        slideRoles: ['hook', 'context'],
        composition: ['tight crop faces'],
        captionStyle: 'hook → story → CTA',
        whyItWorks: 'curiosity gap',
        nicheTags: ['lifestyle'],
      }).slideCount,
    ).toBe(7);
  });

  it('брак отклоняется: slideCount вне 2..10, неизвестный пресет/роль, мало хэштегов, скор вне 0..10', () => {
    expect(CarouselIdeasZ.safeParse({ ideas: [{ ...idea, slideCount: 1 }, idea, idea] }).success).toBe(false);
    expect(CarouselIdeasZ.safeParse({ ideas: [{ ...idea, ugcPreset: 'studio' }, idea, idea] }).success).toBe(false);
    expect(
      StoryboardZ.safeParse({
        ...storyboard,
        slides: [{ ...storyboard.slides[0], role: 'intro' }, storyboard.slides[1]],
      }).success,
    ).toBe(false);
    expect(
      CaptionZ.safeParse({ caption: 'x', hashtags: ['#one'], hookLine: 'y' }).success,
    ).toBe(false);
    expect(
      QcVerdictZ.safeParse({ identity: 11, artifacts: 7, realism: 9, sceneMatch: true, notes: '' })
        .success,
    ).toBe(false);
  });

  it('JSON Schema strict: required == все ключи zod-объекта, additionalProperties=false', () => {
    const cases: Array<[Record<string, unknown>, string[]]> = [
      [IDEAS_JSON_SCHEMA, ['ideas']],
      [STORYBOARD_JSON_SCHEMA, ['slides', 'anchorNote']],
      [CAPTION_JSON_SCHEMA, ['caption', 'hashtags', 'hookLine']],
      [QC_JSON_SCHEMA, ['identity', 'artifacts', 'realism', 'sceneMatch', 'notes']],
      [
        PATTERN_CARD_JSON_SCHEMA,
        ['hookType', 'slideCount', 'slideRoles', 'composition', 'captionStyle', 'whyItWorks', 'nicheTags'],
      ],
    ];
    for (const [schema, keys] of cases) {
      expect(schema.required).toEqual(keys);
      expect(schema.additionalProperties).toBe(false);
    }
  });

  it('таблица имён задач: пять уникальных carousel_*-имён', () => {
    const values = Object.values(CAROUSEL_TASKS);
    expect(values).toHaveLength(5);
    expect(new Set(values).size).toBe(5);
    for (const v of values) expect(v).toMatch(/^carousel_[a-z]+$/);
  });
});
