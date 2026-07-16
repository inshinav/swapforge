import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-rotation-test-'));
// Крошечный кап (~10 КБ), чтобы ротацию можно было триггерить парой файлов
process.env.STORAGE_CAP_GB = '0.00001';

const { getDb } = await import('../src/db');
const { enforceStorageCap, projectDir, rendersDir } = await import('../src/storage');

function mkProject(id: string, videoBytes: number, createdShift: string): void {
  getDb()
    .prepare(
      `INSERT INTO projects (id, video_file, video_bytes, created_at) VALUES (?, 'source.mp4', ?, datetime('now', ?))`,
    )
    .run(id, videoBytes, createdShift);
  fs.mkdirSync(projectDir(id), { recursive: true });
  fs.writeFileSync(path.join(projectDir(id), 'source.mp4'), Buffer.alloc(videoBytes, 1));
}

function mkRender(genId: string, projectId: string, bytes: number, opts: { rating?: number; createdShift?: string; status?: string } = {}): void {
  getDb()
    .prepare(
      `INSERT INTO generations (id, project_id, version, status, file, bytes, rating, created_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, datetime('now', ?))`,
    )
    .run(genId, projectId, opts.status ?? 'done', `gen_${genId}.mp4`, bytes, opts.rating ?? null, opts.createdShift ?? '-1 hour');
  fs.mkdirSync(rendersDir(projectId), { recursive: true });
  fs.writeFileSync(path.join(rendersDir(projectId), `gen_${genId}.mp4`), Buffer.alloc(bytes, 2));
}

describe('ротация v2', () => {
  it('эшелон 1 — исходники старых проектов; эшелон 2 — рендеры, кроме 👍 и последнего done; активные не трогаются', () => {
    const db = getDb();
    // старый проект с исходником 6КБ — кандидат №1
    mkProject('old-src', 6000, '-3 days');
    // проект с активной генерацией — его исходник неприкосновенен
    mkProject('active-gen', 6000, '-2 days');
    db.prepare(
      `INSERT INTO generations (id, project_id, version, status) VALUES ('g-active', 'active-gen', 1, 'rendering')`,
    ).run();
    // проект с тремя рендерами: старый (жертва), с 👍 (защищён), новейший done (защищён)
    mkProject('with-renders', 100, '-1 day');
    mkRender('victim', 'with-renders', 6000, { createdShift: '-3 hours' });
    mkRender('liked', 'with-renders', 6000, { rating: 1, createdShift: '-2 hours' });
    mkRender('newest', 'with-renders', 6000, { createdShift: '-1 hour' });

    const res = enforceStorageCap();

    // исходник старого проекта счищен, активного — нет
    expect(res.purged).toContain('old-src');
    expect(res.purged).not.toContain('active-gen');
    expect(fs.existsSync(path.join(projectDir('old-src'), 'source.mp4'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir('active-gen'), 'source.mp4'))).toBe(true);

    // из рендеров ушёл только victim
    expect(res.purgedRenders).toContain('victim');
    expect(res.purgedRenders).not.toContain('liked');
    expect(res.purgedRenders).not.toContain('newest');
    expect(fs.existsSync(path.join(rendersDir('with-renders'), 'gen_victim.mp4'))).toBe(false);
    expect(fs.existsSync(path.join(rendersDir('with-renders'), 'gen_liked.mp4'))).toBe(true);
    expect(fs.existsSync(path.join(rendersDir('with-renders'), 'gen_newest.mp4'))).toBe(true);
    const flag = db.prepare(`SELECT render_purged FROM generations WHERE id='victim'`).get() as {
      render_purged: number;
    };
    expect(flag.render_purged).toBe(1);
  });
});
