// Результат свапа: плеер готового ролика, фактическая стоимость, 👍/👎 с таксономией
// артефактов (кормит few-shot) и история всех прогонов проекта.
import { useState } from 'react';
import type { GenerationRow, ProjectFull } from '@shared/api-types';
import { ARTIFACTS, ARTIFACT_TYPES, type ArtifactType } from '@shared/taxonomy';
import { api } from '../api';
import { Button, Card, ErrorNote, SectionTitle, Tag } from '../ui';
import { GEN_ACTIVE } from './SwapPanel';

const COST_SOURCE_RU: Record<string, string> = {
  api: 'из ответа WaveSpeed',
  balance_delta: 'по дельте баланса',
  formula: 'по формуле тарифа',
};

export function RenderPanel({ proj, reload }: { proj: ProjectFull; reload: () => void }) {
  const [rerunErr, setRerunErr] = useState<string | null>(null);
  const done = proj.generations.filter((g) => g.status === 'done');
  if (done.length === 0) return null;
  const latest = done[0]!;
  const anyActive = proj.generations.some((g) => GEN_ACTIVE.includes(g.status));
  const history = proj.generations.filter((g) => g.id !== latest.id);

  const rerun = () => {
    setRerunErr(null);
    void api
      .renderVersion(proj.id, { version: latest.version })
      .catch((e) => setRerunErr(e instanceof Error ? e.message : String(e)))
      .then(reload);
  };

  return (
    <Card glow>
      <SectionTitle
        step="4"
        title="Готовый ролик"
        hint="смотри, оценивай — 👍/👎 делает следующие свапы умнее"
        right={
          <Button
            kind="ghost"
            className="!py-1 !px-2.5 text-xs"
            disabled={anyActive || proj.videoPurged}
            onClick={rerun}
            title={proj.videoPurged ? 'исходник очищен ротацией' : 'ещё один рендер той же версии промтов'}
          >
            ↻ Прогнать ещё раз
          </Button>
        }
      />
      {rerunErr && (
        <div className="px-5 pt-3">
          <ErrorNote text={rerunErr} />
        </div>
      )}
      <div className="p-5 flex flex-col lg:flex-row gap-5">
        <div className="shrink-0">
          {latest.file ? (
            <video
              src={api.mediaUrl(proj.id, 'renders', latest.file)}
              controls
              playsInline
              className="w-56 rounded-xl border border-lime/40 bg-black"
            />
          ) : (
            <div className="w-56 aspect-[9/16] rounded-xl border border-line bg-panel2 flex items-center justify-center text-center text-xs text-dim p-3">
              файл счищен ротацией — параметры и оценка сохранены
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0 space-y-3">
          <GenMeta g={latest} />
          <RatingBlock proj={proj} g={latest} reload={reload} />
        </div>
      </div>

      {history.length > 0 && (
        <div className="px-5 pb-5">
          <h3 className="text-xs font-bold uppercase tracking-wider text-dim mb-2">
            История генераций
          </h3>
          <div className="space-y-1.5">
            {history.map((g) => (
              <HistoryRow key={g.id} proj={proj} g={g} reload={reload} />
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function fmtDate(s: string): string {
  return new Date(`${s.replace(' ', 'T')}Z`).toLocaleString('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function GenMeta({ g }: { g: GenerationRow }) {
  const p = (g.params ?? {}) as { generate_audio?: boolean };
  return (
    <div className="flex flex-wrap gap-2">
      <Tag>{p.generate_audio === false ? 'звук исходника' : 'нативный звук'}</Tag>
      <Tag>версия промтов {g.version}</Tag>
      {g.costActualUsd !== null ? (
        <Tag tone="ok">
          факт ${g.costActualUsd.toFixed(2)}
          {g.costSource ? ` · ${COST_SOURCE_RU[g.costSource] ?? g.costSource}` : ''}
        </Tag>
      ) : (
        g.costEst?.wavespeedUsd != null && <Tag tone="warn">смета ≈ ${g.costEst.wavespeedUsd.toFixed(2)}</Tag>
      )}
      {g.renderSec != null && g.renderSec > 0 && (
        <Tag>рендер {g.renderSec < 120 ? `${Math.round(g.renderSec)}с` : `${(g.renderSec / 60).toFixed(1)} мин`}</Tag>
      )}
      <Tag>{fmtDate(g.finishedAt ?? g.createdAt)}</Tag>
      {g.notes.includes('NSFW') && <Tag tone="warn">⚠ NSFW-флаг WaveSpeed</Tag>}
    </div>
  );
}

function RatingBlock({
  proj,
  g,
  reload,
}: {
  proj: ProjectFull;
  g: GenerationRow;
  reload: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<ArtifactType>>(new Set(g.artifacts));
  const [notes, setNotes] = useState(g.notes.startsWith('⚠') ? '' : g.notes);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggle = (a: ArtifactType) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(a)) n.delete(a);
      else n.add(a);
      return n;
    });

  const rate = async (rating: 1 | -1, artifacts: ArtifactType[], text: string, regenerate = false) => {
    setBusy(true);
    setErr(null);
    try {
      await api.genRate(g.id, { rating, artifacts, notes: text });
      if (regenerate) {
        await api.iterate(proj.id, { version: g.version, artifacts, notes: text, lang: 'en' });
      }
      setOpen(false);
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
        <span className="text-sm font-semibold">Как результат?</span>
        <Button
          kind={g.rating === 1 ? 'primary' : 'ghost'}
          busy={busy && !open}
          onClick={() => void rate(1, [], '')}
        >
          👍 Отлично
        </Button>
        <Button
          kind={g.rating === -1 ? 'danger' : 'ghost'}
          onClick={() => setOpen((v) => !v)}
        >
          👎 Есть артефакты…
        </Button>
        {g.rating === 1 && <span className="text-xs text-ok">учтено — пойдёт в few-shot</span>}
        {g.rating === -1 && <span className="text-xs text-danger">учтено</span>}
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
            placeholder="Заметки: что уехало, на какой секунде…"
            rows={2}
            className="w-full bg-panel border border-line rounded-lg px-3 py-2 text-sm placeholder:text-dim resize-y"
          />
          <div className="flex flex-wrap gap-2">
            <Button kind="primary" busy={busy} onClick={() => void rate(-1, [...picked], notes, true)}>
              ⚡ Перегенерировать с фиксами
            </Button>
            <Button kind="ghost" busy={busy} onClick={() => void rate(-1, [...picked], notes)}>
              Только сохранить оценку
            </Button>
          </div>
          <div className="text-xs text-dim">
            «Перегенерировать» = новая версия промтов с таргет-фиксами → свежий старт-кадр → новый рендер (спишется как обычный прогон)
          </div>
        </div>
      )}
      {err && <div className="mt-3"><ErrorNote text={err} /></div>}
    </div>
  );
}

function HistoryRow({
  proj,
  g,
  reload,
}: {
  proj: ProjectFull;
  g: GenerationRow;
  reload: () => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = (fn: () => Promise<unknown>) => {
    if (busy) return; // двойной клик по recheck = вторая цепочка поллинга
    setBusy(true);
    setErr(null);
    void fn()
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .then(() => {
        setBusy(false);
        reload();
      });
  };
  const statusRu: Record<string, string> = {
    uploading_assets: 'загрузка ассетов…',
    submitted: 'в очереди WaveSpeed…',
    rendering: 'рендер…',
    downloading: 'скачивание…',
    done: 'готов',
    failed: 'не удался',
  };
  return (
    <div className="rounded-lg bg-panel2 border border-line px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Tag tone={g.status === 'done' ? 'ok' : g.status === 'failed' ? 'danger' : 'lime'}>
          {statusRu[g.status] ?? g.status}
        </Tag>
        <span className="text-dim">v{g.version}</span>
        <span className="text-dim">{fmtDate(g.createdAt)}</span>
        {g.costActualUsd !== null && <span className="text-mut">${g.costActualUsd.toFixed(2)}</span>}
        {g.rating === 1 && <span>👍</span>}
        {g.rating === -1 && <span>👎</span>}
        {g.status === 'done' && g.file && (
          <a
            href={api.mediaUrl(proj.id, 'renders', g.file)}
            target="_blank"
            rel="noreferrer"
            className="text-lime hover:underline"
          >
            ▶ смотреть
          </a>
        )}
        {g.status === 'done' && g.renderPurged && <span className="text-dim">файл счищен ротацией</span>}
        {g.status === 'failed' && (
          <>
            <span className="text-danger truncate max-w-72" title={g.error ?? ''}>
              {g.error}
            </span>
            {g.wsPredictionId && (
              <button
                type="button"
                disabled={busy}
                className="text-lime hover:underline disabled:opacity-50"
                onClick={() => act(() => api.genRecheck(g.id))}
                title="бесплатно: если задача дорендерилась — скачаю без повторной оплаты"
              >
                проверить ещё раз
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              className={`${g.wsPredictionId ? 'text-mut hover:text-lime' : 'text-lime hover:underline'} disabled:opacity-50`}
              onClick={() => act(() => api.genRetry(g.id))}
            >
              повторить
            </button>
          </>
        )}
      </div>
      {err && <div className="mt-2 text-xs text-danger">{err}</div>}
    </div>
  );
}
