// ImageProvider: селектор по config, мок детерминирован, PNG валиден, маркер модерации работает.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-image-provider-'));
process.env.CAROUSEL_IMAGE_PROVIDER = 'mock';

const { getImageProvider, setImageProviderForTests } = await import('../src/image/provider');
const { MOCK_MODERATION_MARKER, mockImageProvider } = await import('../src/image/mock');

// Референс на диске для toFile-стримов openai-провайдера.
const refPath = path.join(process.env.DATA_DIR!, 'ref.png');
fs.writeFileSync(
  refPath,
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  ),
);

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

  it('openai: happy path — b64, usage-строка с carousel-scope атрибуцией', async () => {
    const { createOpenaiImageProvider } = await import('../src/image/openai');
    const { getDb } = await import('../src/db');
    const calls: Array<Record<string, unknown>> = [];
    const provider = createOpenaiImageProvider(async (p) => {
      calls.push(p);
      return { data: [{ b64_json: 'QUJD' }], usage: { input_tokens: 10, output_tokens: 4000 } };
    });
    const res = await provider.edit({ ...req, imagePaths: [refPath], meta: { carouselId: 'car-1', userId: 'usr-1', slideId: 'sl-1' } });
    expect(res.b64).toBe('QUJD');
    expect(res.moderated).toBeUndefined();
    expect(calls[0]?.input_fidelity).toBe('high');
    const row = getDb()
      .prepare(`SELECT project_id, generation_id, user_id, task FROM usage_events WHERE project_id='car-1'`)
      .get() as { project_id: string; generation_id: string; user_id: string; task: string };
    expect(row).toEqual({ project_id: 'car-1', generation_id: 'sl-1', user_id: 'usr-1', task: 'carousel_slide' });
  });

  it('openai: фолбэк без input_fidelity для модели без параметра', async () => {
    const { createOpenaiImageProvider } = await import('../src/image/openai');
    const calls: Array<Record<string, unknown>> = [];
    const provider = createOpenaiImageProvider(async (p) => {
      calls.push(p);
      if ('input_fidelity' in p) throw new Error('Unknown parameter: input_fidelity');
      return { data: [{ b64_json: 'QUJD' }], usage: {} };
    });
    const res = await provider.edit({ ...req, imagePaths: [refPath] });
    expect(res.b64).toBe('QUJD');
    expect(calls).toHaveLength(2);
    expect('input_fidelity' in calls[1]!).toBe(false);
  });

  it('openai: лестница модерации — смягчённый промт проходит; полный отказ → moderated', async () => {
    const { createOpenaiImageProvider } = await import('../src/image/openai');
    const { UGC_PRESETS } = await import('../src/engine/carousel/blocks');
    const seen: string[] = [];
    const softening = createOpenaiImageProvider(async (p) => {
      seen.push(String(p.prompt));
      if (String(p.prompt).includes('no beauty retouch')) throw new Error('rejected by content policy');
      return { data: [{ b64_json: 'QUJD' }], usage: {} };
    });
    const res = await softening.edit({ ...req, prompt: `scene ${UGC_PRESETS.casual}`, imagePaths: [refPath] });
    expect(res.moderated).toBeUndefined();
    expect(seen.length).toBeGreaterThan(1);

    const alwaysRefuse = createOpenaiImageProvider(async () => {
      throw new Error('moderation blocked');
    });
    const blocked = await alwaysRefuse.edit({ ...req, prompt: `scene ${UGC_PRESETS.casual}`, imagePaths: [refPath] });
    expect(blocked.moderated).toBe(true);
    expect(blocked.b64).toBe('');
  });

  it('openai: не-модерационная ошибка пробрасывается по-русски', async () => {
    const { createOpenaiImageProvider } = await import('../src/image/openai');
    const provider = createOpenaiImageProvider(async () => {
      throw new Error('connection reset');
    });
    await expect(provider.edit({ ...req, imagePaths: [refPath] })).rejects.toThrow(/Images API/);
  });

  it('effectiveSlideSize: гибкой модели — как есть, негибкой — фикс-тройка', async () => {
    const { effectiveSlideSize } = await import('../src/image/openai');
    expect(effectiveSlideSize('1024x1280', 'gpt-image-2')).toBe('1024x1280');
    expect(effectiveSlideSize('1024x1280', 'gpt-image-1')).toBe('1024x1536');
    expect(effectiveSlideSize('1024x1024', 'gpt-image-1')).toBe('1024x1024');
    expect(effectiveSlideSize('1280x1024', 'gpt-image-1')).toBe('1536x1024');
  });
});
