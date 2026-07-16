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

  // Первый кадр — для точной реконструкции сцены старт-кадра
  const firstFrame = path.join(framesDir(projectId), 'first.jpg');
  if (fs.existsSync(firstFrame)) {
    parts.push({ type: 'text', text: 'SOURCE FIRST FRAME (reconstruct this exact shot in the imagePrompt):' });
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

  return { system, parts };
}

export function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/** Норма доктрины 130–200; выше потолка — один принудительный компресс-проход. */
export const VIDEO_PROMPT_MAX_WORDS = 220;

/** Текст компресс-прохода: без картинок и анализа — только прежний вывод и бюджет.
 *  Точечная цель (170–190) вместо полосы: по полосе модели стабильно промахиваются вверх. */
export function buildCompressionRequest(pair: PromptPair): string {
  return (
    `Your previous output is over the WORD BUDGET (videoPrompt = ${wordCount(pair.videoPrompt)} words).\n` +
    `Rewrite BOTH prompts compressed. TARGET: videoPrompt 170–190 words (hard ceiling 200); imagePrompt 100–140 (ceiling 160). Rules:\n` +
    `- Keep verbatim: the reference-1 line, identity-lock sentences, active mode sentences (REMOVE-text / figure).\n` +
    `- Keep every DO NOT guardrail (merging clauses into fewer sentences is fine).\n` +
    `- Merge the KEEP list down to the 8–12 strongest anchors (reflective/moving elements, light, camera path first).\n` +
    `- Cut adjectives and repetition. If still over the ceiling, DELETE the weakest KEEP anchors until it fits.\n` +
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

  // Бюджет слов — энфорсмент кодом: один дешёвый компресс-проход (без картинок),
  // при любом сбое остаёмся на исходной паре (fail-soft)
  const words = wordCount(parsed.data.videoPrompt);
  if (words <= VIDEO_PROMPT_MAX_WORDS) return parsed.data;
  try {
    const rawC = await llm.structured({
      system,
      parts: [{ type: 'text', text: buildCompressionRequest(parsed.data) }],
      schemaName: 'prompt_pair',
      schema: PROMPT_PAIR_JSON_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 4000,
      models: modelChainFor('generate'),
      meta: { projectId },
    });
    const compressed = PromptPairZ.safeParse(rawC);
    if (compressed.success && wordCount(compressed.data.videoPrompt) < words) {
      console.log(
        `[prompt-length] videoPrompt ${words} слов > ${VIDEO_PROMPT_MAX_WORDS} → сжат до ${wordCount(compressed.data.videoPrompt)}`,
      );
      return compressed.data;
    }
  } catch (e) {
    console.warn(
      `[prompt-length] компресс-проход не удался (${e instanceof Error ? e.message.slice(0, 120) : e}) — оставляю исходный промт (${words} слов)`,
    );
  }
  return parsed.data;
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
