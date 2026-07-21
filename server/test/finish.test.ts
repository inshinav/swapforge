// Reality Finish: адаптивный план фильтров (чистая математика), роуты превью/применения,
// жизненный цикл обработки, тенантность, лимиты, уборка кэша и ротация артефактов.
import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-finish-test-'));
process.env.AUTH_DEV_BYPASS = '1';

const { getDb } = await import('../src/db');
const {
  bucketIntensity,
  computeFinishPlan,
  meanOfStatKey,
  previewCached,
  resumeFinishJobs,
  finishedFileName,
  _setFinishToolsForTests,
  _waitFinishIdleForTests,
} = await import('../src/engine/finish');
const { makeAuthedApp } = await import('./helpers');
const {
  cleanupInvisibleProjects,
  enforceLatestResultLimit,
  finishDir,
  rendersDir,
  sweepTransientProjectFiles,
} = await import('../src/storage');
const { dayKey } = await import('../src/limits');
const { config } = await import('../src/config');
import type { FinishStats, FinishPreviewInfo, ProjectFull, VideoMeta } from '../../shared/api-types';

const CLEAN: FinishStats = {
  brightness: 0.5,
  contrast: 0.5,
  saturation: 0.3,
  sharpness: 0.07,
  noise: 0.006,
  clippedHighlights: 0,
  crushedShadows: 0,
  skin: 0.05,
  sampledFrames: 16,
};

const META: VideoMeta = { durationSec: 6, width: 720, height: 1280, fps: 30, aspect: '9:16', sizeBytes: 5 };

let execCalls: string[][] = [];

function stubTools(overrides: Parameters<typeof _setFinishToolsForTests>[0] = {}): void {
  execCalls = [];
  _setFinishToolsForTests({
    exec: async (args: string[]) => {
      execCalls.push(args);
      const out = args[args.length - 1]!;
      if (out !== '-') fs.writeFileSync(out, 'video-bytes');
    },
    probeVideo: async () => ({ ...META }),
    hasAudio: async () => true,
    measure: async () => ({ ...CLEAN }),
    ...overrides,
  });
}

const authed = await makeAuthedApp(91001, 'Финиш-Юзер');

function seedDoneGeneration(userId: string): { projectId: string; genId: string } {
  const db = getDb();
  const projectId = randomUUID();
  const genId = randomUUID();
  db.prepare(
    `INSERT INTO projects (id, user_id, title, status, video_file, video_bytes, meta_json)
     VALUES (?, ?, 'finish-test', 'complete', 'source.mp4', 3000, ?)`,
  ).run(projectId, userId, JSON.stringify(META));
  db.prepare(
    `INSERT INTO generations (id, project_id, user_id, version, status, file, bytes, finished_at)
     VALUES (?, ?, ?, 1, 'done', ?, 5, datetime('now'))`,
  ).run(genId, projectId, userId, `gen_${genId}.mp4`);
  fs.mkdirSync(rendersDir(projectId), { recursive: true });
  fs.writeFileSync(path.join(rendersDir(projectId), `gen_${genId}.mp4`), 'render');
  return { projectId, genId };
}

function finishJsonOf(genId: string): Record<string, unknown> {
  const row = getDb().prepare(`SELECT finish_json FROM generations WHERE id=?`).get(genId) as {
    finish_json: string | null;
  };
  return row.finish_json ? (JSON.parse(row.finish_json) as Record<string, unknown>) : {};
}

beforeEach(() => stubTools());

// ── Чистая математика плана ─────────────────────────────────────────────────

describe('computeFinishPlan — адаптация под замер', () => {
  it('гасит зерно в уже шумном ролике, но не убирает его полностью', () => {
    const clean = computeFinishPlan(CLEAN, 'natural', 1);
    const noisy = computeFinishPlan({ ...CLEAN, noise: 0.06 }, 'natural', 1);
    expect(noisy.params.grain.luma).toBeGreaterThan(0);
    expect(noisy.params.grain.luma).toBeLessThan(clean.params.grain.luma * 0.3);
    expect(noisy.notes.join(' ')).toContain('шум');
  });

  it('не поднимает насыщенность в уже сочном ролике', () => {
    const vivid = computeFinishPlan({ ...CLEAN, saturation: 0.55 }, 'phone', 1);
    expect(vivid.params.eq.saturation).toBeLessThanOrEqual(1);
    const flat = computeFinishPlan({ ...CLEAN, saturation: 0.15 }, 'phone', 1);
    expect(flat.params.eq.saturation).toBeGreaterThan(1);
  });

  it('не затемняет ролик с проваленными тенями — наоборот, чуть приподнимает', () => {
    const crushed = computeFinishPlan({ ...CLEAN, brightness: 0.7, crushedShadows: 0.05 }, 'camera', 1);
    expect(crushed.params.eq.brightness).toBeGreaterThan(0);
    const bright = computeFinishPlan({ ...CLEAN, brightness: 0.7 }, 'camera', 1);
    expect(bright.params.eq.brightness).toBeLessThan(0);
  });

  it('бережёт тон кожи: кап на прибавку цвета и половина тепла', () => {
    const skin = computeFinishPlan({ ...CLEAN, saturation: 0.1, skin: 0.3 }, 'phone', 1);
    expect(skin.params.eq.saturation - 1).toBeLessThanOrEqual(0.051);
    const camSkin = computeFinishPlan({ ...CLEAN, skin: 0.3 }, 'camera', 1);
    const camNoSkin = computeFinishPlan({ ...CLEAN, skin: 0.02 }, 'camera', 1);
    expect(camSkin.params.warmth).toBeCloseTo(camNoSkin.params.warmth / 2, 3);
  });

  it('почти не точит уже резкое видео', () => {
    const sharp = computeFinishPlan({ ...CLEAN, sharpness: 0.2 }, 'natural', 1);
    const soft = computeFinishPlan(CLEAN, 'natural', 1);
    expect(sharp.params.sharpen).toBeLessThan(soft.params.sharpen / 2);
  });

  it('интенсивность линейно масштабирует дельты', () => {
    const full = computeFinishPlan(CLEAN, 'phone', 1);
    const half = computeFinishPlan(CLEAN, 'phone', 0.5);
    expect(half.params.grain.luma).toBeCloseTo(full.params.grain.luma / 2, 1);
    expect(Math.abs(half.params.eq.saturation - 1)).toBeLessThan(Math.abs(full.params.eq.saturation - 1));
  });

  it('phone добавляет реальную компрессию (crf растёт с интенсивностью)', () => {
    expect(computeFinishPlan(CLEAN, 'natural', 1).params.crf).toBe(18);
    const strong = computeFinishPlan(CLEAN, 'phone', 1).params.crf;
    const weak = computeFinishPlan(CLEAN, 'phone', 0.1).params.crf;
    expect(strong).toBeGreaterThan(weak);
    expect(weak).toBeGreaterThanOrEqual(19);
  });

  it('camera строит цепочку в порядке цвет → curves → тепло → зерно', () => {
    const plan = computeFinishPlan(CLEAN, 'camera', 1);
    const f = plan.filters;
    expect(f).toContain('eq=');
    expect(f).toContain("curves=master='");
    expect(f).toContain('colorbalance=');
    expect(f).toContain('noise=');
    expect(f.indexOf('eq=')).toBeLessThan(f.indexOf('noise='));
    expect(f.indexOf('curves=')).toBeLessThan(f.indexOf('colorbalance='));
    // тряски и геометрии в цепочке нет
    expect(f).not.toMatch(/crop|scale|rotate|shake|vibrance|fps=/);
  });

  it('bucketIntensity клампит и округляет до шага 0.1', () => {
    expect(bucketIntensity(0.34)).toBe(0.3);
    expect(bucketIntensity(2)).toBe(1);
    expect(bucketIntensity(-1)).toBe(0.1);
    expect(bucketIntensity(Number.NaN)).toBe(0.7);
  });
});

describe('meanOfStatKey', () => {
  it('усредняет значение ключа по кадрам печати signalstats', () => {
    const text = [
      'frame:0 pts:0 pts_time:0',
      'lavfi.signalstats.YAVG=100.0',
      'frame:1 pts:1 pts_time:1',
      'lavfi.signalstats.YAVG=50',
    ].join('\n');
    expect(meanOfStatKey(text, 'YAVG')).toBe(75);
    expect(meanOfStatKey(text, 'SATAVG')).toBeNull();
  });
});

// ── Роуты и жизненный цикл ──────────────────────────────────────────────────

describe('превью Reality Finish', () => {
  it('собирается, кэшируется и отдаётся медиа-роутом', async () => {
    const { projectId, genId } = seedDoneGeneration(authed.userId);
    const res = await authed.app.inject({
      method: 'POST',
      url: `/api/generations/${genId}/finish/preview`,
      payload: { mode: 'phone', intensity: 0.7 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as FinishPreviewInfo;
    expect(body.mode).toBe('phone');
    expect(body.intensity).toBe(0.7);
    expect(body.stats.sampledFrames).toBe(16);
    expect(fs.existsSync(path.join(finishDir(projectId), body.before))).toBe(true);
    expect(fs.existsSync(path.join(finishDir(projectId), body.after))).toBe(true);
    expect(execCalls.length).toBe(2); // before + after (замер застаблен)
    expect(previewCached(projectId, genId, 'phone', 0.7)).toBe(true);

    // повтор — целиком из кэша
    const again = await authed.app.inject({
      method: 'POST',
      url: `/api/generations/${genId}/finish/preview`,
      payload: { mode: 'phone', intensity: 0.7 },
    });
    expect(again.statusCode).toBe(200);
    expect(execCalls.length).toBe(2);

    // другая интенсивность — новый after, before переиспользуется
    const other = await authed.app.inject({
      method: 'POST',
      url: `/api/generations/${genId}/finish/preview`,
      payload: { mode: 'phone', intensity: 0.5 },
    });
    expect(other.statusCode).toBe(200);
    expect(execCalls.length).toBe(3);

    const media = await authed.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/media/finish/${body.after}`,
    });
    expect(media.statusCode).toBe(200);
  });

  it('гейты: не-done генерация 409, кривой режим 400, чужая генерация 404', async () => {
    const { genId } = seedDoneGeneration(authed.userId);
    getDb().prepare(`UPDATE generations SET status='rendering' WHERE id=?`).run(genId);
    const notDone = await authed.app.inject({
      method: 'POST',
      url: `/api/generations/${genId}/finish/preview`,
      payload: { mode: 'phone' },
    });
    expect(notDone.statusCode).toBe(409);
    getDb().prepare(`UPDATE generations SET status='done' WHERE id=?`).run(genId);

    const badMode = await authed.app.inject({
      method: 'POST',
      url: `/api/generations/${genId}/finish/preview`,
      payload: { mode: 'vhs' },
    });
    expect(badMode.statusCode).toBe(400);

    const foreignUser = randomUUID();
    getDb()
      .prepare(`INSERT INTO users (id, telegram_id, role) VALUES (?, 91777, 'user')`)
      .run(foreignUser);
    const foreign = seedDoneGeneration(foreignUser);
    const res = await authed.app.inject({
      method: 'POST',
      url: `/api/generations/${foreign.genId}/finish/preview`,
      payload: { mode: 'phone' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('409, когда файл рендера уже счищен ротацией', async () => {
    const { genId } = seedDoneGeneration(authed.userId);
    getDb().prepare(`UPDATE generations SET render_purged=1 WHERE id=?`).run(genId);
    const res = await authed.app.inject({
      method: 'POST',
      url: `/api/generations/${genId}/finish/preview`,
      payload: { mode: 'natural' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('дневной кап некэшированных превью — 429 после лимита', async () => {
    const capUser = randomUUID();
    getDb().prepare(`INSERT INTO users (id, telegram_id, role) VALUES (?, 91888, 'user')`).run(capUser);
    const capApp = await makeAuthedApp(91888, 'Кап-Юзер');
    const { genId } = seedDoneGeneration(capApp.userId);
    getDb()
      .prepare(`INSERT INTO usage_counters (user_id, day, kind, count) VALUES (?, ?, 'finish_preview', ?)`)
      .run(capApp.userId, dayKey(), config.limitFinishPreviewPerDay);
    const res = await capApp.app.inject({
      method: 'POST',
      url: `/api/generations/${genId}/finish/preview`,
      payload: { mode: 'phone' },
    });
    expect(res.statusCode).toBe(429);
  });
});

describe('применение Reality Finish ко всему ролику', () => {
  it('полный цикл: processing → done, файл в renders, DTO и медиа-роут видят его', async () => {
    const { projectId, genId } = seedDoneGeneration(authed.userId);
    const res = await authed.app.inject({
      method: 'POST',
      url: `/api/generations/${genId}/finish`,
      payload: { mode: 'camera', intensity: 1 },
    });
    expect(res.statusCode).toBe(200);
    await _waitFinishIdleForTests();

    const finished = path.join(rendersDir(projectId), finishedFileName(genId));
    expect(fs.existsSync(finished)).toBe(true);
    const json = finishJsonOf(genId);
    expect((json.job as Record<string, unknown>).status).toBe('done');
    expect(String((json.job as Record<string, unknown>).filters)).toContain('noise=');

    const proj = await authed.app.inject({ method: 'GET', url: `/api/projects/${projectId}` });
    const full = proj.json() as ProjectFull;
    const gen = full.generations.find((g) => g.id === genId)!;
    expect(gen.finish?.status).toBe('done');
    expect(gen.finish?.mode).toBe('camera');
    expect(gen.finish?.file).toBe(finishedFileName(genId));

    const media = await authed.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/media/renders/${finishedFileName(genId)}`,
    });
    expect(media.statusCode).toBe(200);

    // применённая обработка использует -c:a copy и passthrough, аудио не трогается
    const applyArgs = execCalls.find((args) => args.includes('copy'));
    expect(applyArgs).toBeDefined();
    expect(applyArgs).toContain('passthrough');
  });

  it('re-apply другого режима замещает файл, а «убрать обработку» оставляет оригинал', async () => {
    const { projectId, genId } = seedDoneGeneration(authed.userId);
    await authed.app.inject({
      method: 'POST',
      url: `/api/generations/${genId}/finish`,
      payload: { mode: 'camera', intensity: 1 },
    });
    await _waitFinishIdleForTests();
    const second = await authed.app.inject({
      method: 'POST',
      url: `/api/generations/${genId}/finish`,
      payload: { mode: 'natural', intensity: 0.5 },
    });
    expect(second.statusCode).toBe(200);
    await _waitFinishIdleForTests();
    const json = finishJsonOf(genId);
    expect((json.job as Record<string, unknown>).mode).toBe('natural');

    const del = await authed.app.inject({ method: 'DELETE', url: `/api/generations/${genId}/finish` });
    expect(del.statusCode).toBe(200);
    expect(fs.existsSync(path.join(rendersDir(projectId), finishedFileName(genId)))).toBe(false);
    expect(fs.existsSync(path.join(rendersDir(projectId), `gen_${genId}.mp4`))).toBe(true); // оригинал жив
    const cleared = finishJsonOf(genId);
    expect(cleared.job).toBeUndefined();
    expect(cleared.analysis).toBeDefined(); // замер остаётся — кэш пригоден
  });

  it('валидация контракта: изменившееся разрешение = failed, файл не публикуется', async () => {
    const { projectId, genId } = seedDoneGeneration(authed.userId);
    stubTools({
      probeVideo: async (file: string) =>
        file.includes('tmp_') ? { ...META, width: 640, height: 1136 } : { ...META },
    });
    await authed.app.inject({
      method: 'POST',
      url: `/api/generations/${genId}/finish`,
      payload: { mode: 'phone', intensity: 0.7 },
    });
    await _waitFinishIdleForTests();
    const json = finishJsonOf(genId);
    expect((json.job as Record<string, unknown>).status).toBe('failed');
    expect(String((json.job as Record<string, unknown>).error)).toContain('разрешение');
    expect(fs.existsSync(path.join(rendersDir(projectId), finishedFileName(genId)))).toBe(false);
    expect(fs.existsSync(path.join(finishDir(projectId), `tmp_${genId}.mp4`))).toBe(false);
    const row = getDb().prepare(`SELECT finish_file FROM generations WHERE id=?`).get(genId) as {
      finish_file: string | null;
    };
    expect(row.finish_file).toBeNull();
  });

  it('занятая обработка отбивает второй запуск 409', async () => {
    const { genId } = seedDoneGeneration(authed.userId);
    getDb()
      .prepare(`UPDATE generations SET finish_json=? WHERE id=?`)
      .run(JSON.stringify({ job: { status: 'processing', mode: 'phone', intensity: 1 } }), genId);
    const res = await authed.app.inject({
      method: 'POST',
      url: `/api/generations/${genId}/finish`,
      payload: { mode: 'phone' },
    });
    expect(res.statusCode).toBe(409);
    const del = await authed.app.inject({ method: 'DELETE', url: `/api/generations/${genId}/finish` });
    expect(del.statusCode).toBe(409); // и удалить нельзя, пока идёт
    getDb().prepare(`UPDATE generations SET finish_json=NULL WHERE id=?`).run(genId); // не мешаем resume-тесту
  });

  it('проект с идущей обработкой не удаляется из-под ffmpeg', async () => {
    const { projectId, genId } = seedDoneGeneration(authed.userId);
    getDb()
      .prepare(`UPDATE generations SET finish_json=? WHERE id=?`)
      .run(JSON.stringify({ job: { status: 'processing', mode: 'phone', intensity: 1 } }), genId);
    const res = await authed.app.inject({ method: 'DELETE', url: `/api/projects/${projectId}` });
    expect(res.statusCode).toBe(409);
    getDb().prepare(`UPDATE generations SET finish_json=NULL WHERE id=?`).run(genId);
    const ok = await authed.app.inject({ method: 'DELETE', url: `/api/projects/${projectId}` });
    expect(ok.statusCode).toBe(200);
  });

  it('дневной кап обработок — 429 после лимита', async () => {
    const capApp = await makeAuthedApp(91889, 'Кап-Финиш');
    const { genId } = seedDoneGeneration(capApp.userId);
    getDb()
      .prepare(`INSERT INTO usage_counters (user_id, day, kind, count) VALUES (?, ?, 'finish', ?)`)
      .run(capApp.userId, dayKey(), config.limitFinishPerDay);
    const res = await capApp.app.inject({
      method: 'POST',
      url: `/api/generations/${genId}/finish`,
      payload: { mode: 'natural' },
    });
    expect(res.statusCode).toBe(429);
  });

  it('resume после рестарта: повисшая processing помечается failed', async () => {
    const { genId } = seedDoneGeneration(authed.userId);
    getDb()
      .prepare(`UPDATE generations SET finish_json=? WHERE id=?`)
      .run(JSON.stringify({ job: { status: 'processing', mode: 'camera', intensity: 1 } }), genId);
    expect(resumeFinishJobs()).toBe(1);
    const json = finishJsonOf(genId);
    expect((json.job as Record<string, unknown>).status).toBe('failed');
    expect(String((json.job as Record<string, unknown>).error)).toContain('перезапуск');
  });
});

describe('гонки и капы (фиксы адверс-ревью)', () => {
  function counterOf(userId: string, kind: string): number {
    const row = getDb()
      .prepare(`SELECT count FROM usage_counters WHERE user_id=? AND day=? AND kind=?`)
      .get(userId, dayKey(), kind) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  it('параллельные превью двух режимов: один замер, атомарные файлы без tmp-хвостов', async () => {
    const { projectId, genId } = seedDoneGeneration(authed.userId);
    let measureCalls = 0;
    stubTools({
      measure: async () => {
        measureCalls++;
        await new Promise((r) => setTimeout(r, 40));
        return { ...CLEAN };
      },
    });
    const [a, b] = await Promise.all([
      authed.app.inject({
        method: 'POST',
        url: `/api/generations/${genId}/finish/preview`,
        payload: { mode: 'phone', intensity: 0.7 },
      }),
      authed.app.inject({
        method: 'POST',
        url: `/api/generations/${genId}/finish/preview`,
        payload: { mode: 'camera', intensity: 0.7 },
      }),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(measureCalls).toBe(1); // in-flight дедуп замера — один декод на генерацию
    const files = fs.readdirSync(finishDir(projectId));
    expect(files.some((f) => f.includes('.tmp-'))).toBe(false);
    expect(files).toContain(`fp_${genId}_orig.mp4`);
    expect(files).toContain(`fp_${genId}_phone_70.mp4`);
    expect(files).toContain(`fp_${genId}_camera_70.mp4`);
  });

  it('два одинаковых конкурентных превью тратят один юнит дневного лимита', async () => {
    const { genId } = seedDoneGeneration(authed.userId);
    stubTools({
      measure: async () => {
        await new Promise((r) => setTimeout(r, 40));
        return { ...CLEAN };
      },
    });
    const before = counterOf(authed.userId, 'finish_preview');
    const [a, b] = await Promise.all([
      authed.app.inject({
        method: 'POST',
        url: `/api/generations/${genId}/finish/preview`,
        payload: { mode: 'natural', intensity: 0.7 },
      }),
      authed.app.inject({
        method: 'POST',
        url: `/api/generations/${genId}/finish/preview`,
        payload: { mode: 'natural', intensity: 0.7 },
      }),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(counterOf(authed.userId, 'finish_preview') - before).toBe(1);
  });

  it('пер-юзерный кап одновременных обработок: третья подряд — 409', async () => {
    const capApp = await makeAuthedApp(91891, 'Очередь-Кап');
    const first = seedDoneGeneration(capApp.userId);
    const second = seedDoneGeneration(capApp.userId);
    const third = seedDoneGeneration(capApp.userId);
    const processing = JSON.stringify({ job: { status: 'processing', mode: 'phone', intensity: 1 } });
    getDb().prepare(`UPDATE generations SET finish_json=? WHERE id=?`).run(processing, first.genId);
    getDb().prepare(`UPDATE generations SET finish_json=? WHERE id=?`).run(processing, second.genId);
    const res = await capApp.app.inject({
      method: 'POST',
      url: `/api/generations/${third.genId}/finish`,
      payload: { mode: 'natural' },
    });
    expect(res.statusCode).toBe(409);
    getDb().prepare(`UPDATE generations SET finish_json=NULL WHERE id IN (?, ?)`).run(first.genId, second.genId);
    const ok = await capApp.app.inject({
      method: 'POST',
      url: `/api/generations/${third.genId}/finish`,
      payload: { mode: 'natural' },
    });
    expect(ok.statusCode).toBe(200);
    await _waitFinishIdleForTests();
  });

  it('часовой авто-клинап не удаляет проект с идущей обработкой', async () => {
    const cleanApp = await makeAuthedApp(91892, 'Клинап');
    const { projectId, genId } = seedDoneGeneration(cleanApp.userId);
    getDb()
      .prepare(`UPDATE generations SET finish_json=? WHERE id=?`)
      .run(JSON.stringify({ job: { status: 'processing', mode: 'camera', intensity: 1 } }), genId);
    cleanupInvisibleProjects(cleanApp.userId, 0);
    expect(getDb().prepare(`SELECT 1 FROM projects WHERE id=?`).get(projectId)).toBeTruthy();
    getDb().prepare(`UPDATE generations SET finish_json=NULL WHERE id=?`).run(genId);
    cleanupInvisibleProjects(cleanApp.userId, 0);
    expect(getDb().prepare(`SELECT 1 FROM projects WHERE id=?`).get(projectId)).toBeFalsy();
  });
});

describe('хранилище: уборка кэша и ротация артефактов', () => {
  it('sweep: свежий кэш живёт, старый и осиротевший — удаляются, finish-файл не считается сиротой', async () => {
    const { projectId, genId } = seedDoneGeneration(authed.userId);
    await authed.app.inject({
      method: 'POST',
      url: `/api/generations/${genId}/finish/preview`,
      payload: { mode: 'natural', intensity: 0.7 },
    });
    await authed.app.inject({
      method: 'POST',
      url: `/api/generations/${genId}/finish`,
      payload: { mode: 'natural', intensity: 0.7 },
    });
    await _waitFinishIdleForTests();
    const orphan = path.join(finishDir(projectId), `fp_${randomUUID()}_orig.mp4`);
    fs.writeFileSync(orphan, 'x');

    sweepTransientProjectFiles(Date.now());
    expect(fs.existsSync(orphan)).toBe(false); // генерации нет — файл сирота
    expect(fs.existsSync(path.join(finishDir(projectId), `fp_${genId}_orig.mp4`))).toBe(true);
    expect(fs.existsSync(path.join(rendersDir(projectId), finishedFileName(genId)))).toBe(true);

    sweepTransientProjectFiles(Date.now() + 49 * 3_600_000);
    expect(fs.existsSync(path.join(finishDir(projectId), `fp_${genId}_orig.mp4`))).toBe(false);
    expect(fs.existsSync(path.join(rendersDir(projectId), finishedFileName(genId)))).toBe(true);
  });

  it('ротация последних результатов уносит и Reality Finish артефакты', async () => {
    const rotApp = await makeAuthedApp(91890, 'Ротация');
    const { projectId, genId } = seedDoneGeneration(rotApp.userId);
    await rotApp.app.inject({
      method: 'POST',
      url: `/api/generations/${genId}/finish`,
      payload: { mode: 'phone', intensity: 1 },
    });
    await _waitFinishIdleForTests();
    expect(fs.existsSync(path.join(rendersDir(projectId), finishedFileName(genId)))).toBe(true);

    const purged = enforceLatestResultLimit(rotApp.userId, 0);
    expect(purged).toContain(genId);
    expect(fs.existsSync(path.join(rendersDir(projectId), finishedFileName(genId)))).toBe(false);
    const row = getDb()
      .prepare(`SELECT finish_file, finish_json, render_purged FROM generations WHERE id=?`)
      .get(genId) as { finish_file: string | null; finish_json: string | null; render_purged: number };
    expect(row.render_purged).toBe(1);
    expect(row.finish_file).toBeNull();
    expect(row.finish_json).toBeNull();
  });
});
