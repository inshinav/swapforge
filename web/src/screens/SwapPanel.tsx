// Главная панель one-click: две галочки → смета из живых тарифов → одна кнопка.
// Чистый проект предлагает кнопки МОДЕЛЕЙ пользователя (из конструктора) или «свои референсы».
// После запуска — прогресс по стадиям с бегущей стоимостью и фактическими таймингами.
import { useCallback, useEffect, useState } from 'react';
import type {
  EstimateForUser,
  EstimateInfo,
  GenerationRow,
  ModelInfo,
  ProjectFull,
} from '@shared/api-types';
import type { ReferenceAudit } from '@shared/analysis';
import { ApiError, api } from '../api';
import { Button, Card, ErrorNote, SectionTitle, Spinner, Tag } from '../ui';

type AnyEstimate = EstimateInfo | EstimateForUser;
const isBalanceEst = (e: AnyEstimate): e is EstimateForUser => 'kind' in e && e.kind === 'balance';

/** Кнопка «Кто в кадре?» = вариант модели; собирается из ModelInfo на клиенте. */
interface VariantButton {
  variantId: string;
  label: string;
  hint: string;
  thumb: string | null;
}

function variantButtons(models: ModelInfo[]): VariantButton[] {
  const out: VariantButton[] = [];
  for (const m of models) {
    for (const v of m.variants) {
      const sheet =
        m.refs.find((r) => r.variantId === v.id && r.role === 'model') ??
        m.refs.find((r) => r.variantId === null && r.role === 'model');
      if (!sheet) continue;
      out.push({
        variantId: v.id,
        label: m.variants.length > 1 ? `${m.name} · ${v.title}` : m.name,
        hint: v.hint || `${m.name}: ролик запустится сразу`,
        thumb: sheet ? api.modelFileUrl(m.id, sheet.file) : null,
      });
    }
  }
  return out;
}

export const GEN_ACTIVE = ['queued', 'uploading_assets', 'submitted', 'rendering', 'downloading'];
const LOCAL_BUSY = ['storyboarding', 'analyzing', 'generating', 'startframing'];

export function SwapPanel({
  proj,
  reload,
  custom,
  onCustom,
  onOpenModels,
  onOpenBilling,
  owner,
}: {
  proj: ProjectFull;
  reload: () => void;
  /** Режим «свои референсы»: секция рефов открыта в основном потоке. */
  custom: boolean;
  onCustom: () => void;
  /** Переход в конструктор пресетов (пустой стейт кнопок). */
  onOpenModels: () => void;
  /** Прямой переход из нехватки денег к пополнению баланса. */
  onOpenBilling: (needed: number) => void;
  /** Владелец видит технические стадии и себестоимость; пользователь — только простой путь и финальную цену. */
  owner: boolean;
}) {
  const savedFlags = proj.flags;
  const [removeText, setRemoveText] = useState(savedFlags?.removeText ?? true);
  const [enhanceFigure, setEnhanceFigure] = useState(savedFlags?.enhanceFigure ?? false);
  const [wish, setWish] = useState(savedFlags?.wish ?? '');
  const [confirmUnknown, setConfirmUnknown] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [launchErr, setLaunchErr] = useState<string | null>(null);
  const [launchShortfall, setLaunchShortfall] = useState<number | null>(null);
  const [est, setEst] = useState<AnyEstimate | null>(null);
  const [estErr, setEstErr] = useState<string | null>(null);
  const [buttons, setButtons] = useState<VariantButton[] | null>(null); // null = грузятся

  useEffect(() => {
    api
      .models()
      .then((ms) => setButtons(variantButtons(ms)))
      .catch(() => setButtons([]));
  }, []);

  const activeGen = proj.generations.find((g) => GEN_ACTIVE.includes(g.status)) ?? null;
  const localBusy = LOCAL_BUSY.includes(proj.status);
  const running = localBusy || !!activeGen;
  const failedGen =
    !running && proj.generations.length > 0 && proj.generations[0]!.status === 'failed'
      ? proj.generations[0]!
      : null;
  const hasModelRef = proj.refs.some((r) => r.role === 'model');
  const audit = proj.analysis?.referenceAudit;
  const auditBlocked = !!audit && (audit.verdict === 'blocked' || audit.issues.some((i) => i.severity === 'blocker'));
  const auditReview = !!audit && audit.verdict === 'review' && !audit.accepted && !auditBlocked;
  const auditNeedsDecision = auditBlocked || auditReview;

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

  const launch = async (variantId?: string, confirmReferenceRisks = false) => {
    setLaunching(true);
    setLaunchErr(null);
    setLaunchShortfall(null);
    try {
      // звук НЕ шлём: сервер берёт сохранённую настройку проекта — проп proj.flags
      // между поллингами может быть протухшим, а платный рендер должен уйти с актуальной
      await api.swap(proj.id, {
        flags: { removeText, enhanceFigure },
        wish: wish.trim() || undefined,
        confirmUnknownCost: confirmUnknown || undefined,
        confirmReferenceRisks: confirmReferenceRisks || undefined,
        variantId,
      });
      reload();
    } catch (e) {
      setLaunchErr(e instanceof Error ? e.message : String(e));
      if (e instanceof ApiError && e.status === 402 && est && isBalanceEst(est) && est.priceUsd !== null) {
        setLaunchShortfall(Math.max(0.01, est.priceUsd - est.balanceUsd));
      }
    } finally {
      setLaunching(false);
    }
  };

  const revealReferences = () => {
    onCustom();
    window.setTimeout(() => {
      document.getElementById('project-references')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 0);
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
        step="2"
        title="Выбери пресет"
      />
      <div className="p-5 space-y-4">
        {running ? (
          <ProgressStepper proj={proj} gen={activeGen} detailed={owner} />
        ) : (
          <>
            {proj.flow === 'auto' && proj.error && !auditNeedsDecision && (
              <ErrorNote text={proj.error} onRetry={() => void launch()} />
            )}
            {audit && (
              <ReferenceAuditCard
                audit={audit}
                busy={launching}
                onAddReferences={revealReferences}
                onOpenModels={onOpenModels}
                onContinue={auditReview ? () => void launch(undefined, true) : undefined}
              />
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

            <EstimateLine
              est={est}
              err={estErr}
              onRefresh={loadEstimate}
              onOpenBilling={onOpenBilling}
            />
            {!auditNeedsDecision && est && !isBalanceEst(est) && est.wavespeed.usd === null && (
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
              /* Чистый проект: кнопки моделей пользователя или свои референсы */
              <div className="space-y-2">
                <div>
                  <div className="text-sm font-semibold">Нажми на нужный пресет</div>
                  <div className="text-xs text-mut mt-0.5">Сначала сверим его с каждой сценой. Если всё подходит — ролик запустится сам.</div>
                </div>
                {buttons === null ? (
                  <div className="flex items-center gap-2 text-sm text-mut">
                    <Spinner size={14} /> загружаю твои модели…
                  </div>
                ) : (
                  <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
                    {buttons.map((b) => (
                      <button
                        key={b.variantId}
                        type="button"
                        disabled={launching || proj.videoPurged}
                        onClick={() => void launch(b.variantId)}
                        className="group text-left rounded-xl border border-line hover:border-lime/60 bg-panel2 overflow-hidden transition-colors disabled:opacity-50"
                        title={`${b.hint} — запустит создание ролика сразу`}
                      >
                        {b.thumb ? (
                          <img
                            src={b.thumb}
                            alt={b.label}
                            className="w-full h-24 object-cover object-top opacity-90 group-hover:opacity-100"
                          />
                        ) : (
                          <div className="w-full h-24 bg-panel flex items-center justify-center text-2xl">👤</div>
                        )}
                        <div className="px-3 py-2 flex items-center gap-2">
                          <div className="text-sm font-semibold truncate">{b.label}</div>
                          <span className="ml-auto text-[11px] font-bold text-lime">Проверить</span>
                        </div>
                      </button>
                    ))}
                    {buttons.length === 0 && (
                      <button
                        type="button"
                        onClick={onOpenModels}
                        className="text-left rounded-xl border border-lime/40 hover:border-lime/70 bg-lime/5 px-3 py-3 transition-colors min-h-12"
                      >
                        <div className="text-sm font-semibold">Создать модель</div>
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={launching}
                      onClick={onCustom}
                      className="text-left rounded-xl border border-dashed border-line2 hover:border-lime/40 bg-panel2/50 px-3 py-3 transition-colors min-h-12"
                    >
                      <div className="text-sm font-semibold">Свои референсы</div>
                    </button>
                  </div>
                )}
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
                  disabled={!hasModelRef || proj.videoPurged || auditNeedsDecision}
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
                  {auditNeedsDecision ? 'Сначала исправь риски выше' : '⚡ Проверить и создать'}
                </Button>
                {!hasModelRef && (
                  <span className="text-xs text-warn">нужен реф с ролью «модель» (блок выше)</span>
                )}
                {proj.videoPurged && (
                  <span className="text-xs text-danger">исходник очищен ротацией — залей ролик заново</span>
                )}
              </div>
            )}
            <details className="rounded-xl border border-line bg-panel2">
              <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold">Настройки <span className="text-xs text-dim font-normal">необязательно</span></summary>
              <div className="border-t border-line p-3 space-y-3">
                <div className="grid sm:grid-cols-2 gap-2">
                  <FlagBox checked={removeText} onChange={setRemoveText} title="Убрать текст" hint="капшены и стикеры" />
                  <FlagBox checked={enhanceFigure} onChange={setEnhanceFigure} title="Усилить фигуру" hint="лицо не меняется" />
                </div>
                <textarea
                  value={wish}
                  onChange={(e) => setWish(e.target.value.slice(0, 500))}
                  rows={2}
                  placeholder="Пожелание к ролику (необязательно)"
                  className="w-full rounded-lg bg-panel border border-line text-sm px-3 py-2 outline-none focus:border-lime/50 resize-y sf-scroll"
                />
              </div>
            </details>
            {launchErr && (
              <div className="space-y-2">
                <ErrorNote text={launchErr} />
                {launchShortfall && (
                  <Button kind="primary" onClick={() => onOpenBilling(launchShortfall)}>
                    Пополнить на ${launchShortfall.toFixed(2)}
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

const AUDIT_ROLE: Record<ReferenceAudit['issues'][number]['role'], string> = {
  model: 'модель',
  vehicle: 'транспорт',
  object: 'объект',
  source_video: 'исходное видео',
};

function ReferenceAuditCard({
  audit,
  busy,
  onAddReferences,
  onOpenModels,
  onContinue,
}: {
  audit: ReferenceAudit;
  busy: boolean;
  onAddReferences: () => void;
  onOpenModels: () => void;
  onContinue?: () => void;
}) {
  const blocked = audit.verdict === 'blocked' || audit.issues.some((i) => i.severity === 'blocker');
  const needsDecision = blocked || (audit.verdict === 'review' && !audit.accepted);

  if (!needsDecision) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-ok/25 bg-ok/5 px-3 py-2 text-xs">
        <span className="text-ok">✓</span>
        <span className="font-semibold">Референсы подходят к сценам</span>
        <span className="text-dim hidden sm:inline">Проверены ракурсы, видимость и контакты.</span>
      </div>
    );
  }

  return (
    <section className={`rounded-xl border p-3 sm:p-4 space-y-3 ${blocked ? 'border-danger/35 bg-danger/5' : 'border-warn/35 bg-warn/5'}`}>
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 text-lg ${blocked ? 'text-danger' : 'text-warn'}`}>{blocked ? '⚠' : '!'}</span>
        <div className="min-w-0">
          <div className="font-bold">{blocked ? 'Нужно исправить референсы' : 'Есть риск артефактов'}</div>
          <p className="text-xs text-mut mt-1">{audit.summary}</p>
          <p className="text-xs text-dim mt-1">Рендер не запускался. За него списания нет; учтена только уже выполненная проверка.</p>
        </div>
      </div>

      <div className="space-y-2">
        {audit.issues.map((issue, index) => (
          <article key={`${issue.title}-${index}`} className="rounded-lg border border-line bg-panel2 px-3 py-2.5 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <Tag tone={issue.severity === 'blocker' ? 'danger' : 'warn'}>
                {issue.severity === 'blocker' ? 'обязательно' : 'риск'}
              </Tag>
              <span className="font-semibold text-sm">{issue.title}</span>
              <span className="text-dim ml-auto">
                {issue.sceneIndex > 0 ? `сцена ${issue.sceneIndex} · ` : ''}{issue.moment} · {AUDIT_ROLE[issue.role]}
              </span>
            </div>
            <p className="mt-2 text-mut"><span className="text-dim">Видно сейчас:</span> {issue.evidence}</p>
            <p className="mt-1 text-warn"><span className="font-semibold">Если оставить:</span> {issue.risk}</p>
            <div className="mt-2 rounded-lg border border-lime/20 bg-lime/5 px-2.5 py-2 text-ink/90">
              <span className="font-semibold text-lime">Что сделать:</span> {issue.action}
              {issue.requiredShots.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {issue.requiredShots.map((shot) => <span key={shot} className="rounded-md bg-panel border border-line px-2 py-1">{shot}</span>)}
                </div>
              )}
            </div>
          </article>
        ))}
      </div>

      {audit.checks.some((check) => check.missing.length > 0 || check.qualityNotes.length > 0) && (
        <details className="rounded-lg border border-line bg-panel2">
          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold">Что проверено по фото</summary>
          <div className="border-t border-line px-3 py-2 space-y-2 text-xs">
            {audit.checks.map((check, index) => (
              <div key={`${check.role}-${index}`}>
                <div className="font-semibold">{check.subject}</div>
                {check.covered.length > 0 && <div className="text-ok mt-0.5">Есть: {check.covered.join(' · ')}</div>}
                {check.missing.length > 0 && <div className="text-warn mt-0.5">Не хватает: {check.missing.join(' · ')}</div>}
                {check.qualityNotes.length > 0 && <div className="text-mut mt-0.5">{check.qualityNotes.join(' · ')}</div>}
              </div>
            ))}
          </div>
        </details>
      )}

      <div className="flex flex-col sm:flex-row gap-2">
        <Button kind="primary" className="w-full sm:w-auto" onClick={onAddReferences}>
          Добавить нужные фото
        </Button>
        <Button kind="ghost" className="w-full sm:w-auto" onClick={onOpenModels}>
          Обновить пресет на будущее
        </Button>
        {!blocked && onContinue && (
          <Button kind="ghost" busy={busy} className="w-full sm:w-auto sm:ml-auto" onClick={onContinue}>
            Продолжить с риском
          </Button>
        )}
      </div>
    </section>
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
  onOpenBilling,
}: {
  est: AnyEstimate | null;
  err: string | null;
  onRefresh: () => void;
  onOpenBilling: (needed: number) => void;
}) {
  if (err) return <ErrorNote text={`Смета недоступна: ${err}`} onRetry={onRefresh} />;
  if (!est)
    return (
      <div className="flex items-center gap-2 text-sm text-mut">
        <Spinner size={14} /> считаю смету по живым тарифам…
      </div>
    );
  if (isBalanceEst(est)) {
    const short = est.priceUsd !== null && est.priceUsd > est.balanceUsd;
    const shortfall = est.priceUsd !== null ? Math.max(0, est.priceUsd - est.balanceUsd) : 0;
    return (
      <div className="rounded-xl border border-line bg-panel2 px-4 py-3 text-sm space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-bold text-base">
            {est.priceUsd !== null ? `Итого ≈ $${est.priceUsd.toFixed(2)}` : 'Цена недоступна'}
          </span>
          <span className={short ? 'text-danger font-semibold' : 'text-mut'}>
            баланс ${est.balanceUsd.toFixed(2)}
          </span>
          <button type="button" onClick={onRefresh} className="text-xs text-dim hover:text-lime ml-auto">
            Обновить
          </button>
        </div>
        {est.warnings.length > 0 && (
          <ul className="text-xs text-warn space-y-0.5">
            {est.warnings.map((w) => (
              <li key={w}>• {w}</li>
            ))}
          </ul>
        )}
        {short && shortfall > 0 && (
          <Button kind="primary" className="w-full sm:w-auto" onClick={() => onOpenBilling(shortfall)}>
            Пополнить на ${shortfall.toFixed(2)}
          </Button>
        )}
      </div>
    );
  }
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
    { key: 'analyze', label: 'Проверка сцен и референсов', ...mark(analysisDone, s === 'analyzing', 'сверяем нужные ракурсы, контакты и риск артефактов · ~30–90 с', t.analyze) },
    { key: 'generate', label: 'Промты', ...mark(promptsDone, s === 'generating', 'доктрина куёт пару промтов · ~15–50 с', t.generate) },
    { key: 'startframe', label: 'Стартовый кадр', ...mark(startframeDone, s === 'startframing', 'gpt-image-2 · high · ~1–2 мин', t.startframe) },
    ...(genS === 'queued'
      ? [
          {
            key: 'queue',
            label: 'Очередь рендера',
            state: 'active' as const,
            hint: `в очереди: ${gen?.queuePosition ?? '?'}-й — рендер начнётся автоматически`,
          },
        ]
      : []),
    { key: 'upload', label: 'Загрузка в WaveSpeed', ...mark(!!genS && genS !== 'uploading_assets' && genS !== 'queued', genS === 'uploading_assets', 'ролик + кадр + рефы улетают на WaveSpeed', gen?.uploadSec) },
    {
      key: 'render',
      label: 'Рендер Seedance',
      ...mark(
        genS === 'downloading' || genS === 'done',
        genS === 'submitted' || genS === 'rendering',
        (gen?.segmentCount ?? 1) > 1
          ? `части ${Math.min((gen?.segmentDone ?? 0) + 1, gen?.segmentCount ?? 1)}/${gen?.segmentCount} · затем бесшовная склейка`
          : 'обычно 2–10 мин — можно уйти со страницы',
        gen?.renderSec,
      ),
    },
    { key: 'download', label: 'Скачивание', ...mark(genS === 'done', genS === 'downloading', 'забираю готовый ролик в библиотеку') },
  ];
}

function deriveUserSteps(proj: ProjectFull, gen: GenerationRow | null): Step[] {
  const local = proj.status;
  const genStatus = gen?.status ?? null;
  const prepared = !!proj.analysis || proj.promptVersions > 0 || !!genStatus;
  const lookReady = proj.startFrames.length > 0 || !!genStatus;
  const renderDone = genStatus === 'done';
  const renderActive = !!genStatus && genStatus !== 'done' && genStatus !== 'failed';
  const mark = (done: boolean, active: boolean, hint?: string): Omit<Step, 'key' | 'label'> => ({
    state: active ? 'active' : done ? 'done' : 'todo',
    hint: active ? hint : undefined,
  });
  const renderHint = genStatus === 'queued'
    ? `В очереди: ${gen?.queuePosition ?? '?'}-й. Запустится автоматически.`
    : (gen?.segmentCount ?? 1) > 1
      ? 'Создаём части и аккуратно соединяем их в один ролик.'
      : 'Обычно занимает 2–10 минут.';
  return [
    {
      key: 'prepare',
      label: 'Проверяем сцены и фото',
      ...mark(prepared, local === 'storyboarding' || local === 'analyzing', 'Ищем риск смены лица, образа, объектов и плохих стыков.'),
    },
    {
      key: 'look',
      label: 'Собираем новый образ',
      ...mark(lookReady, local === 'generating' || local === 'startframing', 'Переносим выбранный пресет в первый кадр.'),
    },
    { key: 'render', label: 'Создаём видео', ...mark(renderDone, renderActive, renderHint) },
    { key: 'done', label: 'Готово', ...mark(renderDone, false) },
  ];
}

function ProgressStepper({ proj, gen, detailed }: { proj: ProjectFull; gen: GenerationRow | null; detailed: boolean }) {
  const steps = detailed ? deriveSteps(proj, gen) : deriveUserSteps(proj, gen);
  const run = proj.costs.activeRun;
  const [cancelling, setCancelling] = useState(false);
  const cancelQueue = async () => {
    if (!gen) return;
    setCancelling(true);
    try {
      await api.genCancelQueue(gen.id);
    } catch {
      /* поллинг подтянет актуальный статус */
    } finally {
      setCancelling(false);
    }
  };
  return (
    <div>
      {gen?.status === 'queued' && (
        <div className="mb-3 flex items-center gap-3 rounded-lg border border-line bg-panel2 px-3 py-2 text-xs">
          <span className="text-mut">
            Сейчас рендерится другой ролик — твой стартует автоматически, страницу можно закрыть.
          </span>
          <Button kind="ghost" busy={cancelling} className="!py-1 !px-2 text-xs ml-auto" onClick={() => void cancelQueue()}>
            Отменить очередь
          </Button>
        </div>
      )}
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
        <Tag tone="lime">создаём ролик</Tag>
        {detailed && run && (
          <span className="text-mut">
            потрачено: OpenAI ${run.openaiUsd.toFixed(3)}
            {run.wavespeedActualUsd !== null
              ? ` · WaveSpeed $${run.wavespeedActualUsd.toFixed(2)}`
              : run.wavespeedEstUsd !== null
                ? ` · WaveSpeed ≈$${run.wavespeedEstUsd.toFixed(2)} (по завершении — факт)`
                : ''}
          </span>
        )}
        {detailed && !run && proj.costs.heldUsd != null && (
          <span className="text-mut">
            зарезервировано ${proj.costs.heldUsd.toFixed(2)}
          </span>
        )}
        <span className="text-dim ml-auto">Можно закрыть страницу — работа продолжится.</span>
      </div>
    </div>
  );
}
