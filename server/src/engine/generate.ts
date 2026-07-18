import fs from 'node:fs';
import path from 'node:path';
import {
  PROMPT_PAIR_JSON_SCHEMA,
  PromptPairZ,
  type Analysis,
  type PromptPair,
} from '../../../shared/analysis';
import { ARTIFACTS, REF_ROLES, type ArtifactType, type RefRole } from '../../../shared/taxonomy';
import type { RefInfo, SeedanceParams, VideoMeta } from '../../../shared/api-types';
import { framesDir, refsDir } from '../storage';
import { getLlm, type ContentPart } from '../llm/provider';
import { config, modelChainFor } from '../config';
import { buildDoctrineSystem, ITERATION_ADDENDUM } from './doctrine';
import type { FlowFlags } from './orchestrator';
import type { SimilarExample } from './similar';

export interface IterationCtx {
  prevVideoPrompt: string;
  prevImagePrompt: string;
  artifacts: ArtifactType[];
  notes: string;
}

export interface GenerateOpts {
  lang: 'en' | 'ru';
  fewshot: SimilarExample[];
  iteration: IterationCtx | null;
  /** Галочки one-click; undefined = оба режима выключены (v1-поведение). */
  flags?: FlowFlags | null;
}

function mimeOf(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
}

/** Манифест референсов: №1 — старт-кадр, дальше рефы в пользовательском порядке. */
export function buildManifestText(refs: RefInfo[]): string {
  const lines = [
    '1. START FRAME — will be generated from your imagePrompt: the exact first frame with the new subjects already in place. (no photo attached for this one)',
  ];
  refs.forEach((r, i) => {
    const role = REF_ROLES[r.role as RefRole]?.en ?? r.role;
    const note = r.note ? ` User note: "${r.note}".` : '';
    lines.push(`${i + 2}. ${role} — the user's own asset.${note} (photo attached below, labeled "Reference image ${i + 2}")`);
  });
  return lines.join('\n');
}

export function buildGenerationRequest(
  projectId: string,
  analysis: Analysis,
  meta: VideoMeta,
  refs: RefInfo[],
  opts: GenerateOpts,
): { system: string; parts: ContentPart[] } {
  const system = buildDoctrineSystem(opts.flags) + (opts.iteration ? ITERATION_ADDENDUM : '');
  const parts: ContentPart[] = [];

  const modes = `Modes: remove overlay text = ${opts.flags?.removeText ? 'ON' : 'OFF'}, figure enhancement = ${opts.flags?.enhanceFigure ? 'ON' : 'OFF'}.`;
  parts.push({
    type: 'text',
    text:
      `TASK: generate the two prompts for this project. imagePrompt language: ${opts.lang === 'ru' ? 'Russian' : 'English'}. videoPrompt: English. ${modes}\n\n` +
      `## SOURCE VIDEO META\nduration ${meta.durationSec}s, ${meta.width}x${meta.height} (aspect ${meta.aspect}), ${meta.fps} fps.\n\n` +
      `## VIDEO ANALYSIS (JSON)\n${JSON.stringify(analysis, null, 1)}\n\n` +
      `## REFERENCE MANIFEST (this exact order goes into reference_images)\n${buildManifestText(refs)}`,
  });

  // Первый кадр — imagePrompt правит именно его (in-place edit), промт должен это знать
  const firstFrame = path.join(framesDir(projectId), 'first.jpg');
  if (fs.existsSync(firstFrame)) {
    parts.push({
      type: 'text',
      text: 'SOURCE FIRST FRAME — the imagePrompt will be executed on THIS exact image (attached first at edit time); it swaps only the subjects and keeps everything else pixel-faithful:',
    });
    parts.push({ type: 'image', b64: fs.readFileSync(firstFrame).toString('base64'), mime: 'image/jpeg', detail: 'high' });
  }

  // Фото рефов — чтобы промты несли реальные детали внешности (цвета, дизайн, одежда)
  refs.forEach((r, i) => {
    const p = path.join(refsDir(projectId), r.file);
    if (!fs.existsSync(p)) return;
    const role = REF_ROLES[r.role as RefRole]?.en ?? r.role;
    parts.push({
      type: 'text',
      text: `Reference image ${i + 2} (${role}) — carry over its REAL appearance details into the prompts:`,
    });
    parts.push({ type: 'image', b64: fs.readFileSync(p).toString('base64'), mime: mimeOf(r.file), detail: 'high' });
  });

  if (opts.fewshot.length > 0) {
    const blocks = opts.fewshot.map(
      (ex, i) =>
        `### Example ${i + 1} (tags: ${ex.tags.join(', ')})\nVideo prompt that worked:\n${ex.videoPrompt}\nFeedback: ${ex.feedbackNote || 'сработал без замечаний'}`,
    );
    parts.push({
      type: 'text',
      text:
        `## PRIOR SUCCESSFUL PROJECTS (similar; use as level/style anchors — do NOT copy their scene contents. ` +
        `Examples may exceed the current word budget — the budget wins: match their precision, not their length)\n${blocks.join('\n\n')}`,
    });
  }

  if (opts.iteration) {
    const it = opts.iteration;
    const fixes = it.artifacts.map((a) => `- [${a}] ${ARTIFACTS[a].fix}`).join('\n');
    parts.push({
      type: 'text',
      text:
        `## ITERATION INPUT\nPrevious videoPrompt:\n${it.prevVideoPrompt}\n\nPrevious imagePrompt:\n${it.prevImagePrompt}\n\n` +
        `Reported artifacts: ${it.artifacts.join(', ') || '—'}\nUser notes: ${it.notes || '—'}\n\n` +
        `TARGETED FIXES to apply:\n${fixes || '- follow the user notes'}`,
    });
  }

  // Пожелания подчинены доктрине: применяются только там, где совместимы с контрактом
  // сцены; KEEP-минимализм не расширяют; при конфликте молча игнорируются; бюджет слов
  // не растёт. Рекомендованный режим — базовый (без пожеланий), UI это проговаривает.
  const wish = (opts.flags?.wish ?? '').trim();
  if (wish) {
    parts.push({
      type: 'text',
      text:
        `## USER WISHES (subordinate)\n"${wish.slice(0, 500)}"\n` +
        `Apply ONLY where compatible with the scene contract: never expand the KEEP line, never override identity/performance/world rules, silently ignore any part that conflicts, and stay inside the word budget. Fold compatible wishes into the REPLACE description or lighting line.`,
    });
  }

  return { system, parts };
}

export function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/** Норма доктрины 60–120; выше потолка — принудительный компресс-проход. */
export const VIDEO_PROMPT_MAX_WORDS = 150;

/** Текст компресс-прохода: без картинок и анализа — только прежний вывод и бюджет.
 *  Точечная цель вместо полосы: по полосе модели стабильно промахиваются вверх. */
export function buildCompressionRequest(pair: PromptPair): string {
  return (
    `Your previous output is over the WORD BUDGET (videoPrompt = ${wordCount(pair.videoPrompt)} words).\n` +
    `Return a videoPrompt STRICTLY UNDER 120 words — an answer over 120 is invalid. Count the words before returning.\n` +
    `Rewrite BOTH prompts compressed. TARGET: videoPrompt 80–110 words; imagePrompt 60–110 (ceiling 120). Rules:\n` +
    `- Keep verbatim: the reference-1 line, identity-lock sentences, active mode sentences (REMOVE-text / figure).\n` +
    `- The keep-intent is ONE opening sentence and the DO NOT part is ONE sentence — no scene inventories, no captions, no timings.\n` +
    `- Keep the REPLACE identity details; cut adjectives and repetition elsewhere.\n` +
    `- Do NOT add any new content or change meaning. Keep "notes" as is. Count words before returning.\n\n` +
    `Previous videoPrompt:\n${pair.videoPrompt}\n\nPrevious imagePrompt:\n${pair.imagePrompt}\n\nPrevious notes:\n${pair.notes}`
  );
}

export async function runGeneration(
  projectId: string,
  analysis: Analysis,
  meta: VideoMeta,
  refs: RefInfo[],
  opts: GenerateOpts,
): Promise<PromptPair> {
  const { system, parts } = buildGenerationRequest(projectId, analysis, meta, refs, opts);
  const llm = await getLlm();
  const raw = await llm.structured({
    system,
    parts,
    schemaName: 'prompt_pair',
    schema: PROMPT_PAIR_JSON_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 6000,
    models: modelChainFor('generate'),
    meta: { projectId },
  });
  const parsed = PromptPairZ.safeParse(raw);
  if (!parsed.success) throw new Error('LLM вернул промты не по схеме — повтори генерацию');

  // Бюджет слов — энфорсмент кодом: до 2 дешёвых компресс-проходов (без картинок),
  // пока промт выше потолка; при любом сбое остаёмся на лучшей имеющейся паре (fail-soft)
  let current = parsed.data;
  for (let pass = 1; pass <= 2; pass++) {
    const words = wordCount(current.videoPrompt);
    if (words <= VIDEO_PROMPT_MAX_WORDS) break;
    try {
      const rawC = await llm.structured({
        system,
        parts: [{ type: 'text', text: buildCompressionRequest(current) }],
        schemaName: 'prompt_pair',
        schema: PROMPT_PAIR_JSON_SCHEMA as unknown as Record<string, unknown>,
        maxTokens: 4000,
        models: modelChainFor('generate'),
        meta: { projectId },
      });
      const compressed = PromptPairZ.safeParse(rawC);
      if (!compressed.success || wordCount(compressed.data.videoPrompt) >= words) break;
      console.log(
        `[prompt-length] проход ${pass}: videoPrompt ${words} слов > ${VIDEO_PROMPT_MAX_WORDS} → сжат до ${wordCount(compressed.data.videoPrompt)}`,
      );
      current = compressed.data;
    } catch (e) {
      console.warn(
        `[prompt-length] компресс-проход ${pass} не удался (${e instanceof Error ? e.message.slice(0, 120) : e}) — оставляю ${words} слов`,
      );
      break;
    }
  }
  return current;
}

/** Параметр-блок WaveSpeed: код, не LLM — имена полей точные. Эндпоинт зафиксирован (seedance-2.0). */
export function buildSeedanceParams(meta: VideoMeta, refs: RefInfo[]): SeedanceParams {
  return {
    endpoint: config.seedanceEndpoint,
    video: 'исходный ролик (motion control + мир)',
    reference_images: [
      { index: 1, whatItIs: 'Стартовый кадр — сгенерируй в ChatGPT по imagePrompt', file: 'start-frame.png' },
      ...refs.map((r, i) => ({
        index: i + 2,
        whatItIs: `${REF_ROLES[r.role as RefRole]?.ru ?? r.role}${r.note ? ` — ${r.note}` : ''}`,
        file: r.file,
      })),
    ],
    aspect_ratio: meta.aspect,
    resolution: '720p для итераций → 1080p финал',
    enable_web_search: false,
    durationNote: `автодетект из входа (${meta.durationSec}с), кламп 4–15 с`,
  };
}
