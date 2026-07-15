import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectFull, RefInfo } from '@shared/api-types';
import { REF_ROLES, type RefRole } from '@shared/taxonomy';
import { api } from '../api';
import { Button, Card, ErrorNote, SectionTitle, Spinner, Tag } from '../ui';
import { AnalysisView } from './AnalysisView';
import { PromptsView } from './PromptsView';

const BUSY = ['storyboarding', 'analyzing', 'generating'];

function useProject(id: string | null) {
  const [proj, setProj] = useState<ProjectFull | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    if (!id) return;
    const my = ++seq.current; // защита от гонки устаревшего ответа при смене проекта
    try {
      const p = await api.project(id);
      if (seq.current !== my) return;
      setProj(p);
      setErr(null);
    } catch (e) {
      if (seq.current !== my) return;
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [id]);
  useEffect(() => {
    setProj(null);
    void reload();
  }, [id, reload]);
  const status = proj?.status;
  useEffect(() => {
    if (!status || !BUSY.includes(status)) return;
    const t = setInterval(() => void reload(), 1500);
    return () => clearInterval(t);
  }, [status, reload]);
  return { proj, err, reload };
}

/** XHR — ради прогресса загрузки больших роликов. */
function uploadVideo(file: File, onProgress: (pct: number) => void): Promise<{ id: string }> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('title', file.name.replace(/\.[^.]+$/, ''));
    fd.append('video', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/projects');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText) as { id?: string; error?: string };
        if (xhr.status >= 200 && xhr.status < 300 && body.id) resolve({ id: body.id });
        else reject(new Error(body.error ?? `HTTP ${xhr.status}`));
      } catch {
        reject(new Error(`HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('Сеть оборвалась во время загрузки'));
    xhr.send(fd);
  });
}

export default function NewSwap({
  projectId,
  onProjectCreated,
}: {
  projectId: string | null;
  onProjectCreated: (id: string) => void;
}) {
  const { proj, err, reload } = useProject(projectId);

  if (!projectId) return <UploadZone onCreated={onProjectCreated} />;
  if (err?.includes('не найден')) {
    // проект удалили — забываем его и показываем загрузку
    return (
      <div className="space-y-4">
        <ErrorNote text="Этот проект удалён — начни новый свап" />
        <UploadZone onCreated={onProjectCreated} />
      </div>
    );
  }
  if (err) return <ErrorNote text={err} onRetry={() => void reload()} />;
  if (!proj)
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner size={22} />
      </div>
    );

  return (
    <div className="space-y-5 sf-in">
      <VideoSection proj={proj} reload={reload} onNew={() => onProjectCreated('')} />
      <RefsSection proj={proj} reload={reload} />
      <AnalysisView proj={proj} reload={reload} />
      <PromptsView proj={proj} reload={reload} />
    </div>
  );
}

// ── Загрузка ролика ─────────────────────────────────────────────────────────

function UploadZone({ onCreated }: { onCreated: (id: string) => void }) {
  const [drag, setDrag] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handle = async (file: File | undefined) => {
    if (!file) return;
    setErr(null);
    setPct(0);
    try {
      const { id } = await uploadVideo(file, setPct);
      onCreated(id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPct(null);
    }
  };

  return (
    <div className="sf-in">
      <div
        className={`rounded-2xl border-2 border-dashed px-8 py-20 text-center transition-colors cursor-pointer select-none ${
          drag ? 'border-lime bg-lime/5' : 'border-line2 hover:border-lime/40'
        }`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          void handle(e.dataTransfer.files[0]);
        }}
      >
        {pct === null ? (
          <>
            <div className="text-5xl mb-4">🎬</div>
            <div className="text-lg font-bold">Кинь сюда исходный ролик</div>
            <div className="text-sm text-mut mt-2">
              mp4 / mov · до 300 МБ · идеально 4–15 секунд, обычно 9:16
            </div>
            <div className="text-xs text-dim mt-4">
              Дальше: референсы → анализ → два промта (стартовый кадр + Seedance)
            </div>
          </>
        ) : (
          <>
            <div className="mb-4 flex justify-center">
              <Spinner size={26} />
            </div>
            <div className="font-semibold">{pct < 100 ? `Загружаю… ${pct}%` : 'Обрабатываю…'}</div>
            <div className="mx-auto mt-4 h-1.5 w-64 rounded-full bg-panel2 overflow-hidden">
              <div className="h-full bg-lime transition-all" style={{ width: `${pct}%` }} />
            </div>
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="video/mp4,video/quicktime"
          className="hidden"
          onChange={(e) => void handle(e.target.files?.[0])}
        />
      </div>
      {err && (
        <div className="mt-4">
          <ErrorNote text={err} />
        </div>
      )}
    </div>
  );
}

// ── Ролик: мета + раскадровка ───────────────────────────────────────────────

function VideoSection({
  proj,
  reload,
  onNew,
}: {
  proj: ProjectFull;
  reload: () => void;
  onNew: () => void;
}) {
  const m = proj.meta;
  const storyboarding = proj.status === 'storyboarding';
  const longWarn = m && m.durationSec > 15.5;

  return (
    <Card>
      <SectionTitle
        step="1"
        title={proj.title}
        hint="исходник = мир + движение"
        right={
          <Button kind="ghost" onClick={onNew} className="!py-1 !px-2.5 text-xs">
            + Новый свап
          </Button>
        }
      />
      <div className="p-5 flex flex-col lg:flex-row gap-5">
        <div className="shrink-0">
          {proj.videoPurged || !proj.videoFile ? (
            <div className="w-40 aspect-[9/16] rounded-xl border border-line bg-panel2 flex items-center justify-center text-center text-xs text-dim p-3">
              видео очищено ротацией — кадры и промты на месте
            </div>
          ) : (
            <video
              src={api.mediaUrl(proj.id, 'src', proj.videoFile)}
              controls
              muted
              playsInline
              className="w-40 rounded-xl border border-line bg-black"
            />
          )}
        </div>
        <div className="flex-1 min-w-0">
          {m && (
            <div className="flex flex-wrap gap-2 mb-4">
              <Tag tone={longWarn ? 'warn' : 'mut'}>
                {m.durationSec.toFixed(1)} с{longWarn ? ' · Seedance кламп 4–15 с' : ''}
              </Tag>
              <Tag>
                {m.width}×{m.height} · {m.aspect}
              </Tag>
              <Tag>{m.fps} fps</Tag>
              <Tag>{(m.sizeBytes / 1024 ** 2).toFixed(1)} МБ</Tag>
            </div>
          )}
          {storyboarding && (
            <div className="flex items-center gap-3 text-sm text-mut py-6">
              <Spinner /> Раскадровка: ищу смены сцен, извлекаю ключевые кадры…
            </div>
          )}
          {proj.status === 'uploaded' && proj.error && (
            <ErrorNote
              text={proj.error}
              onRetry={() => void api.storyboardRetry(proj.id).then(reload)}
            />
          )}
          {proj.frames.length > 0 && <StoryboardStrip proj={proj} />}
        </div>
      </div>
    </Card>
  );
}

function StoryboardStrip({ proj }: { proj: ProjectFull }) {
  const scenes = proj.frames.filter((f) => f.kind === 'scene').length;
  return (
    <div>
      <div className="flex items-center gap-2 text-xs text-mut mb-2">
        <span className="font-semibold text-ink">Раскадровка</span>
        <span>{proj.frames.length} кадров</span>
        {scenes > 0 && <Tag tone="lime">{scenes} смен сцен</Tag>}
      </div>
      <div className="flex gap-2 overflow-x-auto sf-scroll pb-2">
        {proj.frames.map((f) => (
          <figure key={f.file} className="shrink-0 w-[72px]">
            <img
              src={api.mediaUrl(proj.id, 'frames', f.file)}
              loading="lazy"
              alt=""
              className={`w-[72px] aspect-[9/16] object-cover rounded-lg border ${
                f.kind === 'scene'
                  ? 'border-lime/70'
                  : f.kind === 'first'
                    ? 'border-ink/40'
                    : 'border-line'
              }`}
            />
            <figcaption className="text-center text-[10px] text-dim mt-1">
              {f.kind === 'first' ? 'старт' : f.kind === 'scene' ? `⚡ ${f.t.toFixed(1)}с` : `${f.t.toFixed(1)}с`}
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

// ── Референсы ───────────────────────────────────────────────────────────────

const ROLE_OPTIONS = Object.entries(REF_ROLES) as Array<[RefRole, { ru: string; en: string }]>;

function RefsSection({ proj, reload }: { proj: ProjectFull; reload: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showTips, setShowTips] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      reload();
    }
  };

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    // роли для батча считаем заранее, а не по несвежему proj.refs в цикле
    const have = {
      model: proj.refs.some((r) => r.role === 'model'),
      vehicle: proj.refs.some((r) => r.role === 'vehicle'),
    };
    const pickRole = (): RefRole => {
      if (!have.model) {
        have.model = true;
        return 'model';
      }
      if (!have.vehicle) {
        have.vehicle = true;
        return 'vehicle';
      }
      return 'object';
    };
    await run(async () => {
      for (const f of Array.from(files)) await api.addRef(proj.id, f, pickRole(), '');
    });
    setBusy(false);
  };

  const move = (ref: RefInfo, dir: -1 | 1) =>
    run(async () => {
      const order = [...proj.refs].sort((a, b) => a.idx - b.idx).map((r) => r.id);
      const i = order.indexOf(ref.id);
      const j = i + dir;
      if (j < 0 || j >= order.length) return;
      [order[i], order[j]] = [order[j]!, order[i]!];
      await api.patchRefs(proj.id, { order });
    });

  const update = (refId: string, patch: { role?: string; note?: string }) =>
    run(() => api.patchRefs(proj.id, { updates: [{ id: refId, ...patch }] }));

  return (
    <Card>
      <SectionTitle
        step="2"
        title="Референсы"
        hint="порядок = нумерация reference image (старт-кадр всегда №1)"
        right={
          <button
            type="button"
            className="text-xs text-mut hover:text-lime transition-colors"
            onClick={() => setShowTips((v) => !v)}
          >
            {showTips ? 'скрыть подсказки' : 'как снять хорошие рефы?'}
          </button>
        }
      />
      {showTips && (
        <div className="mx-5 mt-4 rounded-xl border border-line bg-panel2 p-4 text-xs text-mut space-y-1.5">
          <div>• <b className="text-ink">Модель:</b> чёткое фронтальное лицо при хорошем свете — обязательно; плюс фигура в полный рост в нужной одежде. 2–4 ракурса лочат identity сильнее.</div>
          <div>• <b className="text-ink">Транспорт:</b> чистый вид 3/4, чтобы читались силуэт и линии дизайна; профиль помогает цвету и наклейкам.</div>
          <div>• <b className="text-ink">Свет:</b> чем ближе свет/ракурс рефа к ролику, тем чище блендинг. Студийный реф в ночной клип — худший кейс.</div>
          <div>• Если одежда на фото не та, что нужна в кадре — напиши нужную в заметке к референсу.</div>
        </div>
      )}
      <div className="p-5 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {[...proj.refs]
          .sort((a, b) => a.idx - b.idx)
          .map((r, i, arr) => (
            <div key={r.id} className="rounded-xl border border-line bg-panel2 overflow-hidden group">
              <div className="relative">
                <img
                  src={api.mediaUrl(proj.id, 'refs', r.file)}
                  alt=""
                  className="w-full aspect-square object-cover"
                />
                <span className="absolute top-2 left-2 text-[11px] font-bold bg-black/70 text-lime rounded-md px-1.5 py-0.5">
                  ref {i + 2}
                </span>
                <div className="absolute top-1.5 right-1.5 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <MiniBtn onClick={() => void move(r, -1)} disabled={i === 0} label="←" />
                  <MiniBtn onClick={() => void move(r, 1)} disabled={i === arr.length - 1} label="→" />
                  <MiniBtn onClick={() => void run(() => api.deleteRef(proj.id, r.id))} label="✕" danger />
                </div>
              </div>
              <div className="p-2 space-y-1.5">
                <select
                  value={r.role}
                  onChange={(e) => void update(r.id, { role: e.target.value })}
                  className="w-full bg-panel border border-line rounded-md px-2 py-1 text-xs"
                >
                  {ROLE_OPTIONS.map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.ru}
                    </option>
                  ))}
                </select>
                <input
                  defaultValue={r.note}
                  placeholder="заметка (одежда, детали)…"
                  onBlur={(e) => {
                    if (e.target.value !== r.note) void update(r.id, { note: e.target.value });
                  }}
                  className="w-full bg-panel border border-line rounded-md px-2 py-1 text-xs placeholder:text-dim"
                />
              </div>
            </div>
          ))}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="rounded-xl border-2 border-dashed border-line2 hover:border-lime/50 min-h-40 flex flex-col items-center justify-center gap-2 text-mut hover:text-lime transition-colors aspect-square"
        >
          {busy ? <Spinner /> : <span className="text-2xl">+</span>}
          <span className="text-xs">добавить фото</span>
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          className="hidden"
          onChange={(e) => {
            void add(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {err && (
        <div className="px-5 pb-4">
          <ErrorNote text={err} />
        </div>
      )}
    </Card>
  );
}

function MiniBtn({
  onClick,
  label,
  disabled,
  danger,
}: {
  onClick: () => void;
  label: string;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`w-6 h-6 rounded-md text-[11px] font-bold bg-black/70 disabled:opacity-30 ${
        danger ? 'text-danger hover:bg-danger/30' : 'text-ink hover:bg-black'
      }`}
    >
      {label}
    </button>
  );
}
