// Carousel Studio: версионируемые EN-блоки промта слайда (SPEC §2).
// Промт собирается ДЕТЕРМИНИРОВАННО из этих констант (не свободный текст LLM) —
// как доктрина видео-пайплайна. Меняешь текст блока → поднимай BLOCKS_VERSION.
import type { UgcPreset } from '../../../../shared/carousel';

export const BLOCKS_VERSION = 1;

/** UGC-реализм: интенсивность «любительности» нарастает от polished к raw. */
export const UGC_PRESETS: Record<UgcPreset, string> = {
  raw: [
    'Candid unposed smartphone snapshot, shot in one take.',
    'Imperfect framing with a slight tilt, subject not perfectly centered.',
    'Natural skin texture with visible pores, absolutely no beauty retouch.',
    'Harsh mixed available lighting exactly as found, no fill light.',
    'Slight motion blur and minor focus miss where natural.',
    'Cluttered real-life background, nothing staged or cleaned up.',
    'No studio look, no watermark, no text overlay.',
  ].join(' '),
  casual: [
    'Candid smartphone photo taken by a friend.',
    'Casual amateur composition, believable everyday moment.',
    'Natural skin texture, no beauty retouch.',
    'Mixed available lighting, true-to-life colors.',
    'Slight motion blur where natural.',
    'No studio look, no watermark, no text overlay.',
  ].join(' '),
  polished: [
    'Well-composed smartphone photo, still authentic and personal.',
    'Natural retouch-free skin, flattering available light.',
    'Tidy but real environment, believable lifestyle moment.',
    'No studio look, no watermark, no text overlay.',
  ].join(' '),
};

/** Усиление после провала QC (авто-ретрай, SPEC §5): дописывается в конец промта. */
export const RETRY_BOOST =
  'Critical: render the exact same person as in the identity references with a perfectly ' +
  'accurate face; hands must be anatomically correct with five fingers; keep the photo ' +
  'looking like a genuine unedited smartphone shot.';

/** Анти-артефакт гардрейлы: всегда в конце промта. */
export const ANTI_ARTIFACT_GUARDRAILS = [
  'Anatomically correct hands with five fingers each.',
  'No extra limbs, no warped facial features, no duplicated body parts.',
  'No plastic waxy AI-glossy skin.',
  'No text, no captions, no logos, no watermarks anywhere in the image.',
  'No borders or frames.',
].join(' ');

/**
 * Identity-блок: явная нумерация референсов (неприкосновенный порядок — SPEC §2)
 * + идентити-нота модели дословно (note/auto_note из конструктора моделей).
 */
export function buildIdentityBlock(modelNote: string, identityRefCount: number): string {
  const refs =
    identityRefCount === 1
      ? 'Reference image 1 is the identity of the person: match the face, hair and body exactly.'
      : `Reference images 1-${identityRefCount} are the identity of the same person from different angles: match the face, hair and body exactly.`;
  const note = modelNote.trim();
  return note ? `${refs} ${note}` : refs;
}

/**
 * Anchor-блок для слайдов 2..N: якорь идёт СЛЕДУЮЩИМ номером после identity-рефов.
 */
export function buildAnchorBlock(anchorRefIndex: number): string {
  return (
    `Reference image ${anchorRefIndex} is the previous slide of this photo carousel: ` +
    'keep the same person, same outfit, same hairstyle, same location palette, ' +
    'same lighting and the same color grade fully consistent with it.'
  );
}

/** Product/outfit-референс пользователя (опционально, последний номер). */
export function buildProductBlock(productRefIndex: number, note: string): string {
  const base = `Reference image ${productRefIndex} is a product/outfit item that must appear in the shot exactly as shown.`;
  const trimmed = note.trim();
  return trimmed ? `${base} ${trimmed}` : base;
}

/** Формат кадра. */
export function formatBlock(aspect: '4:5' | '1:1'): string {
  return aspect === '4:5'
    ? 'Vertical 4:5 portrait framing, full-bleed, composed for an Instagram feed carousel.'
    : 'Square 1:1 framing, full-bleed, composed for an Instagram feed carousel.';
}

/**
 * Карусельная лестница смягчения модерации (SPEC §2): moderationLadder видео-доктрины
 * здесь бесполезен (заточен под FIGURE-фразы), поэтому своя — тиеринг UGC-строк
 * кожи/тела. Каждый следующий тир применяется к предыдущему результату.
 * Тир 0 = исходный промт; максимум смягчений = CAROUSEL_MODERATION_TIERS.length.
 */
const TIER_TRANSFORMS: Array<Array<{ find: RegExp; replace: string }>> = [
  // Тир 1: нейтрализуем формулировки про кожу.
  [
    { find: /Natural skin texture with visible pores, absolutely no beauty retouch\./g, replace: 'Natural realistic appearance.' },
    { find: /Natural skin texture, no beauty retouch\./g, replace: 'Natural realistic appearance.' },
    { find: /Natural retouch-free skin, flattering available light\./g, replace: 'Natural appearance, flattering available light.' },
  ],
  // Тир 2: обобщаем описание тела в identity-блоке.
  [{ find: /match the face, hair and body exactly/g, replace: 'match the person exactly' }],
];

export function carouselModerationLadder(prompt: string): string[] {
  const ladder = [prompt];
  let current = prompt;
  for (const tier of TIER_TRANSFORMS) {
    let next = current;
    for (const t of tier) next = next.replace(t.find, t.replace);
    if (next !== current) {
      ladder.push(next);
      current = next;
    }
  }
  return ladder;
}
