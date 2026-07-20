import { describe, expect, it } from 'vitest';
import type { RefInfo } from '../../shared/api-types';
import {
  MAX_PROJECT_REFS,
  ReferenceLimitError,
  buildReferenceManifest,
} from '../src/engine/reference-manifest';

function ref(idx: number, patch: Partial<RefInfo> = {}): RefInfo {
  return {
    id: `ref-${idx}`,
    idx,
    role: 'model',
    file: `ref-${idx}.jpg`,
    note: '',
    ...patch,
  };
}

describe('ReferenceManifest', () => {
  it('gives every AI stage one deterministic order and fingerprint', () => {
    const refs = [ref(2), ref(0), ref(1)];
    const manifest = buildReferenceManifest(refs);
    expect(manifest.refs.map((item) => item.idx)).toEqual([0, 1, 2]);
    expect(buildReferenceManifest([...refs].reverse()).fingerprint).toBe(manifest.fingerprint);
  });

  it('changes its fingerprint on reorder, role or note mutation', () => {
    const base = buildReferenceManifest([ref(0), ref(1)]).fingerprint;
    expect(buildReferenceManifest([ref(1, { idx: 0 }), ref(0, { idx: 1 })]).fingerprint).not.toBe(base);
    expect(buildReferenceManifest([ref(0, { role: 'object' }), ref(1)]).fingerprint).not.toBe(base);
    expect(buildReferenceManifest([ref(0, { note: 'вид сзади' }), ref(1)]).fingerprint).not.toBe(base);
  });

  it('accepts eight references and rejects the ninth instead of truncating it', () => {
    expect(buildReferenceManifest(Array.from({ length: MAX_PROJECT_REFS }, (_, i) => ref(i))).refs).toHaveLength(8);
    expect(() => buildReferenceManifest(Array.from({ length: MAX_PROJECT_REFS + 1 }, (_, i) => ref(i)))).toThrow(
      ReferenceLimitError,
    );
  });
});
