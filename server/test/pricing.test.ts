import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-pricing-test-'));
process.env.PRICING_OVERRIDES = JSON.stringify({ 'fake-override-model': { inPerM: 2, outPerM: 4 } });

const {
  evalSeedanceFormula,
  billedSecondsOf,
  estimateRender,
  estimateVideoRender,
  ensureLitellmFresh,
  priceForCached,
  forecastTokens,
  buildEstimate,
  getBalanceCached,
  _resetPricingMemory,
  SEED_TOKENS,
} = await import('../src/pricing');
const { planVideoSegments } = await import('../src/engine/segments');
const { recordUsage, monthSummary, projectOpenaiUsd } = await import('../src/usage');
const { getDb } = await import('../src/db');
const { config } = await import('../src/config');
const {
  parseFlags,
  flagsEqual,
  nextStageOf,
  remainingStages,
  snapshotProject,
  startframeExists,
  DEFAULT_FLAGS,
} = await import('../src/engine/orchestrator');
const { startDir } = await import('../src/storage');
import type { WaveSpeed } from '../src/wavespeed';

// Снапшот ЖИВОЙ формулы bytedance/seedance-2.0/video-edit из GET /api/v3/models (16.07.2026).
// Если WaveSpeed её поменяет — сервис возьмёт новую из каталога; фикстура ловит регрессии эвала.
const LIVE_FORMULA =
  '{"total_price": 75000 * (resolution = "4k" ? 10 : (resolution = "1080p" ? 5 : (resolution = "720p" ? 2 : 1))) * ($max([2, $ceil($min([$number($ceil(get_duration_v3(video))), 15]))]) + (duration ? $number(duration) : $max([4, $min([15, $ceil($number($ceil(get_duration_v3(video))))])])))}';

const LITELLM_MANIFEST = {
  'gpt-5.6-terra': { input_cost_per_token: 2.5e-6, output_cost_per_token: 1.5e-5 },
  'gpt-5.6-luna': { input_cost_per_token: 1e-6, output_cost_per_token: 6e-6 },
  'gpt-5.5': { input_cost_per_token: 5e-6, output_cost_per_token: 3e-5 },
  'gpt-5.4-mini': { input_cost_per_token: 7.5e-7, output_cost_per_token: 4.5e-6 },
  'gpt-image-2': { input_cost_per_token: 5e-6, output_cost_per_token: 1e-5 },
  'unrelated-model': { input_cost_per_token: 1, output_cost_per_token: 1 },
};

const litellmFetch = (async () =>
  new Response(JSON.stringify(LITELLM_MANIFEST), { status: 200 })) as unknown as typeof fetch;

function fakeWs(overrides: Partial<Record<keyof WaveSpeed, unknown>> = {}): WaveSpeed {
  return {
    uploadBinary: async () => 'https://cdn/up.bin',
    submitVideoEdit: async () => 'pred-x',
    pollResult: async () => ({ id: 'pred-x', status: 'completed', outputs: [], error: '', raw: {} }),
    downloadOutput: async () => 0,
    getBalance: async () => 3.92,
    fetchModelEntry: async () => ({
      model_id: config.seedanceEndpoint,
      base_price: 0.75,
      formula: LIVE_FORMULA,
    }),
    ...overrides,
  } as WaveSpeed;
}

beforeEach(() => {
  _resetPricingMemory();
});

describe('формула WaveSpeed (живой снапшот)', () => {
  it('12с @720p = $3.60 (вход 12 + выход 12 по $0.15/с)', async () => {
    await expect(evalSeedanceFormula(LIVE_FORMULA, 12, '720p')).resolves.toBeCloseTo(3.6, 5);
  });
  it('4с @480p = $0.60', async () => {
    await expect(evalSeedanceFormula(LIVE_FORMULA, 4, '480p')).resolves.toBeCloseTo(0.6, 5);
  });
  it('приёмочный трим 6с @720p = $1.80; полный 10.98с = $3.30', async () => {
    await expect(evalSeedanceFormula(LIVE_FORMULA, 6, '720p')).resolves.toBeCloseTo(1.8, 5);
    await expect(evalSeedanceFormula(LIVE_FORMULA, 10.98, '720p')).resolves.toBeCloseTo(3.3, 5);
  });
  it('клампы: 1с → вход 2 + выход 4; 60с → 15+15', async () => {
    await expect(evalSeedanceFormula(LIVE_FORMULA, 1, '720p')).resolves.toBeCloseTo(0.9, 5);
    await expect(evalSeedanceFormula(LIVE_FORMULA, 60, '720p')).resolves.toBeCloseTo(4.5, 5);
  });
  it('явный duration заменяет авто-выход', async () => {
    await expect(evalSeedanceFormula(LIVE_FORMULA, 12, '720p', 4)).resolves.toBeCloseTo(2.4, 5);
  });
  it('1080p множитель ×5', async () => {
    await expect(evalSeedanceFormula(LIVE_FORMULA, 10, '1080p')).resolves.toBeCloseTo(7.5, 5);
  });
  it('санити-границы: нулевая и конская цена отбрасываются', async () => {
    await expect(evalSeedanceFormula('{"total_price": 0}', 5, '720p')).rejects.toThrow(/санити/);
    await expect(evalSeedanceFormula('{"total_price": 200000000}', 5, '720p')).rejects.toThrow(
      /санити/,
    );
    await expect(evalSeedanceFormula('{"total_price": "мусор"}', 5, '720p')).rejects.toThrow();
  });
  it('billedSecondsOf повторяет клампы формулы', () => {
    expect(billedSecondsOf(12)).toEqual({ input: 12, output: 12 });
    expect(billedSecondsOf(1)).toEqual({ input: 2, output: 4 });
    expect(billedSecondsOf(60)).toEqual({ input: 15, output: 15 });
  });
});

describe('estimateRender: лестница фолбэков', () => {
  it('живой каталог → цена', async () => {
    const r = await estimateRender(12, fakeWs());
    expect(r.usd).toBeCloseTo(3.6, 5);
    expect(r.billedSeconds).toBe(24);
    expect(r.unavailableReason).toBeNull();
  });
  it('каталог упал, но есть last-known-good в БД → цена из кэша', async () => {
    await estimateRender(12, fakeWs()); // прогреваем кэш (пишет pricing_cache)
    _resetPricingMemory();
    const broken = fakeWs({
      fetchModelEntry: async () => {
        throw new Error('offline');
      },
    });
    const r = await estimateRender(6, broken);
    expect(r.usd).toBeCloseTo(1.8, 5);
  });
  it('кривая формула → unavailableReason, не исключение', async () => {
    getDb().prepare(`DELETE FROM pricing_cache WHERE source='wavespeed_model'`).run();
    const bad = fakeWs({
      fetchModelEntry: async () => ({ model_id: config.seedanceEndpoint, formula: '{"total_price": 0}' }),
    });
    const r = await estimateRender(12, bad);
    expect(r.usd).toBeNull();
    expect(r.unavailableReason).toMatch(/формул/);
  });
});

describe('цены OpenAI: litellm + оверрайд', () => {
  it('ручной PRICING_OVERRIDES главнее всего', () => {
    const p = priceForCached('fake-override-model');
    expect(p).toEqual({ inPerM: 2, outPerM: 4, date: 'override', source: 'override' });
  });
  it('живой манифест фильтруется до наших моделей и пишется в pricing_cache', async () => {
    await ensureLitellmFresh(litellmFetch);
    const p = priceForCached('gpt-5.6-luna');
    expect(p?.inPerM).toBeCloseTo(1, 9);
    expect(p?.outPerM).toBeCloseTo(6, 9);
    expect(p?.source).toBe('live');
    expect(priceForCached('unrelated-model')).toBeNull();
    const cached = getDb()
      .prepare(`SELECT payload_json FROM pricing_cache WHERE source='litellm'`)
      .get() as { payload_json: string };
    expect(JSON.parse(cached.payload_json)['unrelated-model']).toBeUndefined();
  });
  it('после рестарта (память пуста) берёт last-known-good из БД с датой', async () => {
    await ensureLitellmFresh(litellmFetch);
    _resetPricingMemory();
    const p = priceForCached('gpt-5.6-terra');
    expect(p?.source).toBe('cache');
    expect(p?.inPerM).toBeCloseTo(2.5, 9);
    expect(p?.date).toBeTruthy();
  });
  it('фетч упал — остаёмся на прежних данных без исключения', async () => {
    await ensureLitellmFresh(litellmFetch);
    _resetPricingMemory();
    const failing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await ensureLitellmFresh(failing);
    expect(priceForCached('gpt-5.5')?.inPerM).toBeCloseTo(5, 9);
  });
});

describe('оценщик токенов и учёт расхода', () => {
  it('без истории — сид-эмпирика; с историей — скользящее среднее', () => {
    const before = forecastTokens('video_analysis');
    expect(before.basis).toBe('seed');
    expect(before.tokensIn).toBe(SEED_TOKENS.video_analysis.tin);
    for (let i = 0; i < 5; i++) {
      recordUsage({
        projectId: null,
        task: 'video_analysis',
        model: 'fake-override-model',
        tokensIn: 20_000,
        tokensOut: 1_000,
      });
    }
    const after = forecastTokens('video_analysis');
    expect(after.basis).toBe('history');
    expect(after.tokensIn).toBe(20_000);
    expect(after.tokensOut).toBe(1_000);
  });
  it('recordUsage считает cost по кэшу цен; monthSummary суммирует', () => {
    recordUsage({
      projectId: 'proj-sum',
      task: 'prompt_pair',
      model: 'fake-override-model',
      tokensIn: 1_000_000,
      tokensOut: 500_000,
    });
    // 1M×$2/M + 0.5M×$4/M = $4
    expect(projectOpenaiUsd('proj-sum')).toBeCloseTo(4, 6);
    const month = new Date().toISOString().slice(0, 7);
    const s = monthSummary(month);
    expect(s.openaiUsd).toBeGreaterThanOrEqual(4);
    expect(s.runs).toBe(0);
    expect(() => monthSummary('июль')).toThrow(/YYYY-MM/);
  });
  it('monthSummary считает WaveSpeed по зафиксированной стоимости, включая failed-рендеры', () => {
    const db = getDb();
    db.prepare(`INSERT INTO projects (id, title) VALUES ('proj-ws-sum', 't')`).run();
    // done с фактом $1.80 + failed с захваченным списанием $0.60 (recheck после таймаута)
    db.prepare(
      `INSERT INTO generations (id, project_id, version, status, params_json, cost_actual_usd, finished_at)
       VALUES ('g-done', 'proj-ws-sum', 1, 'done', '{}', 1.8, datetime('now')),
              ('g-fail', 'proj-ws-sum', 1, 'failed', '{}', 0.6, datetime('now')),
              ('g-unknown', 'proj-ws-sum', 1, 'failed', '{}', NULL, datetime('now'))`,
    ).run();
    const s = monthSummary(new Date().toISOString().slice(0, 7));
    expect(s.wavespeedUsd).toBeCloseTo(2.4, 6);
    expect(s.runs).toBe(2); // списания, а не только done
  });
});

describe('оркестратор: флаги и решающая таблица', () => {
  const base = {
    framesReady: true,
    analysisReady: true,
    latestVersion: 1,
    latestPromptFlags: { ...DEFAULT_FLAGS },
    wantedFlags: { ...DEFAULT_FLAGS },
    startframeReady: true,
    latestGenStatus: null as string | null,
  };
  it('parseFlags: null/мусор → дефолты; flagsEqual сравнивает по значению', () => {
    expect(parseFlags(null)).toEqual(DEFAULT_FLAGS);
    expect(parseFlags('не json')).toEqual(DEFAULT_FLAGS);
    expect(parseFlags('{"removeText":true}')).toEqual({ removeText: true, enhanceFigure: false, wish: '' });
    expect(flagsEqual(parseFlags(null), DEFAULT_FLAGS)).toBe(true);
  });
  it('таблица переходов', () => {
    expect(nextStageOf({ ...base, framesReady: false })).toBe('storyboard');
    expect(nextStageOf({ ...base, analysisReady: false })).toBe('analyze');
    expect(nextStageOf({ ...base, latestVersion: 0, latestPromptFlags: null })).toBe('generate');
    expect(
      nextStageOf({ ...base, wantedFlags: { removeText: true, enhanceFigure: false, wish: '' } }),
    ).toBe('generate'); // смена галочек → регенерация
    expect(nextStageOf({ ...base, startframeReady: false })).toBe('startframe');
    expect(nextStageOf(base)).toBe('render');
    expect(nextStageOf({ ...base, latestGenStatus: 'done' })).toBe('done');
    // failed-рендер не перезапускается автоматически (только ручной retry)
    expect(nextStageOf({ ...base, latestGenStatus: 'failed' })).toBe('done');
    expect(nextStageOf({ ...base, latestGenStatus: 'rendering' })).toBe('done');
  });
  it('remainingStages: срез от следующей стадии; done → только render (повторный прогон)', () => {
    expect(remainingStages({ ...base, framesReady: false, analysisReady: false })).toEqual([
      'storyboard',
      'analyze',
      'generate',
      'startframe',
      'render',
    ]);
    expect(remainingStages(base)).toEqual(['render']);
    expect(remainingStages({ ...base, latestGenStatus: 'done' })).toEqual(['render']);
  });
  it('snapshotProject читает версию, флаги, старт-кадр и генерацию из БД/ФС', () => {
    const db = getDb();
    db.prepare(`INSERT INTO projects (id, frames_json, analysis_json, flags_json) VALUES ('sp1', '[]', '{}', '{"removeText":true}')`).run();
    db.prepare(
      `INSERT INTO prompts (id, project_id, version, kind, text, flags_json) VALUES ('pr1', 'sp1', 2, 'video', 'x', '{"removeText":true}')`,
    ).run();
    db.prepare(`INSERT INTO generations (id, project_id, version, status) VALUES ('g1', 'sp1', 2, 'done')`).run();
    fs.mkdirSync(startDir('sp1'), { recursive: true });
    fs.writeFileSync(path.join(startDir('sp1'), 'start_v2_2026-07-16T00-00-00.png'), 'png');
    const s = snapshotProject({ id: 'sp1', frames_json: '[]', analysis_json: '{}', flags_json: '{"removeText":true}' });
    expect(s.latestVersion).toBe(2);
    expect(s.latestPromptFlags).toEqual({ removeText: true, enhanceFigure: false, wish: '' });
    expect(s.startframeReady).toBe(true);
    expect(s.latestGenStatus).toBe('done');
    expect(nextStageOf(s)).toBe('done');
    expect(startframeExists('sp1', 3)).toBe(false);
  });
});

describe('buildEstimate: сквозная смета', () => {
  it('свежий проект 12с: OpenAI ≈ $0.21 + WaveSpeed $3.60, баланс попадает в ответ', async () => {
    await ensureLitellmFresh(litellmFetch);
    getDb()
      .prepare(`INSERT INTO projects (id, meta_json) VALUES ('est1', ?)`)
      .run(JSON.stringify({ durationSec: 12, width: 1080, height: 1920, fps: 30, aspect: '9:16', sizeBytes: 1 }));
    const est = await buildEstimate(
      {
        id: 'est1',
        frames_json: null,
        analysis_json: null,
        flags_json: null,
        meta_json: JSON.stringify({ durationSec: 12, width: 1080, height: 1920, fps: 30, aspect: '9:16', sizeBytes: 1 }),
        video_purged: 0,
      },
      fakeWs(),
    );
    expect(est.stages).toEqual(['storyboard', 'analyze', 'generate', 'startframe', 'render']);
    expect(est.wavespeed.usd).toBeCloseTo(3.6, 5);
    expect(est.openai.usd).toBeGreaterThan(0.1);
    expect(est.openai.usd).toBeLessThan(0.4);
    expect(est.totalUsd).toBeCloseTo(3.6 + (est.openai.usd ?? 0), 5);
    expect(est.balanceUsd).toBeCloseTo(3.92, 5);
    expect(est.approximate).toBe(false);
  });
  it('баланс меньше сметы → предупреждение «пополни»', async () => {
    await ensureLitellmFresh(litellmFetch);
    const est = await buildEstimate(
      {
        id: 'est-nope',
        frames_json: null,
        analysis_json: null,
        flags_json: null,
        meta_json: JSON.stringify({ durationSec: 15, width: 1080, height: 1920, fps: 30, aspect: '9:16', sizeBytes: 1 }),
        video_purged: 0,
      },
      fakeWs({ getBalance: async () => 1.0 }),
    );
    expect(est.wavespeed.usd).toBeCloseTo(4.5, 5);
    expect(est.warnings.some((w) => w.includes('пополни'))).toBe(true);
  });
  it('30с считает все Seedance-части по тому же плану и не перерисовывает стыки', async () => {
    await ensureLitellmFresh(litellmFetch);
    const meta = JSON.stringify({ durationSec: 30, width: 1080, height: 1920, fps: 30, aspect: '9:16', sizeBytes: 1 });
    const analysis = {
      storyboard: [
        { index: 0, startSec: 0, endSec: 12.8, camera: 'steady', action: 'model and motorcycle visible', framing: 'full body' },
        { index: 1, startSec: 12.8, endSec: 30, camera: 'tracking', action: 'hero rides motorcycle', framing: 'medium shot' },
      ],
    };
    const frames = [{ file: 'frame.jpg', t: 12.2, kind: 'grid' as const }];
    const ws = fakeWs({ getBalance: async () => 100 });
    const est = await buildEstimate(
      {
        id: 'est-long',
        frames_json: JSON.stringify(frames),
        analysis_json: JSON.stringify(analysis),
        flags_json: null,
        meta_json: meta,
        video_purged: 0,
      },
      ws,
    );
    const plan = planVideoSegments(30, analysis as never, frames);
    const exactRender = await estimateVideoRender(30, ws, plan);
    expect(est.wavespeed.usd).toBeCloseTo(exactRender.usd!, 6);
    expect(est.wavespeed.usd).toBeGreaterThan(4.5);
    expect(est.openai.perTask.filter((t) => t.task.startsWith('start_frame_segment_'))).toHaveLength(0);
    expect(est.openai.perTask.filter((t) => t.task === 'start_frame')).toHaveLength(1);
    expect(est.warnings).toContain('длинный исходник будет бесшовно собран из 3 частей');
  });
  it('кэш баланса 60с: два вызова — один сетевой', async () => {
    let calls = 0;
    const ws = fakeWs({
      getBalance: async () => {
        calls++;
        return 2.5;
      },
    });
    expect(await getBalanceCached(ws)).toBe(2.5);
    expect(await getBalanceCached(ws)).toBe(2.5);
    expect(calls).toBe(1);
  });
});
