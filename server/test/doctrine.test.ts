import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-doctrine-test-'));
process.env.OPENAI_API_KEY = 'test-key'; // config читается при импорте — ключ до импортов

const {
  DOCTRINE_SYSTEM,
  buildDoctrineSystem,
  REMOVE_TEXT_MODE,
  FIGURE_MODE,
  FIGURE_TIER1,
  FIGURE_TIER2,
  ANALYST_SYSTEM,
} = await import('../src/engine/doctrine');
const { buildGenerationRequest, wordCount, buildCompressionRequest, VIDEO_PROMPT_MAX_WORDS } =
  await import('../src/engine/generate');
const { isModerationRefusal, moderationLadder, generateStartFrame } = await import(
  '../src/engine/startframe'
);
const { AnalysisZ, ANALYSIS_JSON_SCHEMA } = await import('../../shared/analysis');
const { refsDir } = await import('../src/storage');

import type { Analysis } from '../../shared/analysis';
import type { RefInfo, VideoMeta } from '../../shared/api-types';

const META: VideoMeta = { durationSec: 8, width: 1080, height: 1920, fps: 30, aspect: '9:16', sizeBytes: 1 };
const REFS: RefInfo[] = [{ id: 'r1', idx: 0, role: 'model', file: 'ref_a.jpg', note: '' }];
const ANALYSIS = {
  storyboard: [],
  world: {
    location: 'street',
    timeOfDay: 'day',
    light: 'sun',
    weather: '',
    background: [],
    reflections: [],
    surfaces: [],
    overlayText: ['caption "cat ears > turn signals" bottom-center 0-12s'],
  },
  subjects: [],
  risks: [],
  startFrame: { description: '', composition: '', subjectPlacement: '', lightNote: '' },
  tags: ['street'],
} as unknown as Analysis;

describe('доктрина v2: opener и режимные блоки', () => {
  it('opener «Edit this video.» убран, правило про авто-префикс WaveSpeed добавлено', () => {
    expect(DOCTRINE_SYSTEM).not.toContain('Edit this video.');
    expect(DOCTRINE_SYSTEM).toContain('automatically prepends "Edit the input video."');
    // ядро контракта нетронуто
    expect(DOCTRINE_SYSTEM).toContain(
      'Reference image 1 is the exact first frame of the edit — start from it.',
    );
    expect(DOCTRINE_SYSTEM).toContain(
      'Keep the entire world, background, lighting, camera work and ALL motion exactly as in the source video',
    );
    expect(DOCTRINE_SYSTEM).toContain('DO NOT change or restyle anything except');
    expect(DOCTRINE_SYSTEM).toContain('LIGHT the new');
  });

  it('v3 «не сковывать»: без инвентарей в KEEP, подавители — только в итерациях, без форматов', () => {
    expect(DOCTRINE_SYSTEM).toContain('TRUST THE SOURCE VIDEO');
    expect(DOCTRINE_SYSTEM).toContain('NEVER enumerate scene objects');
    expect(DOCTRINE_SYSTEM).toContain('for ITERATIONS');
    expect(DOCTRINE_SYSTEM).toContain('Never mention resolutions, aspect ratios or formats');
    expect(DOCTRINE_SYSTEM).not.toContain('KEEP UNCHANGED, frame-accurate to the source video: [an explicit');
  });

  it('v3 старт-кадр: in-place edit первого кадра, не реконструкция; модерационно-безопасные формулировки', () => {
    expect(DOCTRINE_SYSTEM).toContain('SOURCE FIRST FRAME attached as the FIRST image');
    expect(DOCTRINE_SYSTEM).toContain('IN-PLACE EDIT of the source frame');
    expect(DOCTRINE_SYSTEM).toContain('Recreate this exact frame with the character');
    expect(DOCTRINE_SYSTEM).toContain('EXACTLY as in the source frame');
    expect(DOCTRINE_SYSTEM).toContain('AI-generated virtual characters');
    expect(DOCTRINE_SYSTEM).toContain('NEVER write "replace the person"');
    expect(DOCTRINE_SYSTEM).not.toContain('Reconstruct the first-frame scene');
    expect(DOCTRINE_SYSTEM).not.toContain('State the aspect ratio');
  });

  it('матрица 4 комбо: блоки появляются строго по своим флагам', () => {
    const none = buildDoctrineSystem({ removeText: false, enhanceFigure: false });
    expect(none).toBe(DOCTRINE_SYSTEM);
    expect(none).not.toContain('MODE: REMOVE OVERLAY TEXT');
    expect(none).not.toContain('MODE: FIGURE ENHANCEMENT');

    const rt = buildDoctrineSystem({ removeText: true, enhanceFigure: false });
    expect(rt).toContain('MODE: REMOVE OVERLAY TEXT');
    expect(rt).toContain('REMOVE every overlaid text element');
    expect(rt).toContain('DO NOT keep or re-add any on-screen text');
    expect(rt).not.toContain('MODE: FIGURE ENHANCEMENT');

    const fig = buildDoctrineSystem({ removeText: false, enhanceFigure: true });
    expect(fig).toContain('MODE: FIGURE ENHANCEMENT');
    expect(fig).toContain(FIGURE_TIER1); // tier-1 вписан дословно
    expect(fig).not.toContain('MODE: REMOVE OVERLAY TEXT');

    const both = buildDoctrineSystem({ removeText: true, enhanceFigure: true });
    expect(both).toContain(REMOVE_TEXT_MODE.trim().slice(0, 40));
    expect(both).toContain(FIGURE_MODE.trim().slice(0, 40));
  });

  it('identity-lock лица не ослаблен режимом фигуры', () => {
    expect(FIGURE_MODE).toContain('identity-lock is untouched');
    expect(FIGURE_MODE).toContain('match the reference photos exactly');
  });

  it('аналитик обучен полю overlayText', () => {
    expect(ANALYST_SYSTEM).toContain('overlayText');
    expect(ANALYST_SYSTEM).toContain('watermarks');
  });

  it('режим OFF: оверлеи хранятся одной короткой строкой, без перечислений', () => {
    expect(DOCTRINE_SYSTEM).toContain('NO remove-text mode is active');
    expect(DOCTRINE_SYSTEM).toContain('Keep all on-screen text exactly as in the source');
    expect(DOCTRINE_SYSTEM).toContain('Do not quote or enumerate the captions');
  });

  it('бюджет слов зашит в доктрину: жёсткая полоса и неприкосновенные строки', () => {
    expect(DOCTRINE_SYSTEM).toContain('WORD BUDGET (hard): videoPrompt 60–120 words');
    expect(DOCTRINE_SYSTEM).toContain('never above 150');
    expect(DOCTRINE_SYSTEM).toContain('NEVER cut to fit');
    expect(DOCTRINE_SYSTEM).toContain('Length: 60–120 words'); // полоса imagePrompt
  });
});

describe('энфорсмент длины промтов кодом', () => {
  it('wordCount и компресс-запрос: verbatim-строки и бюджет в инструкции', () => {
    expect(wordCount('  one   two\nthree ')).toBe(3);
    expect(VIDEO_PROMPT_MAX_WORDS).toBe(150);
    const req = buildCompressionRequest({
      videoPrompt: Array(300).fill('word').join(' '),
      imagePrompt: 'img prompt',
      notes: 'заметки',
    });
    expect(req).toContain('videoPrompt = 300 words');
    expect(req).toContain('STRICTLY UNDER 120 words');
    expect(req).toContain('TARGET: videoPrompt 80–110 words');
    expect(req).toContain('no scene inventories, no captions, no timings');
    expect(req).toContain('Keep verbatim: the reference-1 line');
    expect(req).toContain('img prompt');
    expect(req).toContain('заметки');
  });
});

describe('buildGenerationRequest: флаги в задании', () => {
  it('строка Modes отражает галочки; система получает блоки', () => {
    const req = buildGenerationRequest('proj-x', ANALYSIS, META, REFS, {
      lang: 'en',
      fewshot: [],
      iteration: null,
      flags: { removeText: true, enhanceFigure: false },
    });
    const task = (req.parts[0] as { text: string }).text;
    expect(task).toContain('remove overlay text = ON');
    expect(task).toContain('figure enhancement = OFF');
    expect(req.system).toContain('MODE: REMOVE OVERLAY TEXT');
    expect(task).toContain('overlayText'); // анализ с оверлеями уходит в LLM как есть
  });

  it('без флагов — чистая доктрина (v1-поведение)', () => {
    const req = buildGenerationRequest('proj-x', ANALYSIS, META, REFS, {
      lang: 'en',
      fewshot: [],
      iteration: null,
    });
    expect(req.system).not.toContain('MODE:');
    expect((req.parts[0] as { text: string }).text).toContain('remove overlay text = OFF');
  });
});

describe('схема анализа: overlayText', () => {
  it('строгая JSON-схема содержит поле; zod принимает и дефолтит старые JSON', () => {
    const worldSchema = (
      ANALYSIS_JSON_SCHEMA as unknown as {
        properties: { world: { properties: Record<string, unknown>; required: string[] } };
      }
    ).properties.world;
    expect(Object.keys(worldSchema.properties)).toContain('overlayText');
    expect(worldSchema.required).toContain('overlayText');

    const fresh = AnalysisZ.safeParse(ANALYSIS);
    expect(fresh.success).toBe(true);

    // старый analysis_json без поля — parse не падает, дефолт []
    const legacy = JSON.parse(JSON.stringify(ANALYSIS)) as { world: Record<string, unknown> };
    delete legacy.world.overlayText;
    const parsed = AnalysisZ.safeParse(legacy);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.world.overlayText).toEqual([]);
  });
});

describe('модерационная лестница старт-кадра', () => {
  it('isModerationRefusal ловит формулировки отказов', () => {
    expect(isModerationRefusal('Your request was rejected by our safety system')).toBe(true);
    expect(isModerationRefusal('content_policy_violation')).toBe(true);
    expect(isModerationRefusal('connection reset')).toBe(false);
  });

  it('лестница: tier1 → tier2 → без фразы; без фразы — одна ступень', () => {
    const p = `Scene description. ${FIGURE_TIER1} More text.`;
    const ladder = moderationLadder(p);
    expect(ladder.length).toBe(3);
    expect(ladder[1]).toContain(FIGURE_TIER2);
    expect(ladder[1]).not.toContain(FIGURE_TIER1);
    expect(ladder[2]).not.toContain(FIGURE_TIER2);
    expect(ladder[2]).toContain('Scene description.');
    expect(moderationLadder('plain prompt').length).toBe(1);
  });

  it('generateStartFrame: отказ на tier1 → ретрай tier2 → успех (мокнутый Images API)', async () => {
    const pid = 'proj-mod';
    fs.mkdirSync(refsDir(pid), { recursive: true });
    fs.writeFileSync(path.join(refsDir(pid), 'ref_a.jpg'), 'x');

    const prompts: string[] = [];
    const editFn = async (params: Record<string, unknown>) => {
      prompts.push(String(params.prompt));
      if (String(params.prompt).includes(FIGURE_TIER1)) {
        throw new Error('rejected by safety system');
      }
      return { data: [{ b64_json: Buffer.from('png').toString('base64') }], usage: { input_tokens: 10, output_tokens: 20 } };
    };
    const file = await generateStartFrame(
      pid,
      1,
      `Frame. ${FIGURE_TIER1}`,
      REFS,
      META,
      { forceNineSixteen: true, _editFn: editFn },
    );
    expect(prompts.length).toBe(2);
    expect(prompts[1]).toContain(FIGURE_TIER2);
    expect(file).toMatch(/^start_v1_/);
  });

  it('generateStartFrame: first.jpg исходника идёт ПЕРВЫМ изображением (in-place edit)', async () => {
    const pid = 'proj-firstframe';
    fs.mkdirSync(refsDir(pid), { recursive: true });
    fs.writeFileSync(path.join(refsDir(pid), 'ref_a.jpg'), 'x');
    const { framesDir } = await import('../src/storage');
    fs.mkdirSync(framesDir(pid), { recursive: true });
    fs.writeFileSync(path.join(framesDir(pid), 'first.jpg'), 'frame');

    let names: string[] = [];
    const editFn = async (params: Record<string, unknown>) => {
      names = (params.image as Array<{ name?: string }>).map((f) => f.name ?? '?');
      return { data: [{ b64_json: Buffer.from('png').toString('base64') }], usage: {} };
    };
    await generateStartFrame(pid, 1, 'Swap the person.', REFS, META, {
      forceNineSixteen: true,
      _editFn: editFn,
    });
    expect(names[0]).toBe('source-frame.jpg'); // база = кадр исходника
    expect(names.length).toBe(REFS.length + 1);
  });

  it('generateStartFrame: вся лесенка с кадром отбита модерацией → фолбэк-реконструкция без кадра', async () => {
    const pid = 'proj-modfallback';
    fs.mkdirSync(refsDir(pid), { recursive: true });
    fs.writeFileSync(path.join(refsDir(pid), 'ref_a.jpg'), 'x');
    const { framesDir } = await import('../src/storage');
    fs.mkdirSync(framesDir(pid), { recursive: true });
    fs.writeFileSync(path.join(framesDir(pid), 'first.jpg'), 'frame');

    const calls: string[][] = [];
    const editFn = async (params: Record<string, unknown>) => {
      const names = (params.image as Array<{ name?: string }>).map((f) => f.name ?? '?');
      calls.push(names);
      if (names[0] === 'source-frame.jpg') throw new Error('rejected by safety system');
      return { data: [{ b64_json: Buffer.from('png').toString('base64') }], usage: {} };
    };
    const file = await generateStartFrame(pid, 1, 'Recast the character.', REFS, META, {
      forceNineSixteen: true,
      _editFn: editFn,
    });
    expect(file).toMatch(/^start_v1_/);
    expect(calls[0]![0]).toBe('source-frame.jpg'); // сперва с кадром
    expect(calls[calls.length - 1]![0]).not.toBe('source-frame.jpg'); // фолбэк без кадра
  });
});

describe('классификатор рефов', () => {
  it('сбой чтения файла/LLM тихо даёт null (эвристика возьмёт своё)', async () => {
    const { classifyRef } = await import('../src/engine/classify');
    // файла нет → readFileSync бросает → classifyRef ловит и возвращает null
    const res = await classifyRef('no-such-project', 'missing.jpg', 100);
    expect(res).toBeNull();
  });
});
