// QC слайда: пороговая логика (границы), vision-вызов с обязательной carousel-метой,
// невалидный JSON от LLM отклоняется zod'ом.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-carousel-qc-'));
// Пороговые дефолты фиксируем явно — тест границ не должен зависеть от чужого env.
process.env.CAROUSEL_QC_IDENTITY_MIN = '7';
process.env.CAROUSEL_QC_ARTIFACTS_MIN = '6';
process.env.CAROUSEL_QC_REALISM_MIN = '6';

const { qcPasses, runSlideQc, QC_SYSTEM } = await import('../src/engine/carousel/qc');
import type { StructuredRequest } from '../src/llm/provider';

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const slidePath = path.join(process.env.DATA_DIR!, 'slide.png');
const refPath = path.join(process.env.DATA_DIR!, 'ref.jpg');
fs.writeFileSync(slidePath, PIXEL);
fs.writeFileSync(refPath, PIXEL);

const base = { identity: 7, artifacts: 6, realism: 6, sceneMatch: true, notes: '' };

describe('carousel: QC', () => {
  it('пороги: ровно на границе — pass, на единицу ниже по любой оси — fail; sceneMatch не гейтит', () => {
    expect(qcPasses(base)).toBe(true);
    expect(qcPasses({ ...base, identity: 6.5 })).toBe(false);
    expect(qcPasses({ ...base, artifacts: 5 })).toBe(false);
    expect(qcPasses({ ...base, realism: 5.9 })).toBe(false);
    expect(qcPasses({ ...base, sceneMatch: false })).toBe(true);
  });

  it('runSlideQc: собирает слайд+рефы, шлёт carousel-мету, парсит вердикт', async () => {
    let captured: StructuredRequest | null = null;
    const verdict = await runSlideQc(
      {
        slideImagePath: slidePath,
        identityRefPaths: [refPath, refPath],
        sceneDescription: 'walking on South Beach sand',
        carouselId: 'car-9',
        userId: 'usr-9',
        slideId: 'sl-9',
      },
      {
        name: () => 'fake',
        async structured(req) {
          captured = req;
          return { identity: 8, artifacts: 7, realism: 9, sceneMatch: true, notes: 'ok' };
        },
      },
    );
    expect(verdict.identity).toBe(8);
    const req = captured!;
    expect(req.system).toBe(QC_SYSTEM);
    expect(req.schemaName).toBe('carousel_qc');
    expect(req.meta).toEqual({ carouselId: 'car-9', userId: 'usr-9', generationId: 'sl-9' });
    const images = req.parts.filter((p) => p.type === 'image');
    expect(images).toHaveLength(3);
    expect(images[0]).toMatchObject({ detail: 'high', mime: 'image/png' });
    expect(images[1]).toMatchObject({ detail: 'low', mime: 'image/jpeg' });
  });

  it('битый ответ LLM отклоняется zod-схемой', async () => {
    await expect(
      runSlideQc(
        {
          slideImagePath: slidePath,
          identityRefPaths: [refPath],
          sceneDescription: 'x',
          carouselId: 'c',
          userId: 'u',
          slideId: 's',
        },
        {
          name: () => 'fake',
          async structured() {
            return { identity: 15, artifacts: -1 };
          },
        },
      ),
    ).rejects.toThrow();
  });
});
