import { createHash } from 'node:crypto';
import type { RefInfo } from '../../../shared/api-types';
import { MAX_PROJECT_REFS } from '../../../shared/api-types';
import { getDb } from '../db';

export { MAX_PROJECT_REFS };

export class ReferenceLimitError extends Error {
  readonly count: number;

  constructor(count: number) {
    super(
      `Можно использовать не больше ${MAX_PROJECT_REFS} референсов. Сейчас ${count} — убери лишние фото и оставь самые чёткие ракурсы.`,
    );
    this.name = 'ReferenceLimitError';
    this.count = count;
  }
}

export interface ReferenceManifest {
  refs: RefInfo[];
  fingerprint: string;
}

/** Канонический порядок для всех AI-стадий и пользовательской сметы. */
export function orderedReferences(refs: RefInfo[]): RefInfo[] {
  return [...refs].sort((a, b) => a.idx - b.idx || a.id.localeCompare(b.id));
}

export function referenceFingerprint(refs: RefInfo[]): string {
  const payload = orderedReferences(refs).map((r) => [r.idx, r.role, r.file, r.note.trim()]);
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function buildReferenceManifest(refs: RefInfo[]): ReferenceManifest {
  const ordered = orderedReferences(refs);
  if (ordered.length > MAX_PROJECT_REFS) throw new ReferenceLimitError(ordered.length);
  return { refs: ordered, fingerprint: referenceFingerprint(ordered) };
}

export function loadReferenceManifest(projectId: string): ReferenceManifest {
  const refs = getDb()
    .prepare(`SELECT id, idx, role, file, note FROM refs WHERE project_id = ? ORDER BY idx ASC, rowid ASC`)
    .all(projectId) as unknown as RefInfo[];
  return buildReferenceManifest(refs);
}
