import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

process.env.DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-ws-test-'));

const { createWaveSpeed, WsError } = await import('../src/wavespeed');
const { applySchema, ensureColumn } = await import('../src/db');
const { config } = await import('../src/config');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function tmpFile(content = 'x'.repeat(64)): string {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sf-ws-')), 'file.bin');
  fs.writeFileSync(p, content);
  return p;
}

describe('wavespeed client', () => {
  it('uploadBinary: multipart с полем file → data.url', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe('https://ws.test/api/v3/media/upload/binary');
      expect(init?.method).toBe('POST');
      expect(init?.body).toBeInstanceOf(FormData);
      const fd = init?.body as FormData;
      expect(fd.get('file')).toBeTruthy();
      const auth = (init?.headers as Record<string, string>).Authorization;
      expect(auth).toBe('Bearer test-key');
      return jsonResponse({ code: 200, message: 'success', data: { url: 'https://cdn/x.bin' } });
    });
    const ws = createWaveSpeed({
      apiKey: 'test-key',
      baseUrl: 'https://ws.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
      retryBaseMs: 1,
    });
    await expect(ws.uploadBinary(tmpFile())).resolves.toBe('https://cdn/x.bin');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uploadBinary: ретрай на 500, затем успех', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls === 1) return jsonResponse({ code: 500, message: 'boom' }, 500);
      return jsonResponse({ code: 200, data: { url: 'https://cdn/ok.bin' } });
    });
    const ws = createWaveSpeed({
      apiKey: 'k',
      baseUrl: 'https://ws.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
      retryBaseMs: 1,
    });
    await expect(ws.uploadBinary(tmpFile())).resolves.toBe('https://cdn/ok.bin');
    expect(calls).toBe(2);
  });

  it('submitVideoEdit: успех → id, эндпоинт из config', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe(`https://ws.test/api/v3/${config.seedanceEndpoint}`);
      const payload = JSON.parse(String(init?.body));
      expect(payload.resolution).toBe('720p');
      return jsonResponse({ code: 200, data: { id: 'pred-1' } });
    });
    const ws = createWaveSpeed({
      apiKey: 'k',
      baseUrl: 'https://ws.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
      retryBaseMs: 1,
    });
    await expect(ws.submitVideoEdit({ resolution: '720p' })).resolves.toBe('pred-1');
  });

  it('submitVideoEdit: 429 ретраится, затем успех', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls < 3) return jsonResponse({ code: 429, message: 'rate limit' }, 429);
      return jsonResponse({ code: 200, data: { id: 'pred-2' } });
    });
    const ws = createWaveSpeed({
      apiKey: 'k',
      baseUrl: 'https://ws.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
      retryBaseMs: 1,
    });
    await expect(ws.submitVideoEdit({})).resolves.toBe('pred-2');
    expect(calls).toBe(3);
  });

  it('submitVideoEdit: 500 НЕ ретраится (риск двойного списания) — падает сразу', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ code: 500, message: 'oops' }, 500));
    const ws = createWaveSpeed({
      apiKey: 'k',
      baseUrl: 'https://ws.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
      retryBaseMs: 1,
    });
    await expect(ws.submitVideoEdit({})).rejects.toThrow(/HTTP 500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('pollResult: нормализует status/outputs/error и отдаёт raw', async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      expect(String(url)).toBe('https://ws.test/api/v3/predictions/pred-9/result');
      return jsonResponse({
        code: 200,
        data: {
          id: 'pred-9',
          status: 'completed',
          outputs: ['https://cdn/out.mp4'],
          error: '',
          executionTime: 123,
        },
      });
    });
    const ws = createWaveSpeed({
      apiKey: 'k',
      baseUrl: 'https://ws.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const r = await ws.pollResult('pred-9');
    expect(r.status).toBe('completed');
    expect(r.outputs[0]).toBe('https://cdn/out.mp4');
    expect(r.raw.executionTime).toBe(123);
  });

  it('getBalance: число из data.balance; кривой ответ → ошибка', async () => {
    const ok = createWaveSpeed({
      apiKey: 'k',
      baseUrl: 'https://ws.test',
      fetchImpl: (async () =>
        jsonResponse({ code: 200, data: { balance: 3.92 } })) as unknown as typeof fetch,
    });
    await expect(ok.getBalance()).resolves.toBe(3.92);

    const badFetch = (async () => jsonResponse({ code: 200, data: {} })) as unknown as typeof fetch;
    const bad = createWaveSpeed({ apiKey: 'k', baseUrl: 'https://ws.test', fetchImpl: badFetch });
    await expect(bad.getBalance()).rejects.toThrow(/баланс/);
  });

  it('fetchModelEntry: находит модель в каталоге; отсутствие → ошибка', async () => {
    const catalog = {
      code: 200,
      data: [
        { model_id: 'other/model', base_price: 1 },
        { model_id: config.seedanceEndpoint, base_price: 0.75, formula: '{"total_price": 1}' },
      ],
    };
    const ws = createWaveSpeed({
      apiKey: 'k',
      baseUrl: 'https://ws.test',
      fetchImpl: (async () => jsonResponse(catalog)) as unknown as typeof fetch,
    });
    const entry = await ws.fetchModelEntry(config.seedanceEndpoint);
    expect(entry.base_price).toBe(0.75);
    await expect(ws.fetchModelEntry('no/such')).rejects.toThrow(/не найдена/);
  });

  it('downloadOutput: пишет файл через .part и переименовывает', async () => {
    const bytes = new Uint8Array(1024).fill(7);
    const ws = createWaveSpeed({
      apiKey: 'k',
      fetchImpl: (async () => new Response(new Blob([bytes]))) as unknown as typeof fetch,
    });
    const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sf-dl-')), 'out.mp4');
    const n = await ws.downloadOutput('https://cdn/out.mp4', dest, 10_000);
    expect(n).toBe(1024);
    expect(fs.readFileSync(dest).length).toBe(1024);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  });

  it('downloadOutput: превышение санити-капа → ошибка, файлов не остаётся', async () => {
    const bytes = new Uint8Array(2048).fill(1);
    const ws = createWaveSpeed({
      apiKey: 'k',
      fetchImpl: (async () => new Response(new Blob([bytes]))) as unknown as typeof fetch,
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-dl2-'));
    const dest = path.join(dir, 'out.mp4');
    await expect(ws.downloadOutput('https://cdn/big.mp4', dest, 1024)).rejects.toThrow(/лимита/);
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  });

  it('без ключа → человеческая ошибка, fetch не зовётся', async () => {
    const fetchMock = vi.fn();
    const ws = createWaveSpeed({
      apiKey: '',
      baseUrl: 'https://ws.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await expect(ws.getBalance()).rejects.toThrow(/WAVESPEED_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(new WsError('x').retryable).toBe(false);
  });
});

describe('db schema v2', () => {
  it('applySchema на свежей БД создаёт v2-таблицы и колонки', () => {
    const d = new DatabaseSync(':memory:');
    applySchema(d);
    const tables = (
      d.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
        name: string;
      }>
    ).map((t) => t.name);
    for (const t of ['projects', 'refs', 'prompts', 'feedback', 'generations', 'usage_events', 'pricing_cache']) {
      expect(tables).toContain(t);
    }
    const cols = (d.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain('flow');
    expect(cols).toContain('flags_json');
  });

  it('applySchema идемпотентна и мигрирует v1-таблицы (ALTER-гварды)', () => {
    const d = new DatabaseSync(':memory:');
    // Симулируем v1: те же таблицы, но без v2-колонок
    d.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'uploaded',
        error TEXT, video_file TEXT, video_bytes INTEGER NOT NULL DEFAULT 0, video_purged INTEGER NOT NULL DEFAULT 0,
        meta_json TEXT, frames_json TEXT, analysis_json TEXT, tags_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE refs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, idx INTEGER NOT NULL, role TEXT NOT NULL,
        file TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE prompts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, version INTEGER NOT NULL, kind TEXT NOT NULL,
        lang TEXT NOT NULL DEFAULT 'en', text TEXT NOT NULL, params_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE feedback (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, version INTEGER NOT NULL, worked INTEGER NOT NULL,
        artifacts_json TEXT NOT NULL DEFAULT '[]', notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO projects (id) VALUES ('p1');
    `);
    applySchema(d);
    applySchema(d); // второй прогон не падает
    const p = d.prepare(`SELECT flow, flags_json FROM projects WHERE id='p1'`).get() as {
      flow: string;
      flags_json: string | null;
    };
    expect(p.flow).toBe('manual');
    expect(p.flags_json).toBeNull();
    const refCols = (d.prepare(`PRAGMA table_info(refs)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(refCols).toContain('role_source');
    expect(refCols).toContain('auto_note');
    // ensureColumn сама по себе идемпотентна
    ensureColumn(d, 'refs', 'role_source', `role_source TEXT NOT NULL DEFAULT 'manual'`);
  });

  it('generations: дефолты и каскад при удалении проекта', () => {
    const d = new DatabaseSync(':memory:');
    d.exec('PRAGMA foreign_keys = ON;');
    applySchema(d);
    d.prepare(`INSERT INTO projects (id) VALUES ('p1')`).run();
    d.prepare(`INSERT INTO generations (id, project_id, version) VALUES ('g1', 'p1', 1)`).run();
    const g = d.prepare(`SELECT status, bytes, artifacts_json FROM generations WHERE id='g1'`).get() as {
      status: string;
      bytes: number;
      artifacts_json: string;
    };
    expect(g.status).toBe('uploading_assets');
    expect(g.bytes).toBe(0);
    expect(g.artifacts_json).toBe('[]');
    d.prepare(`DELETE FROM projects WHERE id='p1'`).run();
    const left = d.prepare(`SELECT COUNT(*) AS c FROM generations`).get() as { c: number };
    expect(left.c).toBe(0);
  });

  it('usage_events переживают удаление проекта (без FK)', () => {
    const d = new DatabaseSync(':memory:');
    d.exec('PRAGMA foreign_keys = ON;');
    applySchema(d);
    d.prepare(`INSERT INTO projects (id) VALUES ('p1')`).run();
    d.prepare(
      `INSERT INTO usage_events (id, project_id, task, model, tokens_in, tokens_out, cost_usd)
       VALUES ('u1', 'p1', 'prompt_pair', 'gpt-5.6-luna', 100, 10, 0.001)`,
    ).run();
    d.prepare(`DELETE FROM projects WHERE id='p1'`).run();
    const left = d.prepare(`SELECT COUNT(*) AS c FROM usage_events`).get() as { c: number };
    expect(left.c).toBe(1);
  });
});
