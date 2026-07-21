import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_PROJECT_REFS, type ProjectFull, type RefInfo } from '@shared/api-types';
import { REF_ROLES, type RefRole } from '@shared/taxonomy';
import { api, csrfToken } from '../api';
import { Button, Card, ErrorNote, SectionTitle, Spinner, Tag } from '../ui';
import { AnalysisView } from './AnalysisView';
import { PromptsView } from './PromptsView';
import { GEN_ACTIVE, SwapPanel } from './SwapPanel';
import { RenderPanel } from './RenderPanel';

const BUSY = ['storyboarding', 'analyzing', 'generating', 'startframing'];

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
  // рендер живёт в generations: поллим и его, но реже (стадия долгая, удалённая);
  // Reality Finish (локальная пост-обработка) тоже требует поллинга до финала
  const genActive =
    proj?.generations.some(
      (g) => GEN_ACTIVE.includes(g.status) || g.finish?.status === 'processing',
    ) ?? false;
  useEffect(() => {
    const local = !!status && BUSY.includes(status);
    if (!local && !genActive) return;
    const t = setInterval(() => void reload(), local ? 1500 : 4000);
    return () => clearInterval(t);
  }, [status, genActive, reload]);
  return { proj, err, reload };
}

function QuickPath() {
  return (
    <div className="rounded-xl border border-line bg-panel2 px-3 py-2.5 flex items-center justify-center gap-2 sm:gap-3 text-xs sm:text-sm font-semibold" aria-label="Три шага создания ролика">
      <span>1. Видео</span>
      <span className="text-dim" aria-hidden>→</span>
      <span>2. Пресет</span>
      <span className="text-dim" aria-hidden>→</span>
      <span className="text-lime">3. Создать</span>
    </div>
  );
}

/** XHR — ради прогресса загрузки больших роликов. */
function uploadVideo(file: File, onProgress: (pct: number) => void): Promise<{ id: string }> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('title', file.name.replace(/\.[^.]+$/, ''));
    fd.append('video', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', api.uploadUrl());
    xhr.setRequestHeader('x-sf-csrf', csrfToken());
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
  onOpenModels,
  onOpenBilling,
  owner,
  previewAsUser = false,
  guided = false,
}: {
  projectId: string | null;
  onProjectCreated: (id: string) => void;
  onOpenModels: () => void;
  onOpenBilling: (needed: number) => void;
  owner: boolean;
  previewAsUser?: boolean;
  guided?: boolean;
}) {
  const { proj, err, reload } = useProject(projectId);

  if (!projectId) {
    return (
      <div className="space-y-4">
        {!guided && <QuickPath />}
        <UploadZone onCreated={onProjectCreated} guided={guided} />
      </div>
    );
  }
  if (err?.includes('не найден')) {
    // проект удалили — забываем его и показываем загрузку
    return (
      <div className="space-y-4">
        <ErrorNote text="Этот проект удалён — начни новый ролик" />
        <UploadZone onCreated={onProjectCreated} guided={guided} />
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
    <ProjectView
      proj={proj}
      reload={reload}
      onProjectCreated={onProjectCreated}
      onOpenModels={onOpenModels}
      onOpenBilling={onOpenBilling}
      owner={owner}
      previewAsUser={previewAsUser}
    />
  );
}

function ProjectView({
  proj,
  reload,
  onProjectCreated,
  onOpenModels,
  onOpenBilling,
  owner,
  previewAsUser,
}: {
  proj: ProjectFull;
  reload: () => void;
  onProjectCreated: (id: string) => void;
  onOpenModels: () => void;
  onOpenBilling: (needed: number) => void;
  owner: boolean;
  previewAsUser: boolean;
}) {
  // Пресетный проект: рефы подложены кнопкой — секция референсов уезжает «под капот»,
  // главный сценарий остаётся бесшовным. «Свои референсы» раскрывает её обратно.
  const presetRefs = proj.refs.length > 0 && proj.refs.every((r) => r.roleSource === 'preset');
  const [custom, setCustom] = useState(false);
  const refsInMain = custom || (proj.refs.length > 0 && !presetRefs);

  return (
    <div className="space-y-5 sf-in">
      <VideoSection proj={proj} reload={reload} onNew={() => onProjectCreated('')} />
      {refsInMain && (
        <div id="project-references">
          <RefsSection proj={proj} reload={reload} />
        </div>
      )}
      <SwapPanel
        proj={proj}
        reload={reload}
        custom={refsInMain}
        onCustom={() => setCustom(true)}
        onOpenModels={onOpenModels}
        onOpenBilling={onOpenBilling}
        owner={owner}
        previewAsUser={previewAsUser}
      />
      <RenderPanel proj={proj} reload={reload} />
      {owner && <UnderTheHood proj={proj} reload={reload} showRefs={presetRefs && !custom} />}
    </div>
  );
}

/** Промежуточные артефакты и ручной v1-режим — не мешают главному сценарию, но всё доступно. */
function UnderTheHood({
  proj,
  reload,
  showRefs,
}: {
  proj: ProjectFull;
  reload: () => void;
  showRefs?: boolean;
}) {
  const [open, setOpen] = useState(() => localStorage.getItem('sf-hood') === '1');
  const toggle = () => {
    setOpen((v) => {
      localStorage.setItem('sf-hood', v ? '0' : '1');
      return !v;
    });
  };
  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        className="w-full flex items-center gap-2 text-xs text-dim hover:text-mut transition-colors py-2 select-none"
      >
        <span className={`transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
        <span className="font-semibold uppercase tracking-wider">Под капотом</span>
        <span className="flex-1 border-t border-line ml-2" />
      </button>
      {open && (
        <div className="space-y-5 mt-2 sf-in">
          {proj.flow === 'auto' && (
            <div className="text-xs text-warn rounded-lg border border-warn/30 bg-warn/5 px-3 py-2">
              проект в one-click режиме: после ручной генерации/итерации промтов авто-флоу сам
              докатится до рендера WaveSpeed — это платно (см. смету выше)
            </div>
          )}
          <AudioModeRow proj={proj} reload={reload} />
          {showRefs && <RefsSection proj={proj} reload={reload} />}
          <AnalysisView proj={proj} reload={reload} />
          <PromptsView proj={proj} reload={reload} />
        </div>
      )}
    </div>
  );
}

/** Звук результата: настройка «под капотом», третьей галочки на главном экране нет (решение Alex). */
function AudioModeRow({ proj, reload }: { proj: ProjectFull; reload: () => void }) {
  const [native, setNative] = useState(proj.flags?.generateAudio ?? true);
  const [saved, setSaved] = useState(false);
  const save = async (v: boolean) => {
    setNative(v);
    try {
      // сервер применит сохранённое значение при следующем свапе (тело запуска звук не шлёт)
      await api.swapAudioPref(proj.id, v);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      reload(); // освежаем proj.flags, чтобы весь UI видел актуальный выбор
    } catch {
      /* не критично — настройка сохранится при следующей попытке */
    }
  };
  return (
    <div className="rounded-xl border border-line bg-panel2 px-4 py-3 flex flex-wrap items-center gap-3 text-sm">
      <span className="font-semibold">Звук результата</span>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="radio"
          checked={native}
          onChange={() => void save(true)}
          className="accent-[#C6F24E]"
        />
        нативная генерация (движок/среда под новый визуал)
      </label>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="radio"
          checked={!native}
          onChange={() => void save(false)}
          className="accent-[#C6F24E]"
        />
        дорожка исходника как есть
      </label>
      {saved && <span className="text-xs text-ok">сохранено</span>}
    </div>
  );
}

// ── Загрузка ролика ─────────────────────────────────────────────────────────

const UPLOAD_LINES = [
  'ролик залетает на сервер…',
  'считаю байты…',
  'скоро раскадровка: ffmpeg разомнётся…',
  'ищу, где у ролика душа…',
];

function UploadZone({ onCreated, guided = false }: { onCreated: (id: string) => void; guided?: boolean }) {
  const [drag, setDrag] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lineIdx, setLineIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // живая строка под прогрессом — загрузка не должна ощущаться мёртвой паузой
  useEffect(() => {
    if (pct === null) return;
    const t = setInterval(() => setLineIdx((i) => (i + 1) % UPLOAD_LINES.length), 1600);
    return () => clearInterval(t);
  }, [pct]);

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
      {guided && (
        <div className="grid grid-cols-3 gap-2 mb-3 text-center text-[11px] text-mut">
          <div className="rounded-lg border border-line bg-panel2 px-2 py-2">1 герой</div>
          <div className="rounded-lg border border-line bg-panel2 px-2 py-2">хороший свет</div>
          <div className="rounded-lg border border-line bg-panel2 px-2 py-2">меньше склеек</div>
        </div>
      )}
      <div
        className={`rounded-2xl border-2 border-dashed px-4 py-14 text-center transition-colors select-none ${
          drag ? 'border-lime bg-lime/5' : 'border-line2 hover:border-lime/40'
        }`}
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
            <div className="text-lg font-bold">Загрузить видео</div>
            <div className="text-sm text-mut mt-2">MP4 / MOV · до 300 МБ · максимум 60 сек · рекомендуем до 15 сек</div>
            <Button kind="primary" className="mt-5" onClick={() => inputRef.current?.click()}>
              Выбрать видео
            </Button>
            <div className="text-xs text-dim mt-2">или перетащи файл сюда</div>
          </>
        ) : (
          <div role="status" aria-live="polite" aria-atomic="true">
            <div className="mb-4 flex justify-center">
              <Spinner size={26} />
            </div>
            <div className="font-semibold">{pct < 100 ? `Загружаю… ${pct}%` : 'Обрабатываю…'}</div>
            <div className="mx-auto mt-4 h-1.5 w-64 rounded-full bg-panel2 overflow-hidden">
              <div className="h-full bg-lime transition-all" style={{ width: `${pct}%` }} />
            </div>
            <div className="text-xs text-dim mt-3 sf-pulse">{UPLOAD_LINES[lineIdx]}</div>
          </div>
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
  const longWarn = m && m.durationSec > 15;

  return (
    <Card>
      <SectionTitle
        step="1"
        title={proj.title}
        right={
          <Button kind="ghost" onClick={onNew} className="!py-1 !px-2.5 text-xs">
            + Новый ролик
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
                {m.durationSec.toFixed(1)} с{longWarn ? ' · длинный ролик соберём автоматически' : ''}
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
    <details className="rounded-xl border border-line bg-panel2">
      <summary className="cursor-pointer list-none px-3 py-2 text-xs font-semibold">
        Кадры · {proj.frames.length}{scenes > 0 ? ` · сцен ${scenes}` : ''}
      </summary>
      <div className="flex gap-2 overflow-x-auto sf-scroll px-3 pb-3">
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
    </details>
  );
}

// ── Референсы ───────────────────────────────────────────────────────────────

const ROLE_OPTIONS = Object.entries(REF_ROLES) as Array<[RefRole, { ru: string; en: string }]>;

function RefsSection({ proj, reload }: { proj: ProjectFull; reload: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showTips, setShowTips] = useState(false);
  const [newRole, setNewRole] = useState<RefRole>('model');

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
    const available = MAX_PROJECT_REFS - proj.refs.length;
    if (available <= 0 || files.length > available) {
      setErr(
        `Можно добавить максимум ${MAX_PROJECT_REFS} фото. Удали лишнее или выбери не больше ${Math.max(0, available)}.`,
      );
      return;
    }
    setBusy(true);
    // роль определяет сервер: vision-классификатор, при сбое — позиционная эвристика
    await run(async () => {
      for (const f of Array.from(files)) await api.addRef(proj.id, f, newRole, '');
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
          <div className="flex items-center gap-3">
            <span className={proj.refs.length >= MAX_PROJECT_REFS ? 'text-xs text-warn' : 'text-xs text-dim'}>
              {proj.refs.length}/{MAX_PROJECT_REFS}
            </span>
            <button
              type="button"
              className="text-xs text-mut hover:text-lime transition-colors"
              onClick={() => setShowTips((v) => !v)}
            >
              {showTips ? 'скрыть подсказки' : 'как снять хорошие рефы?'}
            </button>
          </div>
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
      {proj.refs.length < MAX_PROJECT_REFS && (
        <div className="px-5 pt-4 flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor={`new-ref-role-${proj.id}`} className="text-mut">Что на новых фото?</label>
          <select
            id={`new-ref-role-${proj.id}`}
            value={newRole}
            onChange={(event) => setNewRole(event.target.value as RefRole)}
            className="min-h-10 rounded-lg border border-line2 bg-panel2 px-3 text-sm font-semibold"
          >
            <option value="model">Модель</option>
            <option value="vehicle">Транспорт</option>
            <option value="object">Важный объект</option>
          </select>
          <span className="text-xs text-dim">роль можно изменить после загрузки</span>
        </div>
      )}
      <div className="p-5 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
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
                {r.roleSource === 'auto' && (
                  <span
                    className="absolute bottom-2 left-2 text-[11px] bg-black/70 rounded-md px-1.5 py-0.5"
                    title={`роль определена автоматически${r.autoNote ? ` — ${r.autoNote}` : ''}`}
                  >
                    🤖
                  </span>
                )}
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
        {proj.refs.length < MAX_PROJECT_REFS && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="rounded-xl border-2 border-dashed border-line2 hover:border-lime/50 min-h-40 flex flex-col items-center justify-center gap-2 text-mut hover:text-lime transition-colors aspect-square"
          >
            {busy ? <Spinner /> : <span className="text-2xl">+</span>}
            <span className="text-xs">добавить фото</span>
          </button>
        )}
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
