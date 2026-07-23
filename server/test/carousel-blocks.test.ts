// Библиотека промт-блоков: дословная фиксация снапшотами + структурные инварианты (SPEC §2).
import { describe, expect, it } from 'vitest';
import {
  ANTI_ARTIFACT_GUARDRAILS,
  BLOCKS_VERSION,
  buildAnchorBlock,
  buildIdentityBlock,
  buildProductBlock,
  carouselModerationLadder,
  formatBlock,
  UGC_PRESETS,
} from '../src/engine/carousel/blocks';

describe('carousel: промт-блоки', () => {
  it('дословный текст блоков зафиксирован (менять только с BLOCKS_VERSION+1)', () => {
    expect(BLOCKS_VERSION).toBe(2);
    expect({
      UGC_PRESETS,
      ANTI_ARTIFACT_GUARDRAILS,
      identity1: buildIdentityBlock('Tall redhead, CAPS: burn scar on left wrist.', 1),
      identity2: buildIdentityBlock('', 2),
      anchor: buildAnchorBlock(3),
      product: buildProductBlock(4, 'White Kawasaki ZX-6R.'),
      format45: formatBlock('4:5'),
      format11: formatBlock('1:1'),
    }).toMatchSnapshot();
  });

  it('каждый пресет — UGC-телефонник без студии/вотермарок; интенсивность различна', () => {
    for (const text of Object.values(UGC_PRESETS)) {
      expect(text.toLowerCase()).toMatch(/iphone|phone/);
      expect(text).toContain('no watermark, no text overlay');
    }
    expect(UGC_PRESETS.raw).toContain('visible pores');
    expect(UGC_PRESETS.polished).not.toContain('motion blur');
    expect(new Set(Object.values(UGC_PRESETS)).size).toBe(3);
  });

  it('identity-блок: нумерация 1..N и нота дословно', () => {
    const one = buildIdentityBlock('Note here.', 1);
    expect(one).toContain('Reference image 1 is the identity');
    expect(one).toContain('Note here.');
    const two = buildIdentityBlock('X', 2);
    expect(two).toContain('Reference images 1-2');
  });

  it('лестница модерации: тиры реально меняют промт и не трогают чужой текст', () => {
    const prompt = [
      buildIdentityBlock('Freckles everywhere.', 2),
      UGC_PRESETS.casual,
      ANTI_ARTIFACT_GUARDRAILS,
    ].join(' ');
    const ladder = carouselModerationLadder(prompt);
    expect(ladder.length).toBe(3);
    expect(ladder[0]).toBe(prompt);
    expect(ladder[1]).toContain('Natural realistic appearance');
    expect(ladder[1]).not.toContain('no beauty retouch');
    expect(ladder[2]).toContain('match the person exactly');
    // Гардрейлы и нота не пострадали ни на одном тире.
    for (const step of ladder) {
      expect(step).toContain('Freckles everywhere.');
      expect(step).toContain(ANTI_ARTIFACT_GUARDRAILS);
    }
  });

  it('лестница на промте без матчей = один шаг (исходник)', () => {
    expect(carouselModerationLadder('plain scene text')).toEqual(['plain scene text']);
  });
});
