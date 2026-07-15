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
import { DOCTRINE_SYSTEM, ITERATION_ADDENDUM } from './doctrine';
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
  const system = DOCTRINE_SYSTEM + (opts.iteration ? ITERATION_ADDENDUM : '');
  const parts: ContentPart[] = [];

  parts.push({
    type: 'text',
    text:
      `TASK: generate the two prompts for this project. imagePrompt language: ${opts.lang === 'ru' ? 'Russian' : 'English'}. videoPrompt: English.\n\n` +
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
      text: `## PRIOR SUCCESSFUL PROJECTS (similar; use as level/style anchors — do NOT copy their scene contents)\n${blocks.join('\n\n')}`,
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
  });
  const parsed = PromptPairZ.safeParse(raw);
  if (!parsed.success) throw new Error('LLM вернул промты не по схеме — повтори генерацию');
  return parsed.data;
}

/** Параметр-блок WaveSpeed: код, не LLM — имена полей точные. */
export function buildSeedanceParams(
  meta: VideoMeta,
  refs: RefInfo[],
  endpoint: 'seedance-2.0' | 'seedance-2.0-fast',
): SeedanceParams {
  return {
    endpoint: `bytedance/${endpoint}/video-edit`,
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
