import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-render-test-'));
process.env.WAVESPEED_API_KEY = 'test-key';
process.env.OPENAI_API_KEY = 'test-key';
process.env.AUTH_DEV_BYPASS = '1'; // роут-тесты логинятся dev-входом (см. helpers.makeAuthedApp)

const { getDb } = await import('../src/db');
const {
  startRender,
  retryGeneration,
  recheckGeneration,
  resumeGenerations,
  activeGeneration,
  latestStartFrame,
  parseGenerateAudio,
  RenderGateError,
  _setPollBaseMs,
} = await import('../src/engine/render');
_setPollBaseMs(5);
const { advanceFlow } = await import('../src/engine/pipeline');
const { ensureLitellmFresh, estimateRender, getBalanceCached, _resetPricingMemory } = await import(
  '../src/pricing'
);
const { makeAuthedApp } = await import('./helpers');
const { projectDir, refsDir, startDir, rendersDir, safeMediaPath } = await import('../src/storage');
const { config } = await import('../src/config');
import type { WaveSpeed, WsPrediction } from '../src/wavespeed';

const LIVE_FORMULA =
  '{"total_price": 75000 * (resolution = "4k" ? 10 : (resolution = "1080p" ? 5 : (resolution = "720p" ? 2 : 1))) * ($max([2, $ceil($min([$number($ceil(get_duration_v3(video))), 15]))]) + (duration ? $number(duration) : $max([4, $min([15, $ceil($number($ceil(get_duration_v3(video))))])])))}';

interface FakeWsOpts {
  pollScript?: Array<Partial<WsPrediction> | Error>;
  balances?: number[];
  uploadLog?: string[];
  submitLog?: Record<string, unknown>[];
  downloadBytes?: number;
}

function fakeWs(o: FakeWsOpts = {}): WaveSpeed {
  let pollIdx = 0;
  let balIdx = 0;
  return {
    uploadBinary: async (p: string) => {
      o.uploadLog?.push(path.basename(p));
      return `https://cdn/${path.basename(p)}-${o.uploadLog?.length ?? 0}`;
    },
    submitVideoEdit: async (payload: Record<string, unknown>) => {
      o.submitLog?.push(payload);
      return `pred-${o.submitLog?.length ?? 1}`;
    },
    pollResult: async (id: string): Promise<WsPrediction> => {
      const step = o.pollScript?.[Math.min(pollIdx, (o.pollScript?.length ?? 1) - 1)];
      pollIdx++;
      if (step instanceof Error) throw step;
      return {
        id,
        status: 'completed',
        outputs: ['https://cdn/out.mp4'],
        error: '',
        raw: {},
        ...(step ?? {}),
      };
    },
    downloadOutput: async (_url: string, dest: string) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.alloc(o.downloadBytes ?? 1000, 1));
      return o.downloadBytes ?? 1000;
    },
    getBalance: async () => {
      const b = o.balances?.[Math.min(balIdx, (o.balances?.length ?? 1) - 1)] ?? 3.92;
      balIdx++;
      return b;
    },
    fetchModelEntry: async () => ({
      model_id: config.seedanceEndpoint,
      base_price: 0.75,
      formula: LIVE_FORMULA,
    }),
  } as WaveSpeed;
}

async function until(fn: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout в ожидании условия');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function genRow(id: string) {
  return getDb().prepare(`SELECT * FROM generations WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
}

// Легаси-тесты эмулируют ВЛАДЕЛЬЦА (unmetered): движок рендера/ретраев не зависит
// от кредитов. Кредитная механика тестируется отдельно в credits.test.ts.
const OWNER_TEST_ID = 'owner-render-tests';
getDb().prepare(`INSERT INTO users (id, telegram_id, role) VALUES (?, 4242, 'owner')`).run(OWNER_TEST_ID);

/** Проект, готовый к рендеру: видео+рефы на диске, промты v1, старт-кадр v1. */
function readyProject(id = randomUUID()): string {
  const db = getDb();
  db.prepare(
    `INSERT INTO projects (id, user_id, title, status, video_file, video_bytes, meta_json, frames_json, analysis_json)
     VALUES (?, ?, 'test', 'complete', 'source.mp4', 3000, ?, '[]', '{}')`,
  ).run(id, OWNER_TEST_ID, JSON.stringify({ durationSec: 6, width: 1080, height: 1920, fps: 30, aspect: '9:16', sizeBytes: 3000 }));
  fs.mkdirSync(refsDir(id), { recursive: true });
  fs.mkdirSync(startDir(id), { recursive: true });
  fs.writeFileSync(path.join(projectDir(id), 'source.mp4'), Buffer.alloc(3000, 2));
  db.prepare(`INSERT INTO refs (id, project_id, idx, role, file) VALUES (?, ?, 0, 'model', 'ref_a.jpg')`).run(
    `${id}-r1`,
    id,
  );
  db.prepare(`INSERT INTO refs (id, project_id, idx, role, file) VALUES (?, ?, 1, 'vehicle', 'ref_b.jpg')`).run(
    `${id}-r2`,
    id,
  );
  fs.writeFileSync(path.join(refsDir(id), 'ref_a.jpg'), 'a');
  fs.writeFileSync(path.join(refsDir(id), 'ref_b.jpg'), 'b');
  db.prepare(
    `INSERT INTO prompts (id, project_id, version, kind, text, flags_json) VALUES (?, ?, 1, 'video', 'VIDEO PROMPT TEXT', '{}')`,
  ).run(randomUUID(), id);
  db.prepare(
    `INSERT INTO prompts (id, project_id, version, kind, text, flags_json) VALUES (?, ?, 1, 'image', 'IMAGE PROMPT TEXT', '{}')`,
  ).run(randomUUID(), id);
  fs.writeFileSync(path.join(startDir(id), 'start_v1_2026-07-16T00-00-00.png'), 'png');
  return id;
}

function finishActive(): void {
  getDb()
    .prepare(
      `UPDATE generations SET status='failed', error='test-cleanup' WHERE status IN ('uploading_assets','submitted','rendering','downloading')`,
    )
    .run();
}

describe('рендер: happy path', () => {
  it('upload → submit → poll → download → done; payload и стоимость по дельте баланса', async () => {
    const uploadLog: string[] = [];
    const submitLog: Record<string, unknown>[] = [];
    const ws = fakeWs({
      uploadLog,
      submitLog,
      pollScript: [{ status: 'processing' }, { status: 'completed', outputs: ['https://cdn/out.mp4'] }],
      balances: [3.92, 2.12], // before-сабмит, after-завершение → дельта $1.80
    });
    const pid = readyProject();
    const genId = startRender(pid, 1, { ws, pollBaseMs: 5 });
    expect(activeGeneration()?.id).toBe(genId);

    await until(() => genRow(genId)?.status === 'done');
    const g = genRow(genId)!;
    // ассеты: видео + старт-кадр + 2 рефа
    expect(uploadLog).toEqual(['source.mp4', 'start_v1_2026-07-16T00-00-00.png', 'ref_a.jpg', 'ref_b.jpg']);
    const payload = submitLog[0]!;
    expect(payload.prompt).toBe('VIDEO PROMPT TEXT');
    expect(payload.aspect_ratio).toBe('9:16');
    expect(payload.resolution).toBe('720p');
    expect(payload.generate_audio).toBe(true);
    expect((payload.reference_images as string[]).length).toBe(3);
    expect((payload.reference_images as string[])[0]).toContain('start_v1');
    expect(g.file).toBe(`gen_${genId}.mp4`);
    expect(fs.existsSync(path.join(rendersDir(pid), `gen_${genId}.mp4`))).toBe(true);
    expect(g.cost_source).toBe('balance_delta');
    expect(g.cost_actual_usd).toBeCloseTo(1.8, 4);
    expect(g.ws_prediction_id).toBe('pred-1');
    expect(activeGeneration()).toBeNull();
  });

  it('прямое поле стоимости в ответе → cost_source=api (µ$ конвертируются)', async () => {
    const ws = fakeWs({
      pollScript: [{ status: 'completed', raw: { cost: 1_800_000 } }],
    });
    const pid = readyProject();
    const genId = startRender(pid, 1, { ws, pollBaseMs: 5 });
    await until(() => genRow(genId)?.status === 'done');
    const g = genRow(genId)!;
    expect(g.cost_source).toBe('api');
    expect(g.cost_actual_usd).toBeCloseTo(1.8, 4);
  });

  it('стоимость в центах не превращается в $180: санити-окно по смете выбирает единицу', async () => {
    // 6с @720p → смета $1.80, cap ×3 = $5.40: 180 (центы) не проходит как USD, проходит /100
    const ws = fakeWs({
      pollScript: [{ status: 'completed', raw: { cost: 180 } }],
    });
    const pid = readyProject();
    const genId = startRender(pid, 1, { ws, pollBaseMs: 5 });
    await until(() => genRow(genId)?.status === 'done');
    const g = genRow(genId)!;
    expect(g.cost_source).toBe('api');
    expect(g.cost_actual_usd).toBeCloseTo(1.8, 4);
  });

  it('NSFW-флаг из ответа попадает в notes предупреждением', async () => {
    const ws = fakeWs({
      pollScript: [{ status: 'completed', raw: { has_nsfw_contents: [true] } }],
    });
    const pid = readyProject();
    const genId = startRender(pid, 1, { ws, pollBaseMs: 5 });
    await until(() => genRow(genId)?.status === 'done');
    expect(String(genRow(genId)!.notes)).toContain('NSFW');
  });
});

describe('рендер: ошибки и ретраи', () => {
  it('WS failed → человеческая причина; retry переиспользует свежие URL и несёт их на своей строке', async () => {
    const uploadLog: string[] = [];
    const ws = fakeWs({ uploadLog, pollScript: [{ status: 'failed', error: 'nsfw content detected' }] });
    const pid = readyProject();
    const genId = startRender(pid, 1, { ws, pollBaseMs: 5 });
    await until(() => genRow(genId)?.status === 'failed');
    expect(String(genRow(genId)!.error)).toContain('модерацией');
    expect(uploadLog.length).toBe(4);

    // retry: пре-полл видит, что задача у WS реально failed → новый сабмит;
    // ассеты свежие → ни одной новой загрузки
    const ws2 = fakeWs({ uploadLog, pollScript: [{ status: 'failed', error: 'nsfw' }, { status: 'completed' }] });
    const retryId = await retryGeneration(genId, ws2);
    await until(() => genRow(retryId)?.status === 'done');
    expect(uploadLog.length).toBe(4); // не выросло
    expect(genRow(retryId)!.retry_of).toBe(genId);
    // фикс адверс-ревью №7: полностью переиспользованный ретрай хранит ассеты на СВОЕЙ строке
    expect(genRow(retryId)!.ws_assets_json).toBeTruthy();

    // ретрай-от-ретрая тоже не перезаливает
    getDb().prepare(`UPDATE generations SET status='failed', error='x' WHERE id = ?`).run(retryId);
    const ws3 = fakeWs({ uploadLog, pollScript: [{ status: 'failed', error: 'x' }, { status: 'completed' }] });
    const retry2 = await retryGeneration(retryId, ws3);
    await until(() => genRow(retry2)?.status === 'done');
    expect(uploadLog.length).toBe(4); // всё ещё не выросло
  });

  it('retry при живой задаче: completed → добираем БЕЗ второго сабмита; processing → 409', async () => {
    const pid = readyProject();
    const mk = (predId: string) => {
      const gid = randomUUID();
      getDb()
        .prepare(
          `INSERT INTO generations (id, project_id, version, status, error, ws_prediction_id, params_json, submitted_at)
           VALUES (?, ?, 1, 'failed', 'таймаут', ?, '{"resolution":"720p"}', datetime('now'))`,
        )
        .run(gid, pid, predId);
      return gid;
    };
    // задача успела дорендериться → retry восстанавливает ту же генерацию, submit не зовётся
    const submitLog: Record<string, unknown>[] = [];
    const doneId = mk('pred-alive-1');
    const recovered = await retryGeneration(doneId, fakeWs({ submitLog, pollScript: [{ status: 'completed' }] }));
    expect(recovered).toBe(doneId);
    expect(genRow(doneId)!.status).toBe('done');
    expect(submitLog.length).toBe(0); // деньги не списаны второй раз

    // задача ещё рендерится → 409, никакого нового сабмита
    const busyId = mk('pred-alive-2');
    await expect(retryGeneration(busyId, fakeWs({ pollScript: [{ status: 'processing' }] }))).rejects.toThrow(
      /Проверить ещё раз/,
    );

    // статус недоступен (сеть) → 502, вслепую не пересабмитим
    const darkId = mk('pred-alive-3');
    await expect(retryGeneration(darkId, fakeWs({ pollScript: [new Error('net down')] }))).rejects.toThrow(
      /двойным списанием/,
    );
  });

  it('протухшие URL (>6 дней) перезаливаются', async () => {
    const pid = readyProject();
    const staleAt = new Date(Date.now() - 6.5 * 24 * 3600_000).toISOString();
    const failedId = randomUUID();
    getDb()
      .prepare(
        `INSERT INTO generations (id, project_id, version, status, error, ws_assets_json, params_json)
         VALUES (?, ?, 1, 'failed', 'x', ?, '{"resolution":"720p","generate_audio":true}')`,
      )
      .run(
        failedId,
        pid,
        JSON.stringify({
          video: { url: 'https://cdn/old', at: staleAt },
          start: { url: 'https://cdn/old2', at: staleAt },
          refs: {},
        }),
      );
    const uploadLog: string[] = [];
    const ws = fakeWs({ uploadLog, pollScript: [{ status: 'completed' }] });
    const retryId = await retryGeneration(failedId, ws);
    await until(() => genRow(retryId)?.status === 'done');
    expect(uploadLog.length).toBe(4); // всё заново
  });

  it('поллер терпит 4 сетевые ошибки, 5-я подряд → failed с подсказкой recheck', async () => {
    const ws = fakeWs({
      pollScript: [new Error('net'), new Error('net'), new Error('net'), new Error('net'), new Error('net')],
    });
    const pid = readyProject();
    const genId = startRender(pid, 1, { ws, pollBaseMs: 5 });
    await until(() => genRow(genId)?.status === 'failed');
    expect(String(genRow(genId)!.error)).toContain('Проверить ещё раз');
  });

  it('бюджет поллинга исчерпан → failed, prediction_id сохранён; recheck добирает результат', async () => {
    const ws = fakeWs({ pollScript: [{ status: 'processing' }] });
    const pid = readyProject();
    const genId = startRender(pid, 1, { ws, pollBaseMs: 5 });
    await until(() => genRow(genId)?.status === 'rendering' || genRow(genId)?.status === 'submitted');
    // отматываем submitted_at за бюджет
    getDb()
      .prepare(`UPDATE generations SET submitted_at = datetime('now', '-31 minutes') WHERE id = ?`)
      .run(genId);
    await until(() => genRow(genId)?.status === 'failed');
    expect(genRow(genId)!.ws_prediction_id).toBe('pred-1');
    expect(String(genRow(genId)!.error)).toContain('Проверить ещё раз');

    const wsDone = fakeWs({ pollScript: [{ status: 'completed' }] });
    const st = await recheckGeneration(genId, wsDone);
    expect(st).toBe('done');
    expect(genRow(genId)!.status).toBe('done');
  });

  it('recheck: ещё processing → возвращаемся в rendering и поллер добивает', async () => {
    const pid = readyProject();
    const genId = randomUUID();
    getDb()
      .prepare(
        `INSERT INTO generations (id, project_id, version, status, error, ws_prediction_id, params_json, submitted_at)
         VALUES (?, ?, 1, 'failed', 'таймаут', 'pred-77', '{"resolution":"720p"}', datetime('now'))`,
      )
      .run(genId, pid);
    const ws = fakeWs({ pollScript: [{ status: 'processing' }, { status: 'completed' }] });
    const st = await recheckGeneration(genId, ws);
    expect(st).toBe('rendering');
    await until(() => genRow(genId)?.status === 'done');
  });
});

describe('рендер: гейты', () => {
  it('баланс меньше сметы → генерация failed с «пополни» ещё до загрузок', async () => {
    const uploadLog: string[] = [];
    const ws = fakeWs({ uploadLog, balances: [0.5] }); // 6с @720p ≈ $1.80 > $0.50
    const pid = readyProject();
    const genId = startRender(pid, 1, { ws, pollBaseMs: 5 });
    await until(() => genRow(genId)?.status === 'failed');
    expect(String(genRow(genId)!.error)).toContain('пополни');
    expect(uploadLog.length).toBe(0); // деньги проверены раньше трафика
  });

  it('второй рендер при активном → в FIFO-очередь; повтор на том же проекте → 409', async () => {
    const pid = readyProject();
    const pid2 = readyProject();
    const ws = fakeWs({ pollScript: [{ status: 'processing' }] });
    startRender(pid, 1, { ws, pollBaseMs: 5 });
    // чужой слот занят → не отказ, а очередь (v4)
    const queued = startRender(pid2, 1, { ws, pollBaseMs: 5 });
    expect(genRow(queued)!.status).toBe('queued');
    // а вот второй рендер ТОГО ЖЕ проекта — по-прежнему 409
    expect(() => startRender(pid2, 1, { ws })).toThrow(RenderGateError);
    try {
      startRender(pid2, 1, { ws });
    } catch (e) {
      expect((e as InstanceType<typeof RenderGateError>).httpStatus).toBe(409);
    }
    finishActive();
    getDb().prepare(`UPDATE generations SET status='failed', error='cleanup' WHERE status = 'queued'`).run();
  });

  it('нет промтов/старт-кадра/исходника → говорящие 409', () => {
    const db = getDb();
    const bare = randomUUID();
    db.prepare(
      `INSERT INTO projects (id, video_file, video_bytes, meta_json) VALUES (?, 'source.mp4', 1, '{"durationSec":6}')`,
    ).run(bare);
    fs.mkdirSync(projectDir(bare), { recursive: true });
    fs.writeFileSync(path.join(projectDir(bare), 'source.mp4'), 'v');
    expect(() => startRender(bare, 1, { ws: fakeWs() })).toThrow(/промтов/);

    const noStart = readyProject();
    fs.rmSync(startDir(noStart), { recursive: true, force: true });
    expect(() => startRender(noStart, 1, { ws: fakeWs() })).toThrow(/стартового кадра/);

    const purged = readyProject();
    db.prepare(`UPDATE projects SET video_purged = 1 WHERE id = ?`).run(purged);
    expect(() => startRender(purged, 1, { ws: fakeWs() })).toThrow(/ротацией/);
  });
});

describe('resume после рестарта', () => {
  it('uploading_assets → failed; submitted и упавший мид-download → поллер добирает до done', async () => {
    finishActive(); // страховка от хвостов предыдущих тестов
    const pid = readyProject();
    const upId = randomUUID();
    const subId = randomUUID();
    const dlId = randomUUID();
    const db = getDb();
    db.prepare(
      `INSERT INTO generations (id, project_id, version, status, params_json) VALUES (?, ?, 1, 'uploading_assets', '{}')`,
    ).run(upId, pid);
    db.prepare(
      `INSERT INTO generations (id, project_id, version, status, ws_prediction_id, params_json, submitted_at)
       VALUES (?, ?, 1, 'submitted', 'pred-resume', '{"resolution":"720p"}', datetime('now'))`,
    ).run(subId, pid);
    // сервис умер посреди скачивания: строка зависла в downloading
    db.prepare(
      `INSERT INTO generations (id, project_id, version, status, ws_prediction_id, params_json, submitted_at)
       VALUES (?, ?, 1, 'downloading', 'pred-dl', '{"resolution":"720p"}', datetime('now'))`,
    ).run(dlId, pid);
    const r = resumeGenerations(fakeWs({ pollScript: [{ status: 'completed' }] }));
    expect(r.failed).toBe(1);
    expect(r.resumed).toBe(2);
    expect(String(genRow(upId)!.error)).toContain('Повторить рендер');
    await until(() => genRow(subId)?.status === 'done');
    await until(() => genRow(dlId)?.status === 'done');
  });
});

describe('гвард двойного финала', () => {
  it('recheck на генерации, уже уходящей в downloading, не запускает второй стрим', async () => {
    finishActive();
    const pid = readyProject();
    const gid = randomUUID();
    getDb()
      .prepare(
        `INSERT INTO generations (id, project_id, version, status, ws_prediction_id, params_json, submitted_at)
         VALUES (?, ?, 1, 'downloading', 'pred-dfg', '{"resolution":"720p"}', datetime('now'))`,
      )
      .run(gid, pid);
    let downloads = 0;
    const ws = fakeWs({ pollScript: [{ status: 'completed' }] });
    const origDownload = ws.downloadOutput.bind(ws);
    (ws as { downloadOutput: typeof ws.downloadOutput }).downloadOutput = async (u, d, m) => {
      downloads++;
      return origDownload(u, d, m);
    };
    // статус 'downloading' не входит в источники флипа → вторая цепочка обязана молча выйти
    await recheckGeneration(gid, ws);
    expect(downloads).toBe(0);
    expect(genRow(gid)!.status).toBe('downloading');
    finishActive();
  });
});

describe('вспомогательное', () => {
  it('latestStartFrame берёт самый свежий файл версии; parseGenerateAudio дефолтит в true', () => {
    const pid = readyProject();
    fs.writeFileSync(path.join(startDir(pid), 'start_v1_2026-07-16T09-00-00.png'), 'png2');
    expect(latestStartFrame(pid, 1)).toBe('start_v1_2026-07-16T09-00-00.png');
    expect(latestStartFrame(pid, 9)).toBeNull();
    expect(parseGenerateAudio(null)).toBe(true);
    expect(parseGenerateAudio('{"generateAudio":false}')).toBe(false);
    expect(parseGenerateAudio('{"removeText":true}')).toBe(true);
  });

  it('safeMediaPath понимает renders и режет traversal', () => {
    const pid = readyProject();
    fs.mkdirSync(rendersDir(pid), { recursive: true });
    fs.writeFileSync(path.join(rendersDir(pid), 'gen_x.mp4'), 'v');
    expect(safeMediaPath(pid, 'renders', 'gen_x.mp4')).toBeTruthy();
    expect(safeMediaPath(pid, 'renders', '../source.mp4')).toBeNull();
  });
});

describe('роуты: rating-мост и ручной рендер', () => {
  it('rating 👍 создаёт feedback, флип на 👎 обновляет ту же строку', async () => {
    const { app, own } = await makeAuthedApp();
    const pid = readyProject();
    own(pid);
    const genId = randomUUID();
    getDb()
      .prepare(
        `INSERT INTO generations (id, project_id, version, status, file, params_json) VALUES (?, ?, 1, 'done', 'gen.mp4', '{}')`,
      )
      .run(genId, pid);

    const up = await app.inject({
      method: 'POST',
      url: `/api/generations/${genId}/rating`,
      payload: { rating: 1, artifacts: [], notes: 'отлично' },
    });
    expect(up.statusCode).toBe(200);
    const fb1 = getDb()
      .prepare(`SELECT * FROM feedback WHERE project_id = ?`)
      .all(pid) as Array<{ id: string; worked: number; notes: string }>;
    expect(fb1.length).toBe(1);
    expect(fb1[0]!.worked).toBe(1);

    const down = await app.inject({
      method: 'POST',
      url: `/api/generations/${genId}/rating`,
      payload: { rating: -1, artifacts: ['identity_bleed'], notes: 'лицо поплыло' },
    });
    expect(down.statusCode).toBe(200);
    const fb2 = getDb()
      .prepare(`SELECT * FROM feedback WHERE project_id = ?`)
      .all(pid) as Array<{ id: string; worked: number }>;
    expect(fb2.length).toBe(1); // та же строка, не вторая
    expect(fb2[0]!.worked).toBe(0);
    expect(fb2[0]!.id).toBe(fb1[0]!.id);
    const g = genRow(genId)!;
    expect(g.rating).toBe(-1);
    expect(String(g.artifacts_json)).toContain('identity_bleed');
    await app.close();
  });

  it('POST /projects/:id/generations при чужом активном рендере → задача в очереди (v4)', async () => {
    const { app, own } = await makeAuthedApp();
    const pid = readyProject();
    own(pid);
    getDb()
      .prepare(
        `INSERT INTO generations (id, project_id, version, status, params_json) VALUES (?, ?, 1, 'rendering', '{}')`,
      )
      .run(randomUUID(), readyProject());
    const res = await app.inject({ method: 'POST', url: `/api/projects/${pid}/generations`, payload: {} });
    expect(res.statusCode).toBe(200);
    const genId = (JSON.parse(res.body) as { id: string }).id;
    expect(genRow(genId)!.status).toBe('queued');
    // повторный запуск того же проекта, пока задача в очереди — 409
    const again = await app.inject({ method: 'POST', url: `/api/projects/${pid}/generations`, payload: {} });
    expect(again.statusCode).toBe(409);
    finishActive();
    getDb().prepare(`UPDATE generations SET status='failed', error='cleanup' WHERE status = 'queued'`).run();
    await app.close();
  });

  it('POST /swap: гейты рефов и флаги пишутся; flow=auto', async () => {
    _resetPricingMemory();
    // Тёплые кэши, чтобы /swap не ходил в сеть: litellm + тариф WS + баланс
    const manifest = {
      'gpt-5.6-terra': { input_cost_per_token: 2.5e-6, output_cost_per_token: 1.5e-5 },
      'gpt-5.6-luna': { input_cost_per_token: 1e-6, output_cost_per_token: 6e-6 },
      'gpt-image-2': { input_cost_per_token: 5e-6, output_cost_per_token: 1e-5 },
    };
    await ensureLitellmFresh(
      (async () => new Response(JSON.stringify(manifest), { status: 200 })) as unknown as typeof fetch,
    );
    await estimateRender(6, fakeWs());
    await getBalanceCached(fakeWs({ balances: [10] }), true);

    const { app, own } = await makeAuthedApp();
    const pid = readyProject();
    own(pid);
    getDb().prepare(`DELETE FROM refs WHERE project_id = ? AND role = 'model'`).run(pid);
    const noModel = await app.inject({ method: 'POST', url: `/api/projects/${pid}/swap`, payload: {} });
    expect(noModel.statusCode).toBe(409);
    expect(JSON.parse(noModel.body).error).toContain('модель');

    const pid2 = readyProject();
    own(pid2);
    const ok = await app.inject({
      method: 'POST',
      url: `/api/projects/${pid2}/swap`,
      payload: { flags: { removeText: true, enhanceFigure: false }, generateAudio: false },
    });
    expect(ok.statusCode).toBe(200);
    const p = getDb().prepare(`SELECT flow, flags_json, flow_started_at FROM projects WHERE id = ?`).get(pid2) as {
      flow: string;
      flags_json: string;
      flow_started_at: string | null;
    };
    expect(p.flow).toBe('auto');
    expect(p.flow_started_at).toBeTruthy();
    expect(JSON.parse(p.flags_json)).toEqual({ removeText: true, enhanceFigure: false, wish: '', generateAudio: false });
    finishActive();
    await app.close();
  });

  it('POST /swap без поля звука сохраняет настройку проекта (не затирает дефолтом)', async () => {
    const { app, own } = await makeAuthedApp();
    const pid = readyProject();
    own(pid);
    getDb().prepare(`UPDATE projects SET flags_json = '{"generateAudio":false}' WHERE id = ?`).run(pid);
    const ok = await app.inject({
      method: 'POST',
      url: `/api/projects/${pid}/swap`,
      payload: { flags: { removeText: false, enhanceFigure: false } },
    });
    expect(ok.statusCode).toBe(200);
    const p = getDb().prepare(`SELECT flags_json FROM projects WHERE id = ?`).get(pid) as { flags_json: string };
    expect((JSON.parse(p.flags_json) as { generateAudio: boolean }).generateAudio).toBe(false);
    finishActive();
    await app.close();
  });

  it('повторный /swap при готовом рендере запускает новый рендер, при failed → 409 с подсказкой', async () => {
    const { app, own } = await makeAuthedApp();
    // done-ветка: всё готово, последний рендер done → явный клик = «прогнать ещё раз»
    const pid = readyProject();
    own(pid);
    getDb()
      .prepare(
        `INSERT INTO generations (id, project_id, version, status, file, params_json) VALUES (?, ?, 1, 'done', 'gen.mp4', '{}')`,
      )
      .run(randomUUID(), pid);
    const again = await app.inject({
      method: 'POST',
      url: `/api/projects/${pid}/swap`,
      payload: { flags: { removeText: false, enhanceFigure: false } },
    });
    expect(again.statusCode).toBe(200);
    const gens = getDb()
      .prepare(`SELECT COUNT(*) AS c FROM generations WHERE project_id = ?`)
      .get(pid) as { c: number };
    expect(gens.c).toBe(2); // не молчаливый no-op — новый рендер стартовал
    finishActive();

    // failed-ветка: авто-пересабмит запрещён — 409 направляет к recheck/retry
    const pid2 = readyProject();
    own(pid2);
    getDb()
      .prepare(
        `INSERT INTO generations (id, project_id, version, status, error, ws_prediction_id, params_json)
         VALUES (?, ?, 1, 'failed', 'таймаут', 'pred-z', '{}')`,
      )
      .run(randomUUID(), pid2);
    const blocked = await app.inject({
      method: 'POST',
      url: `/api/projects/${pid2}/swap`,
      payload: { flags: { removeText: false, enhanceFigure: false } },
    });
    expect(blocked.statusCode).toBe(409);
    expect(JSON.parse(blocked.body).error).toContain('Проверить ещё раз');
    expect(
      (getDb().prepare(`SELECT COUNT(*) AS c FROM generations WHERE project_id = ?`).get(pid2) as { c: number }).c,
    ).toBe(1);
    await app.close();
  });

  it('iterate синхронизирует галочки проекта с итерируемой версией (advanceFlow не перетрёт фиксы)', async () => {
    const { app, own } = await makeAuthedApp();
    const pid = readyProject(); // prompts v1 с flags '{}' → оба false
    own(pid);
    getDb()
      .prepare(
        `UPDATE projects SET flow = 'auto', flags_json = '{"removeText":true,"enhanceFigure":false,"generateAudio":false}' WHERE id = ?`,
      )
      .run(pid);
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${pid}/iterate`,
      payload: { version: 1, artifacts: ['identity_bleed'], notes: 'лицо' },
    });
    expect(res.statusCode).toBe(200);
    const p = getDb().prepare(`SELECT flags_json FROM projects WHERE id = ?`).get(pid) as { flags_json: string };
    const flags = JSON.parse(p.flags_json) as { removeText: boolean; generateAudio: boolean };
    expect(flags.removeText).toBe(false); // синк с версией 1
    expect(flags.generateAudio).toBe(false); // звук не тронут
    await app.close();
  });

  it('денежные POST без same-origin (cross-site) → 403', async () => {
    const { app } = await makeAuthedApp();
    for (const url of [
      '/api/generations/xxx/retry',
      '/api/generations/xxx/recheck',
      '/api/generations/xxx/rating',
      '/api/projects/yyy/generations',
    ]) {
      const res = await app.inject({ method: 'POST', url, headers: { 'sec-fetch-site': 'cross-site' } });
      expect(res.statusCode).toBe(403);
    }
    await app.close();
  });
});

describe('advanceFlow: не трогает manual и останавливается с ошибкой при гейте', () => {
  it('flow=manual → no-op; flow=auto с очищенным исходником → error в проекте', () => {
    const pid = readyProject();
    advanceFlow(pid); // manual — ничего не происходит
    expect(activeGeneration()).toBeNull();

    getDb()
      .prepare(`UPDATE projects SET flow = 'auto', video_purged = 1, frames_json = NULL WHERE id = ?`)
      .run(pid);
    advanceFlow(pid);
    const p = getDb().prepare(`SELECT error FROM projects WHERE id = ?`).get(pid) as { error: string | null };
    expect(p.error).toContain('storyboard');
  });
});
