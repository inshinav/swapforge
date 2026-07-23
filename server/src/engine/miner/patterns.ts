// PatternCards (SPEC §3): vision-LLM превращает вирусный пост в СТРУКТУРНУЮ карточку.
// Жёсткие правила: в карточке нет текста подписи и уникальных деталей кадра; миниатюра
// хранится только для показа в подборке (атрибуция) и НИКОГДА не идёт в генерацию.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb } from '../../db';
import { getLlm, type ContentPart, type LlmClient } from '../../llm/provider';
import { carouselTestLlm } from '../carousel/engines';
import { modelChainFor } from '../../config';
import { ensureMinerDir, minerDir } from '../../storage';
import { PATTERN_CARD_JSON_SCHEMA, PatternCardStructureZ } from '../../../../shared/carousel';
import { engagementRate, type MinedPost } from './virality';

export const PATTERN_SYSTEM = [
  'You analyze a viral Instagram photo/carousel post to extract its REUSABLE STRUCTURE.',
  'You see the cover image and engagement metadata.',
  'Extract ONLY abstract structural patterns:',
  '- hookType: what grabs attention on the cover (generic mechanism, not specific content);',
  '- slideRoles/composition: generic techniques (e.g. "tight face crop", "text-first cover");',
  '- captionStyle: the STRUCTURE of a typical caption for such post (e.g. "hook → story → CTA").',
  'STRICTLY FORBIDDEN: copying any specific text, names, locations, outfit details or unique',
  'visual elements of the source. Never reproduce the caption. Structure only. JSON only.',
].join('\n');

const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

/** Скачать миниатюру в thumb-кэш подборки (fetch инжектируется — тесты без сети). */
export async function downloadThumb(
  collectionId: string,
  thumbUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(thumbUrl, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100 || buf.length > 5 * 1024 * 1024) return null;
    ensureMinerDir(collectionId);
    const file = `thumb_${randomUUID().slice(0, 8)}.jpg`;
    fs.writeFileSync(path.join(minerDir(collectionId), file), buf);
    return file;
  } catch {
    return null;
  }
}

export interface PatternCardInput {
  collectionId: string;
  userId: string;
  /** op-id майнинг-рана — атрибуция затрат (settle по факту, SPEC §7). */
  opId: string;
  post: MinedPost;
  /** Имя файла миниатюры в thumb-кэше (null — анализ только по метаданным). */
  thumbFile: string | null;
}

/** Vision→структура→строка pattern_cards. Возвращает id карточки. */
export async function createPatternCard(input: PatternCardInput, llm?: LlmClient): Promise<string> {
  const client = llm ?? carouselTestLlm() ?? (await getLlm());
  const parts: ContentPart[] = [
    {
      type: 'text',
      text:
        `POST METADATA: type=${input.post.type}, likes=${input.post.likes}, comments=${input.post.comments}, ` +
        `followers=${input.post.ownerFollowers}, ER=${(engagementRate(input.post) * 100).toFixed(1)}%, ` +
        `slides=${input.post.slideCount ?? 'unknown'}`,
    },
  ];
  if (input.thumbFile) {
    const full = path.join(minerDir(input.collectionId), input.thumbFile);
    parts.push({
      type: 'image',
      b64: fs.readFileSync(full).toString('base64'),
      mime: MIME[path.extname(full).toLowerCase()] ?? 'image/jpeg',
      detail: 'high',
    });
  }
  const raw = await client.structured({
    system: PATTERN_SYSTEM,
    parts,
    schemaName: 'carousel_pattern',
    schema: PATTERN_CARD_JSON_SCHEMA,
    maxTokens: 900,
    models: modelChainFor('analyze'),
    meta: { userId: input.userId, generationId: input.opId, collectionId: input.collectionId },
  });
  const structure = PatternCardStructureZ.parse(raw);
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO pattern_cards (id, collection_id, source_url, platform, author, virality_json, structure_json, thumb_file, niche_tags_json)
       VALUES (?, ?, ?, 'instagram', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.collectionId,
      input.post.url,
      input.post.author,
      JSON.stringify({
        likes: input.post.likes,
        comments: input.post.comments,
        followers: input.post.ownerFollowers,
        er: Math.round(engagementRate(input.post) * 1e4) / 1e4,
      }),
      JSON.stringify(structure),
      input.thumbFile,
      JSON.stringify(structure.nicheTags),
    );
  return id;
}
