import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-presets-test-'));
process.env.WAVESPEED_API_KEY = 'test-key';
process.env.OPENAI_API_KEY = 'test-key';
process.env.AUTH_DEV_BYPASS = '1';
// тесты гоняются из server/ — ассеты пресетов лежат в репо
process.env.PRESETS_DIR = path.resolve('assets/presets');

const { getDb } = await import('../src/db');
const { PRESETS, getPreset, applyPreset, presetFilePath, presetsDir } = await import('../src/presets');
const { makeAuthedApp } = await import('./helpers');
const { enqueueProjectJob, waitForJobsIdle, _pauseJobsForTests, _discardQueuedJobsForTests } = await import('../src/jobs');
const { refsDir, projectDir } = await import('../src/storage');
const { ensureLitellmFresh, estimateRender, getBalanceCached, _resetPricingMemory } = await import(
  '../src/pricing'
);
const { config } = await import('../src/config');
import type { WaveSpeed } from '../src/wavespeed';

const LIVE_FORMULA =
  '{"total_price": 75000 * (resolution = "4k" ? 10 : (resolution = "1080p" ? 5 : (resolution = "720p" ? 2 : 1))) * ($max([2, $ceil($min([$number($ceil(get_duration_v3(video))), 15]))]) + (duration ? $number(duration) : $max([4, $min([15, $ceil($number($ceil(get_duration_v3(video))))])])))}';

const priceWs = {
  fetchModelEntry: async () => ({ model_id: config.seedanceEndpoint, base_price: 0.75, formula: LIVE_FORMULA }),
  getBalance: async () => 10,
} as unknown as WaveSpeed;

async function warmPricing(): Promise<void> {
  _resetPricingMemory();
  const manifest = {
    'gpt-5.6-terra': { input_cost_per_token: 2.5e-6, output_cost_per_token: 1.5e-5 },
    'gpt-5.6-luna': { input_cost_per_token: 1e-6, output_cost_per_token: 6e-6 },
    'gpt-image-2': { input_cost_per_token: 5e-6, output_cost_per_token: 1e-5 },
  };
  await ensureLitellmFresh(
    (async () => new Response(JSON.stringify(manifest), { status: 200 })) as unknown as typeof fetch,
  );
  await estimateRender(6, priceWs);
  await getBalanceCached(priceWs, true);
}

// Легаси-тесты эмулируют владельца (unmetered) — кредиты живут в credits.test.ts
const OWNER_TEST_ID = 'owner-presets-tests';
getDb().prepare(`INSERT INTO users (id, telegram_id, role) VALUES (?, 4242, 'owner')`).run(OWNER_TEST_ID);

function project(id = randomUUID()): string {
  getDb()
    .prepare(
      `INSERT INTO projects (id, user_id, title, status, video_file, video_bytes, meta_json, frames_json, analysis_json)
       VALUES (?, ?, 'p', 'complete', 'source.mp4', 10, ?, '[]', '{}')`,
    )
    .run(id, OWNER_TEST_ID, JSON.stringify({ durationSec: 6, width: 1080, height: 1920, fps: 30, aspect: '9:16', sizeBytes: 10 }));
  fs.mkdirSync(projectDir(id), { recursive: true });
  fs.writeFileSync(path.join(projectDir(id), 'source.mp4'), 'v');
  return id;
}

describe('пресеты: манифест и применение', () => {
  it('манифест валиден: файлы существуют, модель первой, роли корректны', () => {
    expect(PRESETS.length).toBe(6);
    // две модели, у каждой свой байк
    expect(getPreset('lunaria-moto')?.refs[1]!.file).toBe('lunaria-bike.jpg');
    expect(getPreset('motolola-loose')?.refs[1]!.file).toBe('zx6r.jpg');
    expect(getPreset('lunaria-sport')?.refs[0]!.note).toContain('БЕЛЫЕ');
    for (const p of PRESETS) {
      expect(p.refs[0]!.role).toBe('model'); // нумерация: модель = ref 2 после старт-кадра
      expect(p.refs.some((r) => r.role === 'vehicle')).toBe(true);
      for (const r of p.refs) {
        expect(fs.existsSync(path.join(presetsDir(), r.file)), `${p.id}/${r.file}`).toBe(true);
        expect(r.note.length).toBeGreaterThan(10);
      }
    }
    expect(getPreset('motolola-braid')?.refs[0]!.note).toContain('КОС');
    expect(getPreset('motolola-loose')?.refs[0]!.note).toContain('РАСПУЩЕН');
    expect(getPreset('nope')).toBeUndefined();
  });

  it('applyPreset копирует файлы и создаёт refs c role_source=preset; повторное применение — отказ', () => {
    const pid = project();
    applyPreset(pid, getPreset('motolola-braid')!);
    const refs = getDb()
      .prepare(`SELECT idx, role, file, note, role_source FROM refs WHERE project_id = ? ORDER BY idx`)
      .all(pid) as Array<{ idx: number; role: string; file: string; note: string; role_source: string }>;
    expect(refs.length).toBe(2);
    expect(refs[0]!.role).toBe('model');
    expect(refs[1]!.role).toBe('vehicle');
    expect(refs.every((r) => r.role_source === 'preset')).toBe(true);
    for (const r of refs) {
      const f = path.join(refsDir(pid), r.file);
      expect(fs.existsSync(f)).toBe(true);
      expect(fs.statSync(f).size).toBeGreaterThan(100_000); // реальный лист, не заглушка
    }
    expect(() => applyPreset(pid, getPreset('motolola-loose')!)).toThrow(/уже есть референсы/);
  });

  it('presetFilePath отдаёт только файлы из манифеста', () => {
    const p = getPreset('motolola-loose')!;
    expect(presetFilePath(p, 'motolola-loose.jpg')).toBeTruthy();
    expect(presetFilePath(p, 'zx6r.jpg')).toBeTruthy();
    expect(presetFilePath(p, '../../../etc/passwd')).toBeNull();
    expect(presetFilePath(p, 'motolola-braid.jpg')).toBeNull(); // файла нет в манифесте loose
  });
});

describe('пресеты: роуты', () => {
  it('GET /api/presets отдаёт список с thumb; файл пресета отдаётся, чужое имя — 404', async () => {
    const { app } = await makeAuthedApp();
    const list = await app.inject({ method: 'GET', url: '/api/presets' });
    expect(list.statusCode).toBe(200);
    const items = JSON.parse(list.body) as Array<{ id: string; thumb: string }>;
    expect(items.map((i) => i.id).sort()).toEqual([
      'lunaria-kawaii',
      'lunaria-moto',
      'lunaria-sport',
      'motolola-braid',
      'motolola-loose',
      'motolola-twinbraids',
    ]);

    const ok = await app.inject({ method: 'GET', url: `/${items[0]!.thumb}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('image/jpeg');

    const bad404 = await app.inject({ method: 'GET', url: '/api/presets/motolola-loose/file/nope.jpg' });
    expect(bad404.statusCode).toBe(404);
    await app.close();
  });

  it('POST /swap {preset} на чистом проекте подкладывает рефы и запускает флоу; на проекте с рефами — 409', async () => {
    await warmPricing();
    const { app, own } = await makeAuthedApp();
    _pauseJobsForTests(true);
    const pid = project();
    own(pid);
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${pid}/swap`,
      payload: { preset: 'motolola-loose', flags: { removeText: true, enhanceFigure: false } },
    });
    expect(res.statusCode).toBe(200);
    const refs = getDb().prepare(`SELECT COUNT(*) AS c FROM refs WHERE project_id = ?`).get(pid) as { c: number };
    expect(refs.c).toBe(2);
    const p = getDb().prepare(`SELECT flow FROM projects WHERE id = ?`).get(pid) as { flow: string };
    expect(p.flow).toBe('auto');

    // повторно с пресетом при существующих рефах — отказ (без затирания)
    const again = await app.inject({
      method: 'POST',
      url: `/api/projects/${pid}/swap`,
      payload: { preset: 'motolola-braid', flags: { removeText: true, enhanceFigure: false } },
    });
    expect(again.statusCode).toBe(409);

    const pid3 = project();
    own(pid3); // владение есть → 404 именно про неизвестный ПРЕСЕТ, не про проект
    const unknown = await app.inject({
      method: 'POST',
      url: `/api/projects/${pid3}/swap`,
      payload: { preset: 'wat' },
    });
    expect(unknown.statusCode).toBe(404);
    expect(JSON.parse(unknown.body).error).toContain('пресет');
    _discardQueuedJobsForTests();
    _pauseJobsForTests(false);
    await waitForJobsIdle();
    await app.close();
  });
});

describe('тайминги стадий', () => {
  it('enqueueProjectJob пишет фактическую длительность в stage_times_json', async () => {
    const pid = project();
    enqueueProjectJob({
      projectId: pid,
      label: 'storyboard',
      busyStatus: 'storyboarding',
      doneStatus: 'storyboarded',
      errorFallbackStatus: 'uploaded',
      fn: async () => {
        await new Promise((r) => setTimeout(r, 150)); // >0.1с — иначе округление в 0.0
      },
    });
    await waitForJobsIdle();
    const row = getDb().prepare(`SELECT stage_times_json, status FROM projects WHERE id = ?`).get(pid) as {
      stage_times_json: string | null;
      status: string;
    };
    expect(row.status).toBe('storyboarded');
    const times = JSON.parse(row.stage_times_json!) as Record<string, number>;
    expect(times.storyboard).toBeGreaterThan(0);
    expect(times.storyboard).toBeLessThan(5);
  });
});
