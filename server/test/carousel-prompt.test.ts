// Сборщик промта слайда: порядок блоков, нумерация рефов, снапшот, мягкий кап (SPEC §2).
import { describe, expect, it, vi } from 'vitest';
import { buildSlidePrompt, SLIDE_PROMPT_SOFT_MAX_WORDS, wordCount } from '../src/engine/carousel/prompt';
import { getScene } from '../src/engine/carousel/locations';
import type { StoryboardSlide } from '../../shared/carousel';

const scene = getScene('miami', 'south-beach-sand');
if (!scene) throw new Error('нет сцены south-beach-sand');

const slide: StoryboardSlide = {
  idx: 2,
  role: 'context',
  sceneId: scene.id,
  action: 'walking along the waterline, looking back over her shoulder',
  outfit: 'white linen dress, straw hat',
  camera: 'candid phone photo taken by a friend a few steps behind',
  useProductRef: false,
    propNote: '',
};

describe('carousel: сборщик промта', () => {
  it('якорный слайд: identity без anchor-блока; снапшот', () => {
    const p = buildSlidePrompt({
      slide: { ...slide, idx: 1, role: 'hook' },
      scene,
      modelNote: 'Redhead, green eyes. ALWAYS KEEP: thin gold chain.',
      identityRefCount: 2,
      ugcPreset: 'casual',
      aspect: '4:5',
    });
    expect(p).toContain('Reference images 1-2 are the identity');
    expect(p).not.toContain('previous slide');
    expect(p).toMatchSnapshot();
  });

  it('слайд 2..N: anchor и product с правильными номерами, порядок блоков стабилен', () => {
    const p = buildSlidePrompt({
      slide: { ...slide, useProductRef: true },
      scene,
      modelNote: 'Note.',
      identityRefCount: 2,
      ugcPreset: 'raw',
      aspect: '4:5',
      anchorRefIndex: 3,
      productRefIndex: 4,
      productNote: 'White Kawasaki ZX-6R.',
    });
    const iIdentity = p.indexOf('Reference images 1-2');
    const iAnchor = p.indexOf('Reference image 3 is the previous slide');
    const iProduct = p.indexOf('Reference image 4 is a product');
    const iScene = p.indexOf('walking along the waterline');
    const iGuard = p.indexOf('Anatomically correct hands');
    expect(iIdentity).toBeGreaterThanOrEqual(0);
    expect(iAnchor).toBeGreaterThan(iIdentity);
    expect(iProduct).toBeGreaterThan(iAnchor);
    expect(iScene).toBeGreaterThan(iProduct);
    expect(iGuard).toBeGreaterThan(iScene);
    expect(p).toContain('White Kawasaki ZX-6R.');
  });

  it('пустые action/outfit/camera не ломают промт', () => {
    const p = buildSlidePrompt({
      slide: { ...slide, action: '', outfit: '', camera: '' },
      scene,
      modelNote: '',
      identityRefCount: 1,
      ugcPreset: 'polished',
      aspect: '1:1',
    });
    expect(p).toContain('The person is present in the scene.');
    expect(p).toContain('Square 1:1 framing');
    expect(p).not.toContain('Wearing');
  });

  it('типовой промт укладывается в мягкий кап; перебор только предупреждает', () => {
    const typical = buildSlidePrompt({
      slide,
      scene,
      modelNote: 'Tall redhead, green eyes, freckles. ALWAYS KEEP: thin gold chain, small tattoo on wrist.',
      identityRefCount: 2,
      ugcPreset: 'raw',
      aspect: '4:5',
      anchorRefIndex: 3,
    });
    expect(wordCount(typical)).toBeLessThan(SLIDE_PROMPT_SOFT_MAX_WORDS);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bloated = buildSlidePrompt({
      slide: { ...slide, action: 'word '.repeat(300).trim() },
      scene,
      modelNote: '',
      identityRefCount: 1,
      ugcPreset: 'casual',
      aspect: '4:5',
    });
    expect(wordCount(bloated)).toBeGreaterThan(SLIDE_PROMPT_SOFT_MAX_WORDS);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
