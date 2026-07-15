import fs from 'node:fs';
import path from 'node:path';
import { ANALYSIS_JSON_SCHEMA, AnalysisZ, type Analysis } from '../../../shared/analysis';
import type { FrameInfo, VideoMeta } from '../../../shared/api-types';
import { framesDir } from '../storage';
import { getLlm, type ContentPart } from '../llm/provider';
import { modelChainFor } from '../config';
import { ANALYST_SYSTEM } from './doctrine';

export function frameToPart(projectId: string, file: string): { b64: string; mime: string } {
  const p = path.join(framesDir(projectId), file);
  return { b64: fs.readFileSync(p).toString('base64'), mime: 'image/jpeg' };
}

export async function runAnalysis(
  projectId: string,
  meta: VideoMeta,
  frames: FrameInfo[],
): Promise<Analysis> {
  const parts: ContentPart[] = [
    {
      type: 'text',
      text:
        `SOURCE VIDEO: duration ${meta.durationSec}s, ${meta.width}x${meta.height} (${meta.aspect}), ${meta.fps} fps.\n` +
        `${frames.length} frames follow, each preceded by its label. "scene" = scene-change boundary, "grid" = uniform sampling, "first" = the exact first frame.`,
    },
  ];
  for (const f of frames) {
    parts.push({ type: 'text', text: `Frame @ ${f.t.toFixed(2)}s (${f.kind}):` });
    parts.push({
      type: 'image',
      ...frameToPart(projectId, f.file),
      // сценовые и первый кадр — важные, сетка — дешёвым low-detail
      detail: f.kind === 'grid' ? 'low' : 'high',
    });
  }

  const llm = await getLlm();
  const raw = await llm.structured({
    system: ANALYST_SYSTEM,
    parts,
    schemaName: 'video_analysis',
    schema: ANALYSIS_JSON_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 12_000,
    models: modelChainFor('analyze'),
  });

  const parsed = AnalysisZ.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `LLM вернул анализ не по схеме: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}
