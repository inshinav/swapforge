import type { Analysis } from '../../../shared/analysis';
import type { RefInfo } from '../../../shared/api-types';
import type { RefRole } from '../../../shared/taxonomy';
import type { FlowFlags } from './orchestrator';
import { buildReferenceManifest } from './reference-manifest';

const VEHICLE_WORDS =
  /\b(vehicle|motorcycle|motorbike|bike|car|truck|scooter|bicycle)\b|мото|байк|машин|автомоб|скутер|велосипед/i;
const PERSON_WORDS = /\b(person|woman|man|girl|boy|rider|driver|dancer|human)\b|человек|женщ|мужчин|девуш|парень|райдер|водител|танц/i;

function auditUsesRole(analysis: Analysis | null | undefined, role: Exclude<RefRole, 'model'>): boolean | null {
  const checks = analysis?.referenceAudit?.checks?.filter((check) => check.role === role) ?? [];
  if (checks.length === 0) return null;
  return checks.some((check) => check.covered.length > 0);
}

function legacyAnalysisUsesRole(
  analysis: Analysis | null | undefined,
  ref: RefInfo,
): boolean {
  const subjects = analysis?.subjects ?? [];
  const source = subjects.map((subject) => `${subject.kind} ${subject.description}`).join(' ');
  if (ref.role === 'vehicle') return VEHICLE_WORDS.test(source);
  if (ref.role !== 'object') return true;

  const nonPersonSubject = subjects.some(
    (subject) => !PERSON_WORDS.test(`${subject.kind} ${subject.description}`) && !VEHICLE_WORDS.test(`${subject.kind} ${subject.description}`),
  );
  if (!nonPersonSubject) return false;
  const tokens = (ref.note ?? '')
    .toLowerCase()
    .match(/[\p{L}\p{N}-]{4,}/gu)
    ?.filter((token) => !['reference', 'image', 'object', 'объект', 'использовать', 'референс'].includes(token))
    .slice(0, 12) ?? [];
  return tokens.length === 0 || tokens.some((token) => source.toLowerCase().includes(token));
}

/**
 * Video Edit получает только те референсы, которым есть подтверждённая пара в исходнике.
 * Лишняя техника/объект — не нейтральный вход: она может заставить модель перестроить сцену.
 */
export function selectVideoEditRefs(
  analysis: Analysis | null | undefined,
  refs: RefInfo[],
): RefInfo[] {
  return buildReferenceManifest(refs).refs.filter((ref) => {
    if (ref.role === 'model') return true;
    const audited = auditUsesRole(analysis, ref.role);
    return audited ?? legacyAnalysisUsesRole(analysis, ref);
  });
}

function compactWish(wish: string): string {
  return wish.trim().replace(/\s+/g, ' ').split(' ').slice(0, 18).join(' ');
}

/** Детерминированный безопасный fallback: короткий edit-only контракт без адресации картинок. */
export function buildMinimalVideoEditPrompt(
  analysis: Analysis | null | undefined,
  refs: RefInfo[],
  flags?: FlowFlags | null,
): string {
  const selected = selectVideoEditRefs(analysis, refs);
  const hasVehicle = selected.some((ref) => ref.role === 'vehicle');
  const hasObject = selected.some((ref) => ref.role === 'object');
  const replacements = [
    'Replace only the main person with the referenced person, using references only for appearance.',
  ];
  if (hasVehicle || hasObject) {
    const target = hasVehicle && hasObject ? 'matching vehicle and object' : hasVehicle ? 'matching vehicle' : 'matching object';
    replacements.push(
      `Also replace only the ${target} with its referenced appearance, preserving its source scale, position and movement.`,
    );
  }
  replacements.push(
    'Keep every other person, disconnected hand, object and interaction unchanged.',
    'Preserve original hand trajectories, body motion, pose, performance, timing, speed, camera, framing, lighting, shadows, reflections, motion blur and background.',
    'Preserve original live-action realism; do not restage or stylize.',
  );
  if (flags?.removeText) {
    replacements.push('Remove only overlaid captions, stickers, subtitles and watermarks, rebuilding their background cleanly.');
  }
  if (flags?.enhanceFigure) {
    replacements.push('Give only the replaced person a natural curvier hourglass figure while preserving the original performance.');
  }
  const wish = compactWish(flags?.wish ?? '');
  if (wish) replacements.push(`For the replaced subject only: ${wish}.`);

  // Режимы и пользовательское пожелание не должны незаметно вернуть длинный
  // «режиссёрский» промт. Сначала отбрасываем наименее важное пожелание; базовый
  // source-authority контракт и явные режимы сохраняются всегда.
  let prompt = replacements.join(' ');
  if (words(prompt) > VIDEO_EDIT_PROMPT_MAX_WORDS && wish) {
    replacements.pop();
    prompt = replacements.join(' ');
  }
  return prompt;
}

export const VIDEO_EDIT_PROMPT_MAX_WORDS = 110;

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Старые и отклонившиеся LLM-промты не попадают в платный provider call.
 * Нумерация reference image намеренно запрещена: WaveSpeed документирует только
 * неименованный reference_images[], а не start/first-frame семантику.
 */
export function finalizeVideoEditPrompt(
  candidate: string,
  analysis: Analysis | null | undefined,
  refs: RefInfo[],
  flags?: FlowFlags | null,
): string {
  const text = candidate.trim().replace(/\r\n/g, '\n');
  const count = words(text);
  const addressesImages = /\breference image\s*\d+\b|\bstart[- ]frame\b|exact first frame of the edit/i.test(text);
  const preservesReality = /live[- ]action|original (?:video|footage).*real|preserve[^.]{0,80}realism/i.test(text);
  const scopedReplacement = /replace only|only replace/i.test(text);
  if (
    count < 35 ||
    count > VIDEO_EDIT_PROMPT_MAX_WORDS ||
    addressesImages ||
    !preservesReality ||
    !scopedReplacement
  ) {
    return buildMinimalVideoEditPrompt(analysis, refs, flags);
  }
  return text;
}
