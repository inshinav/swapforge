// Таксономия артефактов Seedance video-edit + таргетированные фиксы (ядро доктрины).
// fix — инструкция промт-инженеру (LLM) на английском: как править промт при этом артефакте.

export type ArtifactType =
  | 'identity_bleed'
  | 'world_drift'
  | 'temporal_drift'
  | 'pasted_on'
  | 'cross_wiring';

export interface ArtifactInfo {
  ru: string;
  hint: string;
  fix: string;
}

export const ARTIFACTS: Record<ArtifactType, ArtifactInfo> = {
  identity_bleed: {
    ru: 'Identity bleed — субъект похож на блэнд оригинала и референса',
    hint: 'Лицо/машина частично сохранили черты оригинального ролика',
    fix: 'Strengthen the replacement language: assert "The <subject> IS the person in reference image N — completely replace them, do not retain ANY features of the original subject." Name the new subject\'s distinctive features explicitly (face shape, hairstyle, skin tone, build, outfit colors, vehicle body lines) so the model has concrete anchors. Recommend adding more reference angles if available.',
  },
  world_drift: {
    ru: 'World drift — сцена перестилизовалась',
    hint: 'Фон, свет, погода или локация уехали от оригинала',
    fix: 'Expand and harden the KEEP list with the SPECIFIC elements that drifted — name them explicitly (exact surfaces, background objects, light sources, weather). Reinforce the matching DO NOT line: "DO NOT restyle, recolor or relight the overall scene; DO NOT change the environment or background."',
  },
  temporal_drift: {
    ru: 'Temporal drift — лицо/объект морфят по ходу клипа',
    hint: 'Идентичность плывёт со временем, особенно после 8–10 секунд',
    fix: 'Re-assert the identity lock across time: "Keep this face consistent and recognizable in EVERY frame from the first to the last" and the same wording for the object\'s design. If the artifact persists after this fix, recommend cutting the clip into shorter segments and stitching.',
  },
  pasted_on: {
    ru: 'Pasted-on look — свап выглядит наклейкой',
    hint: 'Новый субъект не вписан в свет сцены',
    fix: 'Strengthen the LIGHT line: describe the scene\'s ACTUAL light from the analysis (e.g. neon storefronts, golden hour sun from the left, overcast diffuse) and require the new subjects to be lit by exactly that light — same direction, color cast, shadows and reflections — so the swap is seamless. Keep the "do not relight the scene" guardrail intact: the world\'s light stays, the new subject must sit inside it.',
  },
  cross_wiring: {
    ru: 'Cross-wiring — референс применён не к тому субъекту',
    hint: 'Модель перепутала, какая картинка кто',
    fix: 'Make reference indexing fully explicit and unambiguous: enumerate EVERY reference image number and what it depicts ("reference image 1 = the exact first frame, reference image 2 = the person, reference image 3 = the motorcycle"), and verify the reference_images array order matches the prompt numbering one-to-one.',
  },
};

export const ARTIFACT_TYPES = Object.keys(ARTIFACTS) as ArtifactType[];

export type RefRole = 'model' | 'vehicle' | 'object';

export const REF_ROLES: Record<RefRole, { ru: string; en: string }> = {
  model: { ru: 'Модель', en: 'person' },
  vehicle: { ru: 'Транспорт', en: 'vehicle' },
  object: { ru: 'Доп. объект', en: 'object' },
};
