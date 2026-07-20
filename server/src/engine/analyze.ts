import fs from 'node:fs';
import path from 'node:path';
import { ANALYSIS_JSON_SCHEMA, AnalysisZ, type Analysis } from '../../../shared/analysis';
import type { FrameInfo, VideoMeta } from '../../../shared/api-types';
import type { RefInfo } from '../../../shared/api-types';
import { framesDir, refsDir } from '../storage';
import { getLlm, type ContentPart } from '../llm/provider';
import { modelChainFor } from '../config';
import { ANALYST_SYSTEM } from './doctrine';
import { REFERENCE_AUDIT_GUIDANCE } from './reference-audit';
import { buildReferenceManifest } from './reference-manifest';

export function frameToPart(projectId: string, file: string): { b64: string; mime: string } {
  const p = path.join(framesDir(projectId), file);
  return { b64: fs.readFileSync(p).toString('base64'), mime: 'image/jpeg' };
}

export async function runAnalysis(
  projectId: string,
  meta: VideoMeta,
  frames: FrameInfo[],
  refs: RefInfo[] = [],
): Promise<Analysis> {
  const manifest = buildReferenceManifest(refs);
  refs = manifest.refs;
  const parts: ContentPart[] = [
    {
      type: 'text',
      text:
        `SOURCE VIDEO: duration ${meta.durationSec}s, ${meta.width}x${meta.height} (${meta.aspect}), ${meta.fps} fps.\n` +
        `${frames.length} frames follow, each preceded by its label. "scene" = scene-change boundary, "grid" = uniform sampling, "first" = the exact first frame.\n` +
        REFERENCE_AUDIT_GUIDANCE,
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
  parts.push({
    type: 'text',
    text: refs.length
      ? `PROJECT REFERENCES (${refs.length}; this exact ordered manifest is used by every AI stage):`
      : 'PROJECT REFERENCES: none attached. Mark the missing model reference as a blocker.',
  });
  for (const [i, ref] of refs.entries()) {
    const p = path.join(refsDir(projectId), ref.file);
    if (!fs.existsSync(p)) continue;
    const ext = path.extname(ref.file).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    parts.push({
      type: 'text',
      text: `Project reference ${i + 1}: role=${ref.role}; user note=${ref.note || 'none'}; sent to every AI stage in this position.`,
    });
    parts.push({ type: 'image', b64: fs.readFileSync(p).toString('base64'), mime, detail: 'high' });
  }

  const llm = await getLlm();
  const raw = await llm.structured({
    system: ANALYST_SYSTEM,
    parts,
    schemaName: 'video_analysis',
    schema: ANALYSIS_JSON_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 12_000,
    models: modelChainFor('analyze'),
    meta: { projectId },
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
  const analysis = parsed.data;
  if (analysis.referenceAudit) {
    const hasBlocker = analysis.referenceAudit.issues.some((i) => i.severity === 'blocker');
    const hasWarning = analysis.referenceAudit.issues.some((i) => i.severity === 'warning');
    analysis.referenceAudit.verdict = hasBlocker ? 'blocked' : hasWarning ? 'review' : 'ready';
    analysis.referenceAudit.accepted = false;
    analysis.referenceAudit.refFingerprint = manifest.fingerprint;
  }
  return analysis;
}
