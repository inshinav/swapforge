import type { HealthInfo, ProjectFull, ProjectSummary } from '@shared/api-types';

// База приложения ('/swapforge/'): API и медиа всегда под ней — nginx срезает префикс.
// URL строим АБСОЛЮТНЫМ от location.origin: если страница открыта ссылкой вида
// https://user:pass@host/…, относительный fetch унаследовал бы креды и упал бы
// («Request cannot be constructed from a URL that includes credentials»).
export const appBase = import.meta.env.BASE_URL;
const u = (p: string) => `${window.location.origin}${appBase}${p}`;

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      const body = (await r.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      /* не-JSON ответ */
    }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

const post = (url: string, body?: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

export const api = {
  health: () => fetch(u('api/health')).then((r) => j<HealthInfo>(r)),
  projects: () => fetch(u('api/projects')).then((r) => j<ProjectSummary[]>(r)),
  project: (id: string) => fetch(u(`api/projects/${id}`)).then((r) => j<ProjectFull>(r)),
  deleteProject: (id: string) =>
    fetch(u(`api/projects/${id}`), { method: 'DELETE' }).then((r) => j<{ ok: true }>(r)),

  uploadUrl: () => u('api/projects'),

  addRef: (projectId: string, file: File, role: string, note: string) => {
    const fd = new FormData();
    fd.append('role', role);
    fd.append('note', note);
    fd.append('photo', file);
    return fetch(u(`api/projects/${projectId}/refs`), { method: 'POST', body: fd }).then((r) =>
      j<{ id: string }>(r),
    );
  },
  patchRefs: (
    projectId: string,
    body: { order?: string[]; updates?: Array<{ id: string; role?: string; note?: string }> },
  ) =>
    fetch(u(`api/projects/${projectId}/refs`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => j<{ ok: true }>(r)),
  deleteRef: (projectId: string, refId: string) =>
    fetch(u(`api/projects/${projectId}/refs/${refId}`), { method: 'DELETE' }).then((r) =>
      j<{ ok: true }>(r),
    ),

  storyboardRetry: (id: string) =>
    post(u(`api/projects/${id}/storyboard`)).then((r) => j<{ ok: true }>(r)),
  analyze: (id: string, model?: string) =>
    post(u(`api/projects/${id}/analyze`), { model }).then((r) => j<{ ok: true }>(r)),
  generate: (id: string, body: { lang: string; endpoint: string; model?: string }) =>
    post(u(`api/projects/${id}/generate`), body).then((r) => j<{ ok: true }>(r)),
  feedback: (
    id: string,
    body: { version: number; worked: boolean; artifacts: string[]; notes: string },
  ) => post(u(`api/projects/${id}/feedback`), body).then((r) => j<{ ok: true }>(r)),
  iterate: (
    id: string,
    body: {
      version: number;
      artifacts: string[];
      notes: string;
      lang: string;
      endpoint: string;
      model?: string;
    },
  ) => post(u(`api/projects/${id}/iterate`), body).then((r) => j<{ ok: true }>(r)),
  startFrame: (id: string, body: { version: number; model?: string; quality?: string }) =>
    post(u(`api/projects/${id}/startframe`), body).then((r) =>
      j<{ file: string; version: number }>(r),
    ),

  mediaUrl: (id: string, sub: 'frames' | 'refs' | 'src' | 'start', file: string) =>
    u(`api/projects/${id}/media/${sub}/${encodeURIComponent(file)}`),
};
