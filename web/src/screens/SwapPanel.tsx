// Главная панель one-click: две галочки → смета из живых тарифов → одна кнопка.
// Чистый проект предлагает пресет-кнопки (фирменные реф-листы с сервера) или «свои референсы».
// После запуска — прогресс по стадиям с бегущей стоимостью и фактическими таймингами.
import { useCallback, useEffect, useState } from 'react';
import type { EstimateInfo, GenerationRow, PresetInfo, ProjectFull } from '@shared/api-types';
import { api } from '../api';
import { Button, Card, ErrorNote, SectionTitle, Spinner, Tag } from '../ui';

export const GEN_ACTIVE = ['uploading_assets', 'submitted', 'rendering', 'downloading'];
const LOCAL_BUSY = ['storyboarding', 'analyzing', 'generating', 'startframing'];

export function SwapPanel({
  proj,
  reload,
  custom,
  onCustom,
}: {
  proj: ProjectFull;
  reload: () => void;
  /** Режим «свои референсы»: секция рефов открыта в основном потоке. */
  custom: boolean;
  onCustom: () => void;
}) {
  const savedFlags = proj.flags;
  const [removeText, setRemoveText] = useState(savedFlags?.removeText ?? true);
  const [enhanceFigure, setEnhanceFigure] = useState(savedFlags?.enhanceFigure ?? false);
  const [confirmUnknown, setConfirmUnknown] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [launchErr, setLaunchErr] = useState<string | null>(null);
  const [est, setEst] = useState<EstimateInfo | null>(null);
  const [estErr, setEstErr] = useState<string | null>(null);
  const [presets, setPresets] = useState<PresetInfo[]>([]);

  useEffect(() => {
    api.presets().then(setPresets).catch(() => setPresets([]));
  }, []);

  const activeGen = proj.generations.find((g) => GEN_ACTIVE.includes(g.status)) ?? null;
  const localBusy = LOCAL_BUSY.includes(proj.status);
  const running = localBusy || !!activeGen;
  const failedGen =
    !running && proj.generations.length > 0 && proj.generations[0]!.status === 'failed'
      ? proj.generations[0]!
      : null;
  const hasModelRef = proj.refs.some((r) => r.role === 'model');

  const loadEstimate = useCallback(() => {
    setEstErr(null);
    api
      .estimate(proj.id)
      .then(setEst)
      .catch((e) => setEstErr(e instanceof Error ? e.message : String(e)));
  }, [proj.id]);

  useEffect(() => {
    if (!running) loadEstimate();
    // смета пересчитывается после каждого завершения стадий/рендера
  }, [proj.id, running, proj.generations.length, proj.promptVersions, loadEstimate]);

  const launch = async (preset?: string) => {
    setLaunching(true);
    setLaunchErr(null);
    try {
      // звук НЕ шлём: сервер берёт сохранённую настройку проекта — проп proj.flags
      // между поллингами может быть протухшим, а платный рендер должен уйти с актуальной
      await api.swap(proj.id, {
        flags: { removeText, enhanceFigure },
        confirmUnknownCost: confirmUnknown || undefined,
        preset,
      });
      reload();
    } catch (e) {
      setLaunchErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLaunching(false);
    }
  };

  const genAction = async (fn: () => Promise<unknown>) => {
    setLaunchErr(null);
    try {
      await fn();
    } catch (e) {
      setLaunchErr(e instanceof Error ? e.message : String(e));
    } finally {
      reload();
    }
  };

  return (
    <Card glow>
      <SectionTitle
        step="3"
        title="Свап в один клик"
        hint="анализ → промты → старт-кадр → рендер WaveSpeed — всё само"
      />
      <div className="p-5 space-y-4">
        {running ? (
          <ProgressStepper proj={proj} gen={activeGen} />
        ) : (
          <>
            {proj.flow === 'auto' && proj.error && (
              <ErrorNote text={proj.error} onRetry={() => void launch()} />
            )}
            {failedGen && (
              <div className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 space-y-2">
                <div className="flex items-start gap-2 text-sm">
                  <span className="text-danger shrink-0">⚠</span>
                  <span className="text-ink/90">Рендер не удался: {failedGen.error}</span>
                </div>
                {/* Если задача у WaveSpeed жива (есть prediction id) — главная кнопка
                    «Проверить ещё раз» (бесплатно), повтор = вторая оплата */}
                <div className="flex flex-wrap gap-2">
                  {failedGen.wsPredictionId && (
                    <Button
                      kind="primary"
                      className="!py-1.5 !px-3 text-xs"
                      onClick={() => void genAction(() => api.genRecheck(failedGen.id))}
                      title="Одиночная проверка у WaveSpeed: если задача успела дорендериться — скачаю без повторной оплаты"
                    >
                      Проверить ещё раз
                    </Button>
                  )}
                  <Button
                    kind={failedGen.wsPredictionId ? 'ghost' : 'primary'}
                    className="!py-1.5 !px-3 text-xs"
                    onClick={() => void genAction(() => api.genRetry(failedGen.id))}
                    title={
                      failedGen.wsPredictionId
                        ? 'Новый сабмит той же версии. Если прежняя задача ещё жива — сервер откажет, чтобы не списать дважды'
                        : undefined
                    }
                  >
                    ↻ Повторить рендер
                  </Button>
                </div>
              </div>
            )}

            <div className="grid sm:grid-cols-2 gap-2">
              <FlagBox
                checked={removeText}
                onChange={setRemoveText}
                title="Убрать текст с видео"
                hint="снять капшены/стикеры/вотермарки и чисто восстановить фон за ними"
              />
              <FlagBox
                checked={enhanceFigure}
                onChange={setEnhanceFigure}
                title="Усилить фигуру"
                hint="шире бёдра, выпуклее ягодицы, уже талия, больше грудь — лицо не трогаем"
              />
            </div>

            <EstimateLine est={est} err={estErr} onRefresh={loadEstimate} />
            {est?.wavespeed.usd === null && (
              <label className="flex items-center gap-2 text-xs text-warn cursor-pointer">
                <input
                  type="checkbox"
                  checked={confirmUnknown}
                  onChange={(e) => setConfirmUnknown(e.target.checked)}
                  className="accent-[#f2c94c]"
                />
                оценка WaveSpeed недоступна — всё равно запустить
              </label>
            )}

            {proj.refs.length === 0 && !custom ? (
              /* Чистый проект: пресеты одним нажатием или свои референсы */
              <div className="space-y-2">
                <div className="text-sm font-semibold">Кто в кадре?</div>
                <div className="grid sm:grid-cols-3 gap-2">
                  {presets.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      disabled={launching || proj.videoPurged}
                      onClick={() => void launch(p.id)}
                      className="group text-left rounded-xl border border-line hover:border-lime/60 bg-panel2 overflow-hidden transition-colors disabled:opacity-50"
                      title={`${p.hint} — запустит весь свап сразу`}
                    >
                      <img
                        src={api.presetThumbUrl(p.thumb)}
                        alt={p.title}
                        className="w-full h-24 object-cover object-top opacity-90 group-hover:opacity-100"
                      />
                      <div className="px-3 py-2">
                        <div className="text-sm font-semibold">⚡ {p.title}</div>
                        <div className="text-xs text-dim">жми — свап поедет сразу</div>
                      </div>
                    </button>
                  ))}
                  <button
                    type="button"
                    disabled={launching}
                    onClick={onCustom}
                    className="text-left rounded-xl border border-dashed border-line2 hover:border-lime/40 bg-panel2/50 px-3 py-2 transition-colors flex flex-col justify-center min-h-24"
                  >
                    <div className="text-sm font-semibold">📎 Свои референсы</div>
                    <div className="text-xs text-dim">загрузить фото модели и техники вручную</div>
                  </button>
                </div>
                {launching && (
                  <div className="flex items-center gap-2 text-sm text-mut">
                    <Spinner size={14} /> подкладываю референсы и запускаю…
                  </div>
                )}
                {proj.videoPurged && (
                  <span className="text-xs text-danger">исходник очищен ротацией — залей ролик заново</span>
                )}
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  kind="primary"
                  busy={launching}
                  disabled={!hasModelRef || proj.videoPurged}
                  onClick={() => void launch()}
                  className="!px-6 !py-3 text-base"
                  title={
                    !hasModelRef
                      ? 'Добавь референс с ролью «модель»'
                      : proj.videoPurged
                        ? 'Исходник очищен ротацией'
                        : undefined
                  }
                >
                  ⚡ Сделать свап
                </Button>
                {!hasModelRef && (
                  <span className="text-xs text-warn">нужен реф с ролью «модель» (блок выше)</span>
                )}
                {proj.videoPurged && (
                  <span className="text-xs text-danger">исходник очищен ротацией — залей ролик заново</span>
                )}
              </div>
            )}
            {launchErr && <ErrorNote text={launchErr} />}
          </>
        )}
      </div>
    </Card>
  );
}

function FlagBox({
  checked,
  onChange,
  title,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  hint: string;
}) {
  return (
    <label
      className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
        checked ? 'border-lime/50 bg-lime/5' : 'border-line hover:border-line2'
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-[#C6F24E]"
      />
      <span>
        <span className="text-sm font-semibold block">{title}</span>
        <span className="text-xs text-mut">{hint}</span>
      </span>
    </label>
  );
}

function fmtUsd(v: number | null | undefined): string {
  return v === null || v === undefined ? '?' : `$${v.toFixed(2)}`;
}

function EstimateLine({
  est,
  err,
  onRefresh,
}: {
  est: EstimateInfo | null;
  err: string | null;
  onRefresh: () => void;
}) {
  if (err) return <ErrorNote text={`Смета недоступна: ${err}`} onRetry={onRefresh} />;
  if (!est)
    return (
      <div className="flex items-center gap-2 text-sm text-mut">
        <Spinner size={14} /> считаю смету по живым тарифам…
      </div>
    );
  const ws = est.wavespeed;
  return (
    <div className="rounded-xl border border-line bg-panel2 px-4 py-3 text-sm space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-bold text-base">
          ≈ {fmtUsd(est.totalUsd)}
          {est.approximate ? ' (примерно)' : ''}
        </span>
        <span className="text-mut">
          WaveSpeed {fmtUsd(ws.usd)} ({ws.billedSeconds} бил. сек)
        </span>
        <span className="text-mut">OpenAI ≈ {fmtUsd(est.openai.usd)}</span>
        <span className={est.balanceUsd !== null && ws.usd !== null && ws.usd > est.balanceUsd - 0.05 ? 'text-danger font-semibold' : 'text-mut'}>
          баланс {fmtUsd(est.balanceUsd)}
        </span>
        {est.openai.priceDate && (
          <span className="text-dim text-xs">тарифы от {est.openai.priceDate.slice(0, 10)}</span>
        )}
        <button type="button" onClick={onRefresh} className="text-xs text-dim hover:text-lime ml-auto">
          ↻ обновить
        </button>
      </div>
      {est.warnings.length > 0 && (
        <ul className="text-xs text-warn space-y-0.5">
          {est.warnings.map((w) => (
            <li key={w}>• {w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Прогресс по стадиям ─────────────────────────────────────────────────────

interface Step {
  key: string;
  label: string;
  state: 'done' | 'active' | 'todo';
  hint?: string;
  /** Фактическое время завершённой стадии — «сколько заняло», очень коротко. */
  time?: string;
}

function fmtSec(s: number | null | undefined): string | undefined {
  if (s === null || s === undefined || s <= 0) return undefined;
  return s < 120 ? `${Math.round(s)}с` : `${(s / 60).toFixed(1)} мин`;
}

function deriveSteps(proj: ProjectFull, gen: GenerationRow | null): Step[] {
  const s = proj.status;
  const genS = gen?.status ?? null;
  const t = proj.stageTimes ?? {};
  const framesDone = proj.frames.length > 0;
  const analysisDone = !!proj.analysis;
  const promptsDone = proj.promptVersions > 0;
  const startframeDone = proj.startFrames.some((f) => f.version === proj.promptVersions);
  const mark = (done: boolean, active: boolean, hint?: string, sec?: number | null): Omit<Step, 'key' | 'label'> => ({
    state: active ? 'active' : done ? 'done' : 'todo',
    hint: active ? hint : undefined,
    time: !active && done ? fmtSec(sec) : undefined,
  });
  return [
    { key: 'storyboard', label: 'Раскадровка', ...mark(framesDone, s === 'storyboarding', 'ffmpeg ищет смены сцен · ~10–30 с', t.storyboard) },
    { key: 'analyze', label: 'Анализ', ...mark(analysisDone, s === 'analyzing', 'vision смотрит кадры и строит карту рисков · ~30–90 с', t.analyze) },
    { key: 'generate', label: 'Промты', ...mark(promptsDone, s === 'generating', 'доктрина куёт пару промтов · ~15–50 с', t.generate) },
    { key: 'startframe', label: 'Стартовый кадр', ...mark(startframeDone, s === 'startframing', 'gpt-image-2 · high · ~1–2 мин', t.startframe) },
    { key: 'upload', label: 'Загрузка в WaveSpeed', ...mark(!!genS && genS !== 'uploading_assets', genS === 'uploading_assets', 'ролик + кадр + рефы улетают на WaveSpeed', gen?.uploadSec) },
    { key: 'render', label: 'Рендер Seedance', ...mark(genS === 'downloading' || genS === 'done', genS === 'submitted' || genS === 'rendering', 'обычно 2–10 мин — можно уйти со страницы', gen?.renderSec) },
    { key: 'download', label: 'Скачивание', ...mark(genS === 'done', genS === 'downloading', 'забираю готовый ролик в библиотеку') },
  ];
}

function ProgressStepper({ proj, gen }: { proj: ProjectFull; gen: GenerationRow | null }) {
  const steps = deriveSteps(proj, gen);
  const run = proj.costs.activeRun;
  return (
    <div>
      <ol className="space-y-1.5">
        {steps.map((st) => (
          <li key={st.key} className="flex items-start gap-3">
            <span className="w-5 flex justify-center shrink-0 mt-0.5">
              {st.state === 'done' ? (
                <span className="text-lime text-sm">✓</span>
              ) : st.state === 'active' ? (
                <Spinner size={14} />
              ) : (
                <span className="w-1.5 h-1.5 rounded-full bg-line2 mt-1.5" />
              )}
            </span>
            <div className="min-w-0">
              <span
                className={`text-sm ${
                  st.state === 'active' ? 'font-semibold' : st.state === 'done' ? 'text-mut' : 'text-dim'
                }`}
              >
                {st.label}
                {st.time && <span className="text-xs text-dim"> · {st.time}</span>}
              </span>
              {st.hint && <span className="text-xs text-dim block">{st.hint}</span>}
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-4 pt-3 border-t border-line flex flex-wrap items-center gap-3 text-xs">
        <Tag tone="lime">идёт свап</Tag>
        {run && (
          <span className="text-mut">
            потрачено: OpenAI ${run.openaiUsd.toFixed(3)}
            {run.wavespeedActualUsd !== null
              ? ` · WaveSpeed $${run.wavespeedActualUsd.toFixed(2)}`
              : run.wavespeedEstUsd !== null
                ? ` · WaveSpeed ≈$${run.wavespeedEstUsd.toFixed(2)} (по завершении — факт)`
                : ''}
          </span>
        )}
        <span className="text-dim ml-auto">страницу можно закрыть — свап продолжится на сервере</span>
      </div>
    </div>
  );
}
