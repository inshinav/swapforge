// ImageProvider: селектор по config, мок детерминирован, PNG валиден, маркер модерации работает.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-image-provider-'));
process.env.CAROUSEL_IMAGE_PROVIDER = 'mock';

const { getImageProvider, setImageProviderForTests } = await import('../src/image/provider');
const { MOCK_MODERATION_MARKER, mockImageProvider } = await import('../src/image/mock');

const req = {
  prompt: 'candid phone photo, girl on South Beach',
  imagePaths: [],
  size: '1024x1280',
  quality: 'high',
  meta: { carouselId: 'c1', userId: 'u1', slideId: 's1' },
};

describe('carousel: ImageProvider', () => {
  it('селектор отдаёт мок при CAROUSEL_IMAGE_PROVIDER=mock и кэширует синглтон', async () => {
    setImageProviderForTests(null);
    const p1 = await getImageProvider();
    const p2 = await getImageProvider();
    expect(p1.name()).toBe('mock');
    expect(p2).toBe(p1);
  });

  it('мок возвращает валидный PNG и фиксированные токены', async () => {
    const res = await mockImageProvider.edit(req);
    expect(res.moderated).toBeUndefined();
    expect(res.tokensOut).toBeGreaterThan(0);
    const png = Buffer.from(res.b64, 'base64');
    // PNG magic: 89 50 4E 47
    expect(png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it('маркер модерации переводит ответ в moderated', async () => {
    const res = await mockImageProvider.edit({
      ...req,
      prompt: `x ${MOCK_MODERATION_MARKER}`,
    });
    expect(res.moderated).toBe(true);
    expect(res.b64).toBe('');
  });

  it('openai-заглушка падает с понятной ошибкой до P1.4', async () => {
    setImageProviderForTests(null);
    const { openaiImageProvider } = await import('../src/image/openai');
    await expect(openaiImageProvider.edit(req)).rejects.toThrow(/P1\.4/);
    setImageProviderForTests(null);
  });
});
