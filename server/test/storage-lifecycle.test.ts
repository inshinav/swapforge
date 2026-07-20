import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-storage-life-'));

const { getDb } = await import('../src/db');
const { enforceLatestResultLimit, projectDir, rendersDir, sweepTransientProjectFiles } = await import('../src/storage');

describe('storage lifecycle', () => {
  it('the 21st completed result physically removes the oldest file', () => {
    const userId = 'storage-user';
    getDb().prepare(`INSERT INTO users (id, telegram_id) VALUES (?, 70001)`).run(userId);
    for (let i = 1; i <= 21; i++) {
      const projectId = `p-${i}`;
      const file = `result-${i}.mp4`;
      getDb()
        .prepare(`INSERT INTO projects (id, user_id, title, created_at) VALUES (?, ?, 'p', ?)`)
        .run(projectId, userId, `2026-07-${String(i).padStart(2, '0')} 00:00:00`);
      getDb()
        .prepare(
          `INSERT INTO generations (id, project_id, version, status, file, bytes, user_id, created_at, finished_at)
           VALUES (?, ?, 1, 'done', ?, 10, ?, ?, ?)`,
        )
        .run(`g-${i}`, projectId, file, userId, `2026-07-${String(i).padStart(2, '0')} 00:00:00`, `2026-07-${String(i).padStart(2, '0')} 00:01:00`);
      fs.mkdirSync(rendersDir(projectId), { recursive: true });
      fs.writeFileSync(path.join(rendersDir(projectId), file), 'video');
    }

    expect(enforceLatestResultLimit(userId)).toEqual(['g-1']);
    expect(fs.existsSync(path.join(rendersDir('p-1'), 'result-1.mp4'))).toBe(false);
    expect(fs.existsSync(path.join(rendersDir('p-21'), 'result-21.mp4'))).toBe(true);
    expect(
      (getDb().prepare(`SELECT COUNT(*) AS c FROM generations WHERE render_purged=0`).get() as { c: number }).c,
    ).toBe(20);
  });

  it('removes partial downloads and orphan render files', () => {
    fs.mkdirSync(rendersDir('p-21'), { recursive: true });
    fs.writeFileSync(path.join(projectDir('p-21'), 'download.part'), 'partial');
    fs.writeFileSync(path.join(rendersDir('p-21'), 'orphan.mp4'), 'orphan');
    expect(sweepTransientProjectFiles()).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(path.join(projectDir('p-21'), 'download.part'))).toBe(false);
    expect(fs.existsSync(path.join(rendersDir('p-21'), 'orphan.mp4'))).toBe(false);
  });
});
