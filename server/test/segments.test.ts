import { describe, expect, it } from 'vitest';
import type { Analysis } from '../../shared/analysis';
import type { FrameInfo } from '../../shared/api-types';
import { planVideoSegments, SEAM_OVERLAP_SECONDS, segmentDurations } from '../src/engine/segments';

const analysis = {
  storyboard: [
    { index: 0, startSec: 0, endSec: 12.8, camera: 'tracking', action: 'hero walks', framing: 'full body' },
    { index: 1, startSec: 12.8, endSec: 25, camera: 'close', action: 'person turns toward camera', framing: 'close-up face' },
    { index: 2, startSec: 25, endSec: 40, camera: 'tracking', action: 'hero rides motorcycle', framing: 'medium shot' },
  ],
} as Analysis;

describe('план длинного видео', () => {
  it('до 15 секунд оставляет одной частью', () => {
    expect(planVideoSegments(15)).toEqual([
      { index: 0, startSec: 0, endSec: 15, overlapWithPreviousSec: 0, anchorReason: 'первый кадр исходника' },
    ]);
  });

  it('все части в окне 4–15с, а anchor берётся после устойчивой смены сцены', () => {
    const plan = planVideoSegments(40, analysis, []);
    expect(plan.length).toBeGreaterThan(2);
    for (const segment of plan) {
      const duration = segment.endSec - segment.startSec;
      expect(duration).toBeGreaterThanOrEqual(4);
      expect(duration).toBeLessThanOrEqual(15);
    }
    for (let i = 1; i < plan.length; i++) {
      expect(plan[i - 1]!.endSec - plan[i]!.startSec).toBeCloseTo(SEAM_OVERLAP_SECONDS, 5);
    }
    expect(plan[1]!.anchorReason).toMatch(/герой|объект/);
    expect(plan[1]!.startSec).toBeCloseTo(13.15, 2);
  });

  it('не ставит стык на смазанный переход и выбирает читаемый кадр с моделью', () => {
    const risky = {
      storyboard: [
        { index: 0, startSec: 0, endSec: 12.8, camera: 'steady', action: 'model and motorcycle clearly visible', framing: 'full body' },
        { index: 1, startSec: 12.8, endSec: 25, camera: 'whip pan', action: 'motion blur transition, face occluded', framing: 'cropped face' },
      ],
    } as Analysis;
    const frames = [
      { file: 'safe.jpg', t: 12.2, kind: 'grid' },
      { file: 'transition.jpg', t: 12.8, kind: 'scene' },
    ] as FrameInfo[];
    const plan = planVideoSegments(25, risky, frames);
    expect(plan[1]!.startSec).toBe(12.2);
    expect(plan[1]!.anchorReason).toMatch(/модель|объект|герой/i);
    expect(plan[1]!.anchorReason).not.toMatch(/рискован/);
  });

  it('16 секунд не клампит: создаёт две валидные части', () => {
    const durations = segmentDurations(16);
    expect(durations).toHaveLength(2);
    expect(Math.max(...durations)).toBeLessThanOrEqual(15);
    expect(Math.min(...durations)).toBeGreaterThanOrEqual(4);
  });
});
