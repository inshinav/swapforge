import { describe, expect, it } from 'vitest';
import type { Analysis } from '../../shared/analysis';
import type { RefInfo } from '../../shared/api-types';
import {
  buildMinimalVideoEditPrompt,
  finalizeVideoEditPrompt,
  selectVideoEditRefs,
  VIDEO_EDIT_PROMPT_MAX_WORDS,
} from '../src/engine/video-edit-contract';

const refs: RefInfo[] = [
  { id: 'model', idx: 0, role: 'model', file: 'model.jpg', note: '' },
  { id: 'bike', idx: 1, role: 'vehicle', file: 'bike.jpg', note: 'red motorcycle' },
];

function analysis(vehicleCovered: string[]): Analysis {
  return {
    storyboard: [],
    world: {
      location: 'street',
      timeOfDay: 'day',
      light: 'natural',
      weather: '',
      background: [],
      reflections: [],
      surfaces: [],
      overlayText: [],
    },
    subjects: [
      { kind: 'person', description: 'main rider', pose: 'riding', contact: ['hands on grips'], prominence: 'main' },
      { kind: 'vehicle', description: 'motorcycle', pose: '', contact: [], prominence: 'main' },
    ],
    risks: [],
    referenceAudit: {
      verdict: 'ready',
      summary: '',
      checks: [
        { role: 'model', subject: 'rider', covered: ['front'], missing: [], qualityNotes: [] },
        { role: 'vehicle', subject: 'motorcycle', covered: vehicleCovered, missing: [], qualityNotes: [] },
      ],
      issues: [],
    },
    startFrame: { description: '', composition: '', subjectPlacement: '', lightNote: '' },
    tags: [],
  };
}

function countWords(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

describe('direct video-edit contract', () => {
  it('не отправляет технику, если аудит не подтвердил подходящий референс', () => {
    expect(selectVideoEditRefs(analysis([]), refs).map((ref) => ref.id)).toEqual(['model']);
  });

  it('отправляет подтверждённую модель и технику в стабильном порядке', () => {
    expect(selectVideoEditRefs(analysis(['left', 'right']), refs).map((ref) => ref.id)).toEqual([
      'model',
      'bike',
    ]);
  });

  it('fallback короткий, сохраняет движение и не адресует массив рефов', () => {
    const prompt = buildMinimalVideoEditPrompt(analysis(['left']), refs);
    expect(countWords(prompt)).toBeGreaterThanOrEqual(35);
    expect(countWords(prompt)).toBeLessThanOrEqual(VIDEO_EDIT_PROMPT_MAX_WORDS);
    expect(prompt).toContain('Replace only');
    expect(prompt).toContain('disconnected hand');
    expect(prompt).toContain('original live-action realism');
    expect(prompt).not.toMatch(/reference image \d|start[- ]frame|no morphing|no warping/i);
  });

  it('legacy start-frame промт заменяется перед платным provider call', () => {
    const legacy = [
      'Keep the entire world and completely replace the rider.',
      'Reference image 1 is the exact first frame of the edit — start from it.',
      'Reference image 2 is the person and reference image 3 is the motorcycle.',
      ...Array(140).fill('guardrail'),
    ].join(' ');
    const prompt = finalizeVideoEditPrompt(legacy, analysis(['left']), refs);
    expect(countWords(prompt)).toBeLessThanOrEqual(VIDEO_EDIT_PROMPT_MAX_WORDS);
    expect(prompt).toContain('Replace only');
    expect(prompt).not.toMatch(/reference image \d|start[- ]frame/i);
  });

  it('сохраняет уже безопасный компактный direct-edit prompt', () => {
    const candidate =
      'Replace only the main rider with the referenced person, using the references solely for appearance. Keep every other person, disconnected hand, object and interaction unchanged. Preserve the original motion, pose, timing, camera, framing, lighting, shadows, reflections, motion blur and background. Preserve the original live-action realism without restaging or stylization.';
    expect(finalizeVideoEditPrompt(candidate, analysis([]), refs)).toBe(candidate);
  });

  it('активные режимы не пробивают hard limit', () => {
    const prompt = buildMinimalVideoEditPrompt(analysis(['left']), refs, {
      removeText: true,
      enhanceFigure: true,
      wish: Array(30).fill('extra').join(' '),
    });
    expect(countWords(prompt)).toBeLessThanOrEqual(VIDEO_EDIT_PROMPT_MAX_WORDS);
    expect(prompt).toContain('Remove only overlaid captions');
    expect(prompt).toContain('natural curvier hourglass figure');
    expect(prompt).not.toContain('For the replaced subject only');
  });
});
