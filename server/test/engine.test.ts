import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// БД в темп-каталог ДО импорта модулей, читающих config
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-test-'));
process.env.OPENAI_MODEL_ANALYZE = 'override-model';

const { reduceAspect, rotationOf } = await import('../src/ffmpeg');
const { modelChainFor } = await import('../src/config');
const { parseJsonLoose } = await import('../src/llm/provider');
const { jaccard, findSimilarWorked } = await import('../src/engine/similar');
const { buildManifestText, buildSeedanceParams, buildGenerationRequest } = await import(
  '../src/engine/generate'
);
const { DOCTRINE_SYSTEM } = await import('../src/engine/doctrine');
const { getDb } = await import('../src/db');
const { ARTIFACTS, ARTIFACT_TYPES } = await import('../../shared/taxonomy');
const { ANALYSIS_JSON_SCHEMA, AnalysisZ } = await import('../../shared/analysis');

import type { Analysis } from '../../shared/analysis';
import type { RefInfo, VideoMeta } from '../../shared/api-types';

const META: VideoMeta = {
  durationSec: 9.5,
  width: 1080,
  height: 1920,
  fps: 30,
  aspect: '9:16',
  sizeBytes: 12_000_000,
};

const REFS: RefInfo[] = [
  { id: 'r1', idx: 0, role: 'model', file: 'ref_a.jpg', note: 'чёрная кожаная куртка' },
  { id: 'r2', idx: 1, role: 'vehicle', file: 'ref_b.jpg', note: '' },
];

const ANALYSIS: Analysis = {
  storyboard: [
    { index: 0, startSec: 0, endSec: 9.5, camera: 'low tracking, forward dolly', action: 'riding', framing: 'full body' },
  ],
  world: {
    location: 'night city street',
    timeOfDay: 'night',
    light: 'neon storefronts, cool blue',
    weather: 'after rain',
    background: ['neon signs', 'parked cars'],
    reflections: ['puddles'],
    surfaces: ['wet asphalt'],
    overlayText: [],
  },
  subjects: [
    { kind: 'person', description: 'rider', pose: 'leaning forward', contact: ['hands on grips'], prominence: 'main' },
  ],
  risks: [
    {
      moment: 'push-in @3s',
      artifactType: 'identity_bleed',
      why: 'лицо крупно',
      suppressorLine: 'Match the face exactly during the push-in at 3s.',
    },
  ],
  startFrame: {
    description: 'rider centered on wet street',
    composition: 'center, full body',
    subjectPlacement: 'center third',
    lightNote: 'neon from left',
  },
  tags: ['night city', 'neon', 'motorcycle', 'tracking shot', 'wet asphalt'],
};

describe('reduceAspect', () => {
  it('стандартные разрешения', () => {
    expect(reduceAspect(1080, 1920)).toBe('9:16');
    expect(reduceAspect(1920, 1080)).toBe('16:9');
    expect(reduceAspect(1000, 1000)).toBe('1:1');
  });
  it('экзотика прижимается к ближайшему стандарту при <3% ошибки', () => {
    expect(reduceAspect(1088, 1920)).toBe('9:16');
  });
});

describe('rotationOf (iPhone rotation-мета)', () => {
  it('side_data_list.rotation в приоритете', () => {
    expect(rotationOf({ side_data_list: [{ rotation: -90 }] })).toBe(270);
    expect(rotationOf({ side_data_list: [{ rotation: 90 }], tags: { rotate: '0' } })).toBe(90);
  });
  it('фолбэк на tags.rotate; отсутствие меты = 0', () => {
    expect(rotationOf({ tags: { rotate: '180' } })).toBe(180);
    expect(rotationOf({})).toBe(0);
    expect(rotationOf({ tags: { rotate: 'мусор' } })).toBe(0);
  });
});

describe('startFrameSize (2K под AR, кратно 16)', () => {
  it('gpt-image-2: гибкие размеры — портрет/ландшафт/квадрат', async () => {
    const { startFrameSize } = await import('../src/engine/startframe');
    expect(startFrameSize(1080, 1920, 'gpt-image-2')).toBe('1152x2048');
    expect(startFrameSize(1920, 1080, 'gpt-image-2')).toBe('2048x1152');
    expect(startFrameSize(1000, 1000, 'gpt-image-2')).toBe('2048x2048');
    const [w, h] = startFrameSize(1088, 1920, 'gpt-image-2').split('x').map(Number);
    expect(w! % 16).toBe(0);
    expect(h! % 16).toBe(0);
  });
  it('gpt-image-1/1.5/mini: только фиксированная тройка', async () => {
    const { startFrameSize } = await import('../src/engine/startframe');
    expect(startFrameSize(1080, 1920, 'gpt-image-1.5')).toBe('1024x1536');
    expect(startFrameSize(1920, 1080, 'gpt-image-1-mini')).toBe('1536x1024');
    expect(startFrameSize(1000, 1000, 'gpt-image-1')).toBe('1024x1024');
  });
});

describe('modelChainFor (авто-роутинг с фолбэками)', () => {
  it('дефолтные цепочки: дешёвый tier на анализ, топ на промты, фолбэки в хвосте', () => {
    expect(modelChainFor('generate')).toEqual(['gpt-5.6-luna', 'gpt-5.5']);
  });
  it('env-переопределение ставит модель первой, дефолты остаются фолбэками', () => {
    expect(modelChainFor('analyze')).toEqual([
      'override-model',
      'gpt-5.6-terra',
      'gpt-5.4-mini',
      'gpt-5.5',
    ]);
  });
});

describe('parseJsonLoose', () => {
  it('снимает markdown-заборы', () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('вырезает JSON из мусора', () => {
    expect(parseJsonLoose('вот ответ: {"a":1} готово')).toEqual({ a: 1 });
  });
});

describe('таксономия и схемы', () => {
  it('5 типов артефактов с фиксами', () => {
    expect(ARTIFACT_TYPES).toHaveLength(5);
    for (const t of ARTIFACT_TYPES) {
      expect(ARTIFACTS[t].fix.length).toBeGreaterThan(40);
      expect(ARTIFACTS[t].ru).toBeTruthy();
    }
  });
  it('JSON Schema строгая: все ключи required, additionalProperties: false', () => {
    const s = ANALYSIS_JSON_SCHEMA as { required: string[]; additionalProperties: boolean; properties: Record<string, unknown> };
    expect(s.additionalProperties).toBe(false);
    expect(s.required.sort()).toEqual(Object.keys(s.properties).sort());
  });
  it('фикстура анализа проходит zod', () => {
    expect(AnalysisZ.safeParse(ANALYSIS).success).toBe(true);
  });
});

describe('манифест и параметры', () => {
  it('старт-кадр всегда №1, рефы со сдвигом +2', () => {
    const m = buildManifestText(REFS);
    expect(m).toMatch(/^1\. START FRAME/);
    expect(m).toContain('2. person');
    expect(m).toContain('чёрная кожаная куртка');
    expect(m).toContain('3. vehicle');
  });
  it('buildSeedanceParams: порядок и поля WaveSpeed', () => {
    const p = buildSeedanceParams(META, REFS);
    expect(p.endpoint).toBe('bytedance/seedance-2.0/video-edit');
    expect(p.reference_images.map((r) => r.index)).toEqual([1, 2, 3]);
    expect(p.reference_images[0]!.file).toBe('start-frame.png');
    expect(p.aspect_ratio).toBe('9:16');
    expect(p.enable_web_search).toBe(false);
  });
});

describe('запрос генерации', () => {
  it('доктрина содержит контракт и правило нумерации', () => {
    expect(DOCTRINE_SYSTEM).toContain(
      'Keep the entire world, background, lighting, camera work and ALL motion exactly as in the source video',
    );
    expect(DOCTRINE_SYSTEM).toContain('Reference image 1 is the exact first frame of the edit — start from it.');
    expect(DOCTRINE_SYSTEM).toContain('DO NOT change or restyle anything except');
    expect(DOCTRINE_SYSTEM).toContain('LIGHT the new');
  });
  it('обычная генерация: анализ + манифест, без итерации', () => {
    const { system, parts } = buildGenerationRequest('missing-project', ANALYSIS, META, REFS, {
      lang: 'en',
      fewshot: [],
      iteration: null,
    });
    expect(system).not.toContain('ITERATION MODE');
    const text = parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');
    expect(text).toContain('REFERENCE MANIFEST');
    expect(text).toContain('night city street');
    expect(text).toContain('imagePrompt language: English');
  });
  it('итерация: аддендум + таргет-фиксы из таксономии', () => {
    const { system, parts } = buildGenerationRequest('missing-project', ANALYSIS, META, REFS, {
      lang: 'ru',
      fewshot: [],
      iteration: {
        prevVideoPrompt: 'OLD VIDEO PROMPT',
        prevImagePrompt: 'OLD IMAGE PROMPT',
        artifacts: ['identity_bleed', 'pasted_on'],
        notes: 'лицо поплыло на 3с',
      },
    });
    expect(system).toContain('ITERATION MODE');
    const text = parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');
    expect(text).toContain('OLD VIDEO PROMPT');
    expect(text).toContain(ARTIFACTS.identity_bleed.fix.slice(0, 60));
    expect(text).toContain(ARTIFACTS.pasted_on.fix.slice(0, 60));
    expect(text).toContain('imagePrompt language: Russian');
  });
  it('few-shot попадает в запрос', () => {
    const { parts } = buildGenerationRequest('missing-project', ANALYSIS, META, REFS, {
      lang: 'en',
      fewshot: [
        { projectId: 'x', title: 't', tags: ['neon'], videoPrompt: 'FEWSHOT PROMPT BODY', feedbackNote: 'ok', score: 0.5 },
      ],
      iteration: null,
    });
    const text = parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');
    expect(text).toContain('PRIOR SUCCESSFUL PROJECTS');
    expect(text).toContain('FEWSHOT PROMPT BODY');
  });
});

describe('few-shot ретрив (реальная БД)', () => {
  beforeAll(() => {
    const db = getDb();
    const mk = (id: string, tags: string[], worked: number, promptText: string) => {
      db.prepare(`INSERT INTO projects (id, title, status, tags_json, analysis_json) VALUES (?, ?, 'complete', ?, '{}')`).run(id, id, JSON.stringify(tags));
      db.prepare(`INSERT INTO prompts (id, project_id, version, kind, lang, text) VALUES (?, ?, 1, 'video', 'en', ?)`).run(randomUUID(), id, promptText);
      db.prepare(`INSERT INTO feedback (id, project_id, version, worked) VALUES (?, ?, 1, ?)`).run(randomUUID(), id, worked);
    };
    mk('p-similar', ['night city', 'neon', 'motorcycle', 'tracking shot'], 1, 'SIMILAR WORKED PROMPT');
    mk('p-far', ['beach', 'daylight', 'drone'], 1, 'FAR PROMPT');
    mk('p-failed', ['night city', 'neon', 'motorcycle'], 0, 'FAILED PROMPT');
  });

  it('берёт похожий сработавший, отсекает далёкие и несработавшие', () => {
    const res = findSimilarWorked('self-id', ['night city', 'neon', 'motorcycle', 'wet asphalt']);
    expect(res.map((r) => r.projectId)).toEqual(['p-similar']);
    expect(res[0]!.videoPrompt).toBe('SIMILAR WORKED PROMPT');
  });

  it('jaccard основные случаи', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
  });
});
