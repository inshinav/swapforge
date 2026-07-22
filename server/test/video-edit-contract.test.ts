import { describe, expect, it } from 'vitest';
import type { Analysis } from '../../shared/analysis';
import type { RefInfo } from '../../shared/api-types';
import { FIGURE_TIER1 } from '../src/engine/doctrine';
import {
  buildMinimalVideoEditPrompt,
  buildStartFramePrompt,
  finalizeVideoEditPrompt,
  furAccents,
  selectVideoEditRefs,
  VIDEO_EDIT_PROMPT_MAX_WORDS,
} from '../src/engine/video-edit-contract';

const refs: RefInfo[] = [
  { id: 'model', idx: 0, role: 'model', file: 'model.jpg', note: '' },
  { id: 'bike', idx: 1, role: 'vehicle', file: 'bike.jpg', note: 'red motorcycle' },
];

const furryRefs: RefInfo[] = [
  {
    id: 'model',
    idx: 0,
    role: 'model',
    file: 'model.jpg',
    note: 'fox-образ: пушистый хвост и меховые уши — часть образа, сохранять в кадре',
  },
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

  it('канон по рецепту Alex: KEEP-блок, старт-кадр, replace-only, ракурсы, запрет AI-скованности', () => {
    const prompt = buildMinimalVideoEditPrompt(analysis(['left']), refs);
    expect(countWords(prompt)).toBeGreaterThanOrEqual(35);
    expect(countWords(prompt)).toBeLessThanOrEqual(VIDEO_EDIT_PROMPT_MAX_WORDS);
    expect(prompt).toContain('exactly as in the source video');
    expect(prompt).toContain('exact starting frame of this edit');
    expect(prompt).toContain('Replace only the main person');
    expect(prompt).toContain('replace only the matching vehicle');
    expect(prompt).toContain('consistent and recognizable from every angle');
    expect(prompt).toContain('No stiff or robotic motion');
    expect(prompt).toContain('original live footage');
    // без @-нумерации массива рефов (API документирует только неименованный список)
    expect(prompt).not.toMatch(/reference image \d|@image|@video|no morphing|no warping/i);
  });

  it('техника без подтверждения в кадре не упоминается в промте вовсе', () => {
    const prompt = buildMinimalVideoEditPrompt(analysis([]), refs);
    expect(prompt).not.toContain('vehicle');
    expect(prompt).toContain('Replace only the main person');
  });

  it('finalize ВСЕГДА возвращает детерминированный канон — LLM-текст не идёт провайдеру', () => {
    const canonical = buildMinimalVideoEditPrompt(analysis(['left']), refs);
    const fancyCandidate =
      'Replace only the main rider with the referenced person. Preserve the original live-action realism without restaging. The scene explodes with cinematic drama and slow-motion hair flips.';
    expect(finalizeVideoEditPrompt(fancyCandidate, analysis(['left']), refs)).toBe(canonical);
    const legacy = 'Reference image 1 is the exact first frame of the edit — start from it.';
    expect(finalizeVideoEditPrompt(legacy, analysis(['left']), refs)).toBe(canonical);
  });

  it('пушистый хвост и уши из нот модели попадают в промт с живой физикой меха', () => {
    expect(furAccents(furryRefs)).toEqual({ tail: true, ears: true });
    expect(furAccents(refs)).toEqual({ tail: false, ears: false });
    const prompt = buildMinimalVideoEditPrompt(analysis(['left']), furryRefs);
    expect(prompt).toContain('fluffy tail');
    expect(prompt).toContain('furry ears');
    expect(prompt).toContain('moving naturally in the wind with realistic fur physics');
  });

  it('активные режимы не пробивают hard limit (пожелание отбрасывается первым)', () => {
    const prompt = buildMinimalVideoEditPrompt(analysis(['left']), furryRefs, {
      removeText: true,
      enhanceFigure: true,
      wish: Array(40).fill('extra').join(' '),
    });
    expect(countWords(prompt)).toBeLessThanOrEqual(VIDEO_EDIT_PROMPT_MAX_WORDS);
    expect(prompt).toContain('Remove only overlaid captions');
    expect(prompt).toContain('curvier hourglass figure');
    expect(prompt).not.toContain('For the replaced subject only');
    expect(prompt).toContain('No stiff or robotic motion'); // финальный блок всегда на месте
  });
});

describe('детерминированный промт старт-кадра', () => {
  it('строгий in-place edit: кадр = закон, меняются только модель и подтверждённая техника', () => {
    const prompt = buildStartFramePrompt(analysis(['left']), refs);
    expect(prompt).toContain('Edit the first attached image');
    expect(prompt).toContain('exact first frame of the source video');
    expect(prompt).toContain('Replace only the person with the AI-generated virtual character');
    expect(prompt).toContain('replace only the matching vehicle');
    expect(prompt).toContain('pixel-faithful');
    expect(prompt).toContain('All attached images depict AI-generated virtual characters.');
  });

  it('неподтверждённая техника не упоминается; хвост/уши сохраняются в кадре', () => {
    const prompt = buildStartFramePrompt(analysis([]), furryRefs);
    expect(prompt).not.toContain('vehicle');
    expect(prompt).toContain('fluffy tail');
  });

  it('фраза фигуры включается дословно (анти-модерационная лесенка работает по ней)', () => {
    const prompt = buildStartFramePrompt(analysis(['left']), refs, {
      removeText: true,
      enhanceFigure: true,
      wish: '',
    });
    expect(prompt).toContain(FIGURE_TIER1);
    expect(prompt).toContain('Remove overlaid captions');
  });
});
