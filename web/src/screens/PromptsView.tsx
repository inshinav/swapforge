import { useMemo, useState } from 'react';
import type { ProjectFull, PromptRow } from '@shared/api-types';
import { ARTIFACTS, ARTIFACT_TYPES, type ArtifactType } from '@shared/taxonomy';
import { api } from '../api';
import { Button, Card, CopyBlock, ErrorNote, SectionTitle, Spinner, Tag } from '../ui';
import { prefs } from './AnalysisView';

export function PromptsView({ proj, reload }: { proj: ProjectFull; reload: () => void }) {
  const versions = useMemo(
    () => [...new Set(proj.prompts.map((p) => p.version))].sort((a, b) => b - a),
    [proj.prompts],
  );
  const [selected, setSelected] = useState<number | null>(null);
  const version = selected ?? versions[0] ?? null;

  if (proj.prompts.length === 0 && proj.status !== 'generating') return null;

  const image = proj.prompts.find((p) => p.version === version && p.kind === 'image');
  const video = proj.prompts.find((p) => p.version === version && p.kind === 'video');
  const versionFeedback = proj.feedback.filter((f) => f.version === version);

  return (
    <Card glow>
      <SectionTitle
        step="4"
        title="Промты"
        hint="вставляй как есть: №1 в ChatGPT, №2 в WaveSpeed"
        right={
          versions.length > 1 && (
            <select
              value={version ?? undefined}
              onChange={(e) => setSelected(Number(e.target.value))}
              className="bg-panel2 border border-line rounded-lg px-2 py-1 text-xs"
            >
              {versions.map((v) => (
                <option key={v} value={v}>
                  версия {v}
                  {proj.feedback.some((f) => f.version === v && f.worked) ? ' ✓' : ''}
                </option>
              ))}
            </select>
          )
        }
      />
      <div className="p-5 space-y-4">
        {proj.status === 'generating' && (
          <div className="flex items-center gap-3 text-sm text-mut py-6 justify-center">
            <Spinner /> Куются промты: доктрина + анализ + твои референсы{versions.length > 0 ? ' + фидбек' : ''}…
          </div>
        )}

        {image && (
          <>
            <CopyBlock
              title="1 · Промт стартового кадра"
              badge={image.lang.toUpperCase()}
              text={image.text}
              mono={false}
            />
            {version !== null && <StartFramePanel proj={proj} version={version} reload={reload} />}
          </>
        )}
        {video && (
          <CopyBlock title="2 · Свап → Seedance 2.0 Video Edit (WaveSpeed)" badge="EN" text={video.text} />
        )}

        {video?.params && <ParamsBlock p={video} />}

        {version !== null && (
          <FeedbackPanel
            proj={proj}
            version={version}
            hasWorked={versionFeedback.some((f) => f.worked)}
            reload={reload}
          />
        )}

        {proj.feedback.length > 0 && (
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-dim mb-2">История фидбека</h3>
            <div className="space-y-1.5">
              {proj.feedback.map((f) => (
                <div key={f.id} className="flex flex-wrap items-center gap-2 text-xs rounded-lg bg-panel2 border border-line px-3 py-2">
                  <Tag tone={f.worked ? 'ok' : 'danger'}>{f.worked ? 'сработало' : 'артефакты'}</Tag>
                  <span className="text-dim">v{f.version}</span>
                  {f.artifacts.map((a) => (
                    <span key={a} className="text-mut">{ARTIFACTS[a]?.ru.split(' — ')[0] ?? a}</span>
                  ))}
                  {f.notes && <span className="text-mut italic">«{f.notes}»</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function StartFramePanel({
  proj,
  version,
  reload,
}: {
  proj: ProjectFull;
  version: number;
  reload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const frames = proj.startFrames.filter((f) => f.version === version);

  const generate = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.startFrame(proj.id, { version });
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-line bg-panel2 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-semibold">Стартовый кадр по API</span>
        <span className="text-xs text-dim">gpt-image-2 · high · с твоими рефами · это reference image 1</span>
        <div className="flex-1" />
        <Button kind={frames.length ? 'ghost' : 'primary'} onClick={() => void generate()} busy={busy}>
          {busy ? 'Генерирую… ~1–2 мин' : frames.length ? 'Ещё вариант' : '🖼 Сгенерировать кадр'}
        </Button>
      </div>
      {frames.length > 0 && (
        <div className="mt-3 flex gap-3 overflow-x-auto sf-scroll pb-1">
          {frames.map((f) => {
            const url = api.mediaUrl(proj.id, 'start', f.file);
            return (
              <figure key={f.file} className="shrink-0 w-36">
                <a href={url} target="_blank" rel="noreferrer">
                  <img
                    src={url}
                    alt=""
                    loading="lazy"
                    className="w-36 rounded-lg border border-lime/40 hover:border-lime transition-colors"
                  />
                </a>
                <figcaption className="mt-1 text-center">
                  <a href={url} download={f.file} className="text-[11px] text-mut hover:text-lime">
                    ⬇ скачать PNG
                  </a>
                </figcaption>
              </figure>
            );
          })}
        </div>
      )}
      {err && <div className="mt-3"><ErrorNote text={err} /></div>}
    </div>
  );
}

function ParamsBlock({ p }: { p: PromptRow }) {
  const params = p.params!;
  const notes = (params as unknown as { notes?: string }).notes;
  return (
    <div className="rounded-xl border border-line bg-panel2 p-4">
      <h3 className="text-xs font-bold uppercase tracking-wider text-dim mb-3">Параметры WaveSpeed</h3>
      <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <Param k="endpoint" v={params.endpoint} mono />
        <Param k="video" v={params.video} />
        <Param k="enable_web_search" v="false" mono />
        <Param k="длительность" v={params.durationNote} />
      </dl>
      <div className="mt-3 pt-3 border-t border-line">
        <div className="text-xs text-dim mb-1.5">reference_images — строго в этом порядке:</div>
        <ol className="space-y-1">
          {params.reference_images.map((r) => (
            <li key={r.index} className="text-sm flex items-baseline gap-2">
              <span className="font-mono text-lime text-xs shrink-0">{r.index}.</span>
              <span>{r.whatItIs}</span>
              <span className="text-dim text-xs font-mono truncate">{r.file}</span>
            </li>
          ))}
        </ol>
      </div>
      {notes && (
        <div className="mt-3 pt-3 border-t border-line text-xs text-mut whitespace-pre-wrap">{notes}</div>
      )}
    </div>
  );
}

function Param({ k, v, mono = false }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <dt className="text-xs text-dim shrink-0">{k}</dt>
      <dd className={`truncate ${mono ? 'font-mono text-[13px]' : ''}`}>{v}</dd>
    </div>
  );
}

function FeedbackPanel({
  proj,
  version,
  hasWorked,
  reload,
}: {
  proj: ProjectFull;
  version: number;
  hasWorked: boolean;
  reload: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<ArtifactType>>(new Set());
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const blocked = ['storyboarding', 'analyzing', 'generating'].includes(proj.status);

  const toggle = (a: ArtifactType) => {
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(a)) n.delete(a);
      else n.add(a);
      return n;
    });
  };

  const saveWorked = async () => {
    if (hasWorked) return; // уже отмечено — не плодим дубли
    setBusy(true);
    setErr(null);
    try {
      await api.feedback(proj.id, { version, worked: true, artifacts: [], notes: '' });
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (regenerate: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      if (regenerate) {
        await api.iterate(proj.id, {
          version,
          artifacts: [...picked],
          notes,
          lang: prefs.lang,
        });
      } else {
        await api.feedback(proj.id, { version, worked: false, artifacts: [...picked], notes });
      }
      setOpen(false);
      setPicked(new Set());
      setNotes('');
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-line bg-panel2 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-semibold">Прогнал в WaveSpeed?</span>
        <Button kind={hasWorked ? 'primary' : 'ghost'} onClick={() => void saveWorked()} busy={busy && !open} disabled={blocked}>
          ✓ Сработало
        </Button>
        <Button kind="ghost" onClick={() => setOpen((v) => !v)} disabled={blocked}>
          Вылезли артефакты…
        </Button>
        <span className="text-xs text-dim">фидбек учит библиотеку — следующие промты будут точнее</span>
      </div>

      {open && (
        <div className="mt-4 space-y-3 sf-in">
          <div className="grid sm:grid-cols-2 gap-2">
            {ARTIFACT_TYPES.map((a) => (
              <label
                key={a}
                className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                  picked.has(a) ? 'border-lime/50 bg-lime/5' : 'border-line hover:border-line2'
                }`}
              >
                <input
                  type="checkbox"
                  checked={picked.has(a)}
                  onChange={() => toggle(a)}
                  className="mt-0.5 accent-[#C6F24E]"
                />
                <span>
                  <span className="text-sm font-semibold block">{ARTIFACTS[a].ru.split(' — ')[0]}</span>
                  <span className="text-xs text-mut">{ARTIFACTS[a].hint}</span>
                </span>
              </label>
            ))}
          </div>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Заметки: что именно уехало, на какой секунде, что сохранить…"
            rows={2}
            className="w-full bg-panel border border-line rounded-lg px-3 py-2 text-sm placeholder:text-dim resize-y"
          />
          <div className="flex flex-wrap gap-2">
            <Button kind="primary" onClick={() => void submit(true)} busy={busy} disabled={blocked}>
              ⚡ Перегенерировать с таргет-фиксами
            </Button>
            <Button kind="ghost" onClick={() => void submit(false)} busy={busy}>
              Только сохранить фидбек
            </Button>
          </div>
        </div>
      )}
      {err && <div className="mt-3"><ErrorNote text={err} /></div>}
    </div>
  );
}
