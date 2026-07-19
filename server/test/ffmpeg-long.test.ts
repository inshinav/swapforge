import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cutVideoSegment, extractFrameAt, probe, stitchVideoSegments } from '../src/ffmpeg';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swapforge-long-ffmpeg-'));

function makeVideo(file: string, color: string, frequency: number, duration = 2): void {
  const result = spawnSync(
    'ffmpeg',
    [
      '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=360x640:r=30:d=${duration}`,
      '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${duration}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file,
    ],
    { windowsHide: true, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(result.stderr.slice(-800));
}

function centerRgbAt(file: string, atSec: number): [number, number, number] {
  const result = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-ss', atSec.toFixed(3), '-i', file, '-vf', 'scale=1:1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { windowsHide: true },
  );
  if (result.status !== 0) throw new Error(String(result.stderr).slice(-800));
  const bytes = result.stdout as Buffer;
  return [bytes[0]!, bytes[1]!, bytes[2]!];
}

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('ffmpeg длинного ролика', () => {
  it('точно режет/извлекает anchor, фиксирует им первый кадр и плавно сводит звук', async () => {
    const source = path.join(dir, 'source.mp4');
    const second = path.join(dir, 'second.mp4');
    makeVideo(source, 'red', 440, 5);
    makeVideo(second, 'blue', 660, 2);

    const cut = path.join(dir, 'cut.mp4');
    const anchor = path.join(dir, 'anchor.png');
    await cutVideoSegment(source, cut, 1, 3);
    await extractFrameAt(source, 1, anchor);
    expect(fs.statSync(anchor).size).toBeGreaterThan(100);
    expect((await probe(cut)).durationSec).toBeCloseTo(2, 1);

    const stitched = path.join(dir, 'stitched.mp4');
    const bytes = await stitchVideoSegments([cut, second], stitched, 0.5, source, [null, anchor], [null, 1.5]);
    const meta = await probe(stitched);
    expect(bytes).toBeGreaterThan(1000);
    expect(meta.aspect).toBe('9:16');
    expect(meta.durationSec).toBeGreaterThan(3.3);
    expect(meta.durationSec).toBeLessThan(3.8);
    const seamPixel = centerRgbAt(stitched, 1.5);
    expect(seamPixel[0]).toBeGreaterThan(150);
    expect(seamPixel[2]).toBeLessThan(100);
  }, 60_000);
});
