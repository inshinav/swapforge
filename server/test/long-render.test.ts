import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-long-render-'));
process.env.WAVESPEED_API_KEY = 'test-key';
process.env.OPENAI_API_KEY = 'test-key';
process.env.RENDER_CONCURRENCY = '1';

const { getDb } = await import('../src/db');
const { startRender, waitLongPrediction } = await import('../src/engine/render');
const { config } = await import('../src/config');
const { projectDir, refsDir, rendersDir, startDir } = await import('../src/storage');
import type { WaveSpeed, WsPrediction } from '../src/wavespeed';

const owner = 'owner-long-render';
getDb().prepare(`INSERT INTO users (id, telegram_id, role) VALUES (?, 9911, 'owner')`).run(owner);

async function until(fn: () => boolean, ms = 4000): Promise<void> {
  const started = Date.now();
  while (!fn()) {
    if (Date.now() - started > ms) throw new Error('timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('длинный render pipeline', () => {
  it('recheck polls an old long prediction at least once and gets a fresh poll budget', async () => {
    let polls = 0;
    const ws = {
      pollResult: async (): Promise<WsPrediction> => {
        polls++;
        return polls === 1
          ? { id: 'old', status: 'processing', outputs: [], error: '', raw: {} }
          : { id: 'old', status: 'completed', outputs: ['https://cdn/result.mp4'], error: '', raw: {} };
      },
    } as unknown as WaveSpeed;
    const result = await waitLongPrediction('old', '2000-01-01T00:00:00.000Z', ws, 1, true);
    expect(result.status).toBe('completed');
    expect(polls).toBe(2);
  });

  it('чекпойнтит две части, делает continuity anchor из предыдущего render и один итог', async () => {
    const project = randomUUID();
    const meta = { durationSec: 18, width: 1080, height: 1920, fps: 30, aspect: '9:16', sizeBytes: 10 };
    getDb().prepare(
      `INSERT INTO projects (id, user_id, title, status, video_file, video_bytes, meta_json, frames_json, analysis_json)
       VALUES (?, ?, 'long', 'complete', 'source.mp4', 10, ?, '[]', ?)`
    ).run(project, owner, JSON.stringify(meta), JSON.stringify({ storyboard: [] }));
    fs.mkdirSync(refsDir(project), { recursive: true });
    fs.mkdirSync(startDir(project), { recursive: true });
    fs.writeFileSync(path.join(projectDir(project), 'source.mp4'), 'source');
    fs.writeFileSync(path.join(refsDir(project), 'ref.jpg'), 'ref');
    fs.writeFileSync(path.join(startDir(project), 'start_v1_2026-07-19T00-00-00.png'), 'start');
    getDb().prepare(`INSERT INTO refs (id, project_id, idx, role, file) VALUES ('r1', ?, 0, 'model', 'ref.jpg')`).run(project);
    getDb().prepare(`INSERT INTO prompts (id, project_id, version, kind, text) VALUES (?, ?, 1, 'image', 'IMAGE BASE')`).run(randomUUID(), project);
    getDb().prepare(`INSERT INTO prompts (id, project_id, version, kind, text) VALUES (?, ?, 1, 'video', 'VIDEO BASE')`).run(randomUUID(), project);

    const submits: Record<string, unknown>[] = [];
    const uploadedFiles: string[] = [];
    let downloads = 0;
    const ws = {
      uploadBinary: async (file: string) => {
        uploadedFiles.push(path.basename(file));
        return `https://cdn/${path.basename(file)}`;
      },
      submitVideoEdit: async (payload: Record<string, unknown>) => {
        submits.push(payload);
        return `prediction-${submits.length}`;
      },
      pollResult: async (id: string): Promise<WsPrediction> => ({
        id,
        status: 'completed',
        outputs: [`https://cdn/output-${id}.mp4`],
        error: '',
        raw: { cost: 1 },
      }),
      downloadOutput: async (_url: string, dest: string) => {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, `render-${++downloads}`);
        return fs.statSync(dest).size;
      },
      getBalance: async () => 100,
      fetchModelEntry: async () => ({
        model_id: config.seedanceEndpoint,
        base_price: 0.75,
        formula: '{"total_price": 3000000}',
      }),
    } as WaveSpeed;

    const extractedFrom: string[] = [];
    let stitchedAnchors: Array<string | null> = [];
    const gen = startRender(project, 1, {
      ws,
      pollBaseMs: 1,
      _longHooks: {
        cut: async (_source, output) => {
          fs.mkdirSync(path.dirname(output), { recursive: true });
          fs.writeFileSync(output, 'cut');
        },
        extract: async (source, _at, output) => {
          extractedFrom.push(source);
          fs.writeFileSync(output, 'jpg');
        },
        stitch: async (_segments, output, _overlap, _source, anchors = []) => {
          stitchedAnchors = anchors;
          fs.mkdirSync(path.dirname(output), { recursive: true });
          fs.writeFileSync(output, 'final-video');
          return fs.statSync(output).size;
        },
      },
    });

    await until(() => {
      const row = getDb().prepare(`SELECT status FROM generations WHERE id = ?`).get(gen) as { status: string };
      return row.status === 'done';
    });
    const row = getDb().prepare(`SELECT * FROM generations WHERE id = ?`).get(gen) as Record<string, unknown>;
    expect(submits).toHaveLength(2);
    expect(row.segment_count).toBe(2);
    expect(row.segment_done).toBe(2);
    expect(row.cost_actual_usd).toBe(2);
    expect(extractedFrom[0]).toMatch(/segment_01_render\.mp4$/);
    // Сегмент 0 стартует с обязательного старт-кадра (якорь идентичности/надписей)
    expect(uploadedFiles).toContain('start_v1_2026-07-19T00-00-00.png');
    expect((submits[0]!.reference_images as string[])).toHaveLength(2);
    expect((submits[0]!.reference_images as string[])[0]).toContain('start_v1');
    expect(String(submits[0]!.prompt)).toContain('Replace only');
    expect(String(submits[0]!.prompt)).toContain('exact first frame of this edit');
    expect(uploadedFiles).toContain('segment_02_anchor.png');
    expect((submits[1]!.reference_images as string[])[0]).toContain('segment_02_anchor.png');
    expect(String(submits[1]!.prompt)).toMatch(/exact boundary frame from the previous output/);
    expect(String(submits[1]!.prompt)).toMatch(/follow this source segment for all motion/);
    expect(stitchedAnchors[0]).toBeNull();
    expect(stitchedAnchors[1]).toMatch(/segment_02_anchor\.png$/);
    expect(fs.readdirSync(startDir(project))).toEqual(['start_v1_2026-07-19T00-00-00.png']);
    expect(fs.existsSync(path.join(rendersDir(project), String(row.file)))).toBe(true);
  });
});
