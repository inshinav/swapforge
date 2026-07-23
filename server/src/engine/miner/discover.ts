// P9: автоподбор вирусного под модель (запрос Alex): персона → темы+хэштеги (LLM),
// хэштеги → топ-авторы (Apify hashtag-scraper) → дальше обычный profile-майнинг
// (это и есть «фаза 2 хэштегов» из SPEC §3, реализованная честно через profile-pass).
import { getDb } from '../../db';
import { getLlm, type ContentPart, type LlmClient } from '../../llm/provider';
import { carouselTestLlm } from '../carousel/engines';
import { modelChainFor } from '../../config';
import { variantRefs } from '../../models';
import type { Apify } from '../../apify';
import {
  MINING_THEMES_JSON_SCHEMA,
  MiningThemesZ,
  type MiningThemes,
} from '../../../../shared/carousel';

export const IG_HASHTAG_ACTOR = 'apify/instagram-hashtag-scraper';

export const THEMES_SYSTEM = [
  'You suggest Instagram research themes for finding viral photo/carousel content that matches',
  'an AI persona. You receive the persona description.',
  'Produce 3-6 distinct themes. Rules:',
  '- label in RUSSIAN (shown as a chip to a Russian-speaking creator), short (2-4 words);',
  '- hashtags: 2-4 REAL popular English Instagram hashtags per theme, lowercase, no # sign,',
  '  specific enough to surface model/lifestyle content (e.g. bikerlifestyle, miamimodel);',
  '- themes must be visually distinct from each other and true to the persona.',
  'JSON only.',
].join('\n');

/** Persona-нота модели: все identity-заметки (RU допустим — LLM переварит). */
export function modelPersonaNote(modelId: string | null): string {
  if (!modelId) return '';
  try {
    const variants = getDb()
      .prepare(`SELECT id FROM model_variants WHERE model_id=? ORDER BY idx LIMIT 1`)
      .get(modelId) as { id: string } | undefined;
    if (!variants) return '';
    return variantRefs(modelId, variants.id)
      .filter((r) => r.role === 'model')
      .map((r) => (r.note || r.auto_note).trim())
      .filter(Boolean)
      .join(' ')
      .slice(0, 1200);
  } catch {
    return '';
  }
}

export interface SuggestThemesInput {
  collectionId: string;
  userId: string;
  opId: string;
  modelId: string | null;
}

export async function suggestThemes(input: SuggestThemesInput, llm?: LlmClient): Promise<MiningThemes> {
  const client = llm ?? carouselTestLlm() ?? (await getLlm());
  const parts: ContentPart[] = [
    {
      type: 'text',
      text: `PERSONA: ${modelPersonaNote(input.modelId) || 'young female lifestyle creator (Miami vibes)'}`,
    },
  ];
  const raw = await client.structured({
    system: THEMES_SYSTEM,
    parts,
    schemaName: 'carousel_discover',
    schema: MINING_THEMES_JSON_SCHEMA,
    maxTokens: 900,
    models: modelChainFor('generate'),
    meta: { userId: input.userId, generationId: input.opId, collectionId: input.collectionId },
  });
  return MiningThemesZ.parse(raw);
}

/** Пост hashtag-скрейпера: автор + лайки (followersCount тут НЕТ — добирает profile-pass). */
interface HashtagItem {
  ownerUsername?: string;
  likesCount?: number;
}

export interface DiscoveryOpts {
  perTag?: number;
  maxAccounts?: number;
  pollMs?: number;
  deadlineMs?: number;
}

/**
 * Хэштеги → кандидаты-аккаунты: топ-авторы по суммарным лайкам их постов в выдаче.
 * Возвращает usernames для существующего profile-майнинга (ER посчитается честно там).
 */
export async function discoverAccounts(
  client: Apify,
  hashtags: string[],
  opts: DiscoveryOpts = {},
): Promise<{ apifyRunId: string; usernames: string[] }> {
  const perTag = opts.perTag ?? 30;
  const tags = hashtags.slice(0, 3);
  const run = await client.startActorRun(IG_HASHTAG_ACTOR, {
    hashtags: tags,
    resultsLimit: perTag,
  });
  const deadline = Date.now() + (opts.deadlineMs ?? 10 * 60_000);
  for (;;) {
    const st = await client.getRun(run.runId);
    if (st.status === 'SUCCEEDED') {
      const items = await client.datasetItems<HashtagItem>(st.defaultDatasetId ?? '', {
        limit: tags.length * perTag,
      });
      return { apifyRunId: run.runId, usernames: topAuthors(items, opts.maxAccounts ?? 6) };
    }
    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(st.status)) {
      throw new Error(`Дискавери-ран Apify завершился статусом ${st.status}`);
    }
    if (Date.now() > deadline) throw new Error('Дискавери не уложился в 10 минут');
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 5000));
  }
}

/** Чистая агрегация: авторы по суммарным лайкам убыв., без дублей и мусора. */
export function topAuthors(items: HashtagItem[], maxAccounts: number): string[] {
  const byAuthor = new Map<string, number>();
  for (const it of items) {
    const u = (it.ownerUsername ?? '').trim().toLowerCase();
    if (!/^[a-z0-9._]{1,30}$/.test(u)) continue;
    byAuthor.set(u, (byAuthor.get(u) ?? 0) + Math.max(0, Number(it.likesCount ?? 0)));
  }
  return [...byAuthor.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxAccounts)
    .map(([u]) => u);
}
