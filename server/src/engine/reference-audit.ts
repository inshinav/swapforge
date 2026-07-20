import type { Analysis, ReferenceAudit } from '../../../shared/analysis';
export { referenceFingerprint } from './reference-manifest';

export type ReferenceAuditPause = 'blocked' | 'review';

export function referenceAuditPause(analysis: Analysis | null | undefined): ReferenceAuditPause | null {
  const audit = analysis?.referenceAudit;
  if (!audit) return null;
  if (audit.verdict === 'blocked' || audit.issues.some((i) => i.severity === 'blocker')) return 'blocked';
  if (audit.verdict === 'review' && !audit.accepted) return 'review';
  return null;
}

export function referenceAuditMessage(audit: ReferenceAudit, pause: ReferenceAuditPause): string {
  const count = audit.issues.filter((i) => i.severity === (pause === 'blocked' ? 'blocker' : 'warning')).length;
  return pause === 'blocked'
    ? `Перед созданием нужно исправить референсы: критических проблем — ${Math.max(1, count)}. Рендер не запускался; за него списания нет.`
    : `Нашлись риски качества — ${Math.max(1, count)}. Исправь фото или отдельно подтверди продолжение. Рендер не запускался; за него списания нет.`;
}

export const REFERENCE_AUDIT_GUIDANCE = `
REFERENCE READINESS (write all user-facing strings in clear Russian):
- Compare the PROJECT REFERENCES below with every storyboard scene and fill referenceAudit.
- Judge only replacements the user actually requested by attached roles. A vehicle/object visible in source needs no reference when that role is not attached: it can remain unchanged.
- The model/person role is mandatory. For each attached role, determine whether the supplied views cover the angles, scale, visibility and physical contact actually present in the source scenes.
- A high-resolution multi-angle reference sheet is valid. Do not reject a collage merely for being a sheet; flag it only when the needed face/object details are too small, obscured or contradictory.
- Prefer 2-3 strong consistent views over many weak or contradictory photos. Detect different identities, outfits, colors, lighting, unreadable faces, missing back/profile/top/detail views, occlusion and poor object geometry.
- For contact-heavy scenes, inspect hands, feet and contact points. Ask for the exact missing object/person angle that matches the source action.
- For source videos longer than 15s, also inspect scene openings and likely continuity boundaries around each 13-second interval. If the person or important replacement object is hidden, blurred, backlit or leaving frame there, create a source_video issue and name a nearby safer visible moment or advise changing/trimming the source. This check protects the first frame of every generated part and the final seam.
- blocker = generation is likely to lose identity/object geometry because an essential role/view is absent, unreadable or contradictory. warning = usable, but a concrete artifact risk remains. Do not block merely because every conceivable angle is not present.
- sceneIndex is 1-based; use 0 only for a problem affecting the whole video. moment must include the approximate seconds.
- evidence says what is visible in source/references. risk says what viewers may see if unchanged. action is one short exact instruction a normal phone user can follow. requiredShots lists exact photos to add/replace (angle, crop, light/background).
- verdict: blocked if any blocker; review if warnings only; ready if no issues. Never recommend negative prompts, masks, seeds, @Image syntax, start-frame fields or automatic two-pass editing. Maximum usable project references is 8 because the generated continuity frame occupies slot 1.
`;
