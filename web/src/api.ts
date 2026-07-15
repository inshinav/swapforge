import type { HealthInfo, ProjectFull, ProjectSummary } from '@shared/api-types';

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
  health: () => fetch('/api/health').then((r) => j<HealthInfo>(r)),
  projects: () => fetch('/api/projects').then((r) => j<ProjectSummary[]>(r)),
  project: (id: string) => fetch(`/api/projects/${id}`).then((r) => j<ProjectFull>(r)),
  deleteProject: (id: string) =>
    fetch(`/api/projects/${id}`, { method: 'DELETE' }).then((r) => j<{ ok: true }>(r)),

  createProject: (file: File) => {
    const fd = new FormData();
    fd.append('title', file.name.replace(/\.[^.]+$/, ''));
    fd.append('video', file);
    return fetch('/api/projects', { method: 'POST', body: fd }).then((r) => j<{ id: string }>(r));
  },

  addRef: (projectId: string, file: File, role: string, note: string) => {
    const fd = new FormData();
    fd.append('role', role);
    fd.append('note', note);
    fd.append('photo', file);
    return fetch(`/api/projects/${projectId}/refs`, { method: 'POST', body: fd }).then((r) =>
      j<{ id: string }>(r),
    );
  },
  patchRefs: (
    projectId: string,
    body: { order?: string[]; updates?: Array<{ id: string; role?: string; note?: string }> },
  ) =>
    fetch(`/api/projects/${projectId}/refs`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => j<{ ok: true }>(r)),
  deleteRef: (projectId: string, refId: string) =>
    fetch(`/api/projects/${projectId}/refs/${refId}`, { method: 'DELETE' }).then((r) =>
      j<{ ok: true }>(r),
    ),

  storyboardRetry: (id: string) =>
    post(`/api/projects/${id}/storyboard`).then((r) => j<{ ok: true }>(r)),
  analyze: (id: string) => post(`/api/projects/${id}/analyze`).then((r) => j<{ ok: true }>(r)),
  generate: (id: string, body: { lang: string; endpoint: string }) =>
    post(`/api/projects/${id}/generate`, body).then((r) => j<{ ok: true }>(r)),
  feedback: (
    id: string,
    body: { version: number; worked: boolean; artifacts: string[]; notes: string },
  ) => post(`/api/projects/${id}/feedback`, body).then((r) => j<{ ok: true }>(r)),
  iterate: (
    id: string,
    body: { version: number; artifacts: string[]; notes: string; lang: string; endpoint: string },
  ) => post(`/api/projects/${id}/iterate`, body).then((r) => j<{ ok: true }>(r)),

  mediaUrl: (id: string, sub: 'frames' | 'refs' | 'src', file: string) =>
    `/api/projects/${id}/media/${sub}/${encodeURIComponent(file)}`,
};
