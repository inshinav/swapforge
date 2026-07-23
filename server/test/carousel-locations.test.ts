// LocationPack Miami: каждая сцена проходит zod (id/имя/EN-блок/форматы), реестр работает.
import { describe, expect, it } from 'vitest';
import {
  getLocationPack,
  getScene,
  listLocationPacks,
  LocationPackZ,
  MIAMI_PACK,
} from '../src/engine/carousel/locations';

describe('carousel: LocationPack Miami', () => {
  it('весь пак валиден по zod и содержит 12 сцен с уникальными id', () => {
    expect(() => LocationPackZ.parse(MIAMI_PACK)).not.toThrow();
    expect(MIAMI_PACK.scenes).toHaveLength(12);
    expect(new Set(MIAMI_PACK.scenes.map((s) => s.id)).size).toBe(12);
  });

  it('каждый promptBlock — EN-описание с местом/светом/фактурой, без кириллицы', () => {
    for (const scene of MIAMI_PACK.scenes) {
      expect(scene.promptBlock).toMatch(/^[\x20-\x7E]+$/);
      expect(scene.promptBlock.length).toBeGreaterThan(80);
      expect(scene.promptBlock.toLowerCase()).toContain('miami');
    }
  });

  it('реестр: getLocationPack/getScene/listLocationPacks', () => {
    expect(getLocationPack('miami')?.name).toBe('Майами');
    expect(getLocationPack('tokyo')).toBeNull();
    expect(getScene('miami', 'wynwood-murals')?.name).toBe('Муралы Wynwood');
    expect(getScene('miami', 'nope')).toBeNull();
    expect(listLocationPacks().map((p) => p.id)).toEqual(['miami']);
  });
});
