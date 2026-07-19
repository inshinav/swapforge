import type { Analysis } from '../../../shared/analysis';
import type { FrameInfo } from '../../../shared/api-types';

export const MAX_SEGMENT_SECONDS = 15;
export const MIN_SEGMENT_SECONDS = 4;
export const SEAM_OVERLAP_SECONDS = 0.7;
const TARGET_BODY_SECONDS = 13.2;
const ANCHOR_SETTLE_SECONDS = 0.35;

export interface VideoSegmentPlan {
  index: number;
  /** Начало куска в исходнике; для кусков > 0 это continuity anchor следующего рендера. */
  startSec: number;
  /** Конец куска в исходнике. Предыдущий кусок заходит за следующий startSec на overlap. */
  endSec: number;
  overlapWithPreviousSec: number;
  anchorReason: string;
}

interface AnchorCandidate {
  t: number;
  score: number;
  strong: boolean;
  reason: string;
}

const VISIBLE_SUBJECT_CUE =
  /(?:face|head|person|subject|hero|character|body|hand|vehicle|car|motorcycle|bike|object|product|model|close[- ]?up|medium|full[- ]?body|лиц|геро|персонаж|человек|рук|машин|мото|объект|модел)/i;
const UNSAFE_ANCHOR_CUE =
  /(?:blur|motion blur|whip|flash|transition|crossfade|occlud|hidden|off[- ]?screen|silhouette|back to camera|rear view|extreme wide|cropped face|partial face|out of frame|смаз|размыт|переход|вспыш|перекрыт|скрыт|за кадром|силуэт|спиной|со спины|общий план|обрезан|не в кадре)/i;

const round = (n: number) => Math.round(n * 100) / 100;

function segmentCountOf(durationSec: number): number {
  return Math.max(1, Math.ceil((durationSec - SEAM_OVERLAP_SECONDS) / (MAX_SEGMENT_SECONDS - SEAM_OVERLAP_SECONDS)));
}

function coverageFor(segmentCount: number, segmentDuration: number): number {
  return segmentCount * segmentDuration - Math.max(0, segmentCount - 1) * SEAM_OVERLAP_SECONDS;
}

function sceneAt(analysis: Analysis | null, t: number): Analysis['storyboard'][number] | null {
  return analysis?.storyboard?.find((s) => t >= s.startSec - 0.05 && t <= s.endSec + 0.05) ?? null;
}

function semanticReason(analysis: Analysis | null, t: number): { score: number; strong: boolean; reason: string } {
  const scene = sceneAt(analysis, t);
  if (!scene) return { score: 0, strong: false, reason: 'опорный кадр из равномерной раскадровки' };
  const text = `${scene.framing} ${scene.action}`.trim();
  const hasSubjectCue = VISIBLE_SUBJECT_CUE.test(text);
  const unsafe = UNSAFE_ANCHOR_CUE.test(text);
  const strong = hasSubjectCue && !unsafe;
  return {
    score: (hasSubjectCue ? 5 : 2) - (unsafe ? 9 : 0),
    strong,
    reason: unsafe
      ? `кадр рискован для стыка (смаз, перекрытие или объект плохо виден): ${text}`
      : hasSubjectCue
      ? `герой/ключевой объект виден: ${text}`
      : `действие сцены остаётся читаемым: ${text}`,
  };
}

function candidatesOf(
  analysis: Analysis | null,
  frames: FrameInfo[],
  desired: number,
  min: number,
  max: number,
): AnchorCandidate[] {
  const raw = new Map<number, { base: number; reasonPrefix: string }>();
  // Непрерывный дубль может не иметь смены сцены около целевой точки. Точный target
  // всё равно семантически проверяется описанием содержащей его сцены.
  raw.set(round(desired), { base: 1, reasonPrefix: 'центр безопасного окна' });
  for (const scene of analysis?.storyboard ?? []) {
    // Сам кадр смены плана часто содержит смаз или перекрытие. Даём сцене
    // несколько кадров «устояться» и уже этот кадр рассматриваем как anchor.
    const settled = Math.min(scene.startSec + ANCHOR_SETTLE_SECONDS, scene.endSec - 0.15);
    if (settled > min + 0.1 && settled < max - 0.1) {
      raw.set(round(settled), { base: 5, reasonPrefix: 'устоявшийся кадр после смены сцены' });
    }
  }
  for (const frame of frames) {
    if (frame.t < min || frame.t > max) continue;
    raw.set(round(frame.t), {
      base: frame.kind === 'scene' ? 1 : frame.kind === 'grid' ? 3 : 0,
      reasonPrefix: frame.kind === 'scene' ? 'кадр около смены сцены' : 'устойчивый кадр раскадровки',
    });
  }
  return [...raw.entries()].map(([t, rawScore]) => {
    const semantic = semanticReason(analysis, t);
    const proximity = Math.max(0, 4 - Math.abs(t - desired));
    return {
      t,
      score: rawScore.base + semantic.score + proximity,
      strong: semantic.strong,
      reason: `${rawScore.reasonPrefix}; ${semantic.reason}`,
    };
  });
}

/**
 * Строит куски <= 15с с 0.7с перекрытием. Граница выбирается по vision-storyboard:
 * первый кадр следующего куска должен содержать героя/значимый объект и поэтому
 * пригоден как точный continuity-frame для следующего видеорендера.
 */
export function planVideoSegments(
  durationSec: number,
  analysis: Analysis | null = null,
  frames: FrameInfo[] = [],
): VideoSegmentPlan[] {
  const duration = Math.max(0, round(durationSec));
  if (duration <= MAX_SEGMENT_SECONDS) {
    return [{ index: 0, startSec: 0, endSec: duration, overlapWithPreviousSec: 0, anchorReason: 'первый кадр исходника' }];
  }

  const starts = [0];
  const reasons = ['первый кадр исходника'];
  const segmentCount = segmentCountOf(duration);
  let start = 0;
  for (let index = 0; index < segmentCount - 1; index++) {
    const segmentsAfterCut = segmentCount - index - 1;
    // Не позволяем «красивому» раннему кадру породить лишнюю платную часть:
    // выбранная граница обязана оставить остаток, который ровно помещается в
    // заранее рассчитанное число сегментов 4–15с.
    const minCut = Math.max(
      start + MIN_SEGMENT_SECONDS,
      duration - coverageFor(segmentsAfterCut, MAX_SEGMENT_SECONDS),
    );
    const maxCut = Math.min(
      start + MAX_SEGMENT_SECONDS - SEAM_OVERLAP_SECONDS,
      duration - coverageFor(segmentsAfterCut, MIN_SEGMENT_SECONDS),
    );
    const desired = Math.min(start + TARGET_BODY_SECONDS, maxCut);
    const candidates = candidatesOf(analysis, frames, desired, minCut, maxCut).filter(
      (c) => c.t >= minCut && c.t <= maxCut,
    );
    candidates.sort(
      (a, b) => Number(b.strong) - Number(a.strong) || b.score - a.score || Math.abs(a.t - desired) - Math.abs(b.t - desired),
    );
    const chosen = candidates[0] ?? {
      t: maxCut,
      reason: 'безопасная временная граница; точный кадр передаётся следующей части',
    };
    const cut = round(Math.max(minCut, Math.min(maxCut, chosen.t)));
    starts.push(cut);
    reasons.push(chosen.reason);
    start = cut;
  }

  return starts.map((segmentStart, index) => {
    const nextStart = starts[index + 1];
    const end = nextStart === undefined ? duration : Math.min(duration, nextStart + SEAM_OVERLAP_SECONDS);
    return {
      index,
      startSec: round(segmentStart),
      endSec: round(end),
      overlapWithPreviousSec: index === 0 ? 0 : SEAM_OVERLAP_SECONDS,
      anchorReason: reasons[index]!,
    };
  });
}

export function segmentDurations(durationSec: number): number[] {
  return planVideoSegments(durationSec).map((s) => round(s.endSec - s.startSec));
}
