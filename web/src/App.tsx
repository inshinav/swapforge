import { useCallback, useEffect, useRef, useState } from 'react';
import type { DollarBalanceInfo, HealthInfo, MeInfo, PricingInfo, UsageSummary } from '@shared/api-types';
import { ApiError, api } from './api';
import NewSwap from './screens/NewSwap';
import Library from './screens/Library';
import Login from './screens/Login';
import Models from './screens/Models';
import Billing from './screens/Billing';
import Guide from './screens/Guide';
import Admin from './screens/Admin';
import CarouselStudio from './screens/CarouselStudio';
import { JourneyBar, JourneyHome, type JourneyStatus, type JourneyTarget } from './screens/Onboarding';
import { Spinner } from './ui';

type View = 'start' | 'swap' | 'models' | 'library' | 'billing' | 'guide' | 'admin' | 'carousel';
export type OwnerViewMode = 'admin' | 'user';
/** null = сессия ещё проверяется; 'anon' = не залогинен. */
type Session = MeInfo | 'anon' | null;

const VIEW_HASHES = new Set<View>(['start', 'swap', 'models', 'library', 'billing', 'guide', 'admin', 'carousel']);
const OWNER_VIEW_MODE_KEY = 'sf-owner-view-mode';

interface JourneyPrefs {
  balanceDeferred: boolean;
  guideSeen: boolean;
  skipped: boolean;
}

interface JourneyData {
  hasBalance: boolean;
  hasProject: boolean;
  hasReadyModel: boolean;
  hasResult: boolean;
}

const EMPTY_PREFS: JourneyPrefs = { balanceDeferred: false, guideSeen: false, skipped: false };

function journeyStorageKey(userId: string): string {
  return `sf-onboarding:${userId}`;
}

export function buildJourneyStatus(data: JourneyData, prefs: JourneyPrefs): JourneyStatus {
  const current = data.hasResult
    ? 'done'
    : !data.hasBalance && !prefs.balanceDeferred
    ? 'balance'
    : !prefs.guideSeen
      ? 'guide'
      : !data.hasProject
        ? 'video'
        : !data.hasReadyModel
          ? 'model'
          : !data.hasResult
            ? 'result'
            : 'done';
  return { ...data, ...prefs, current };
}

function viewFromHash(): View {
  const raw = window.location.hash.replace(/^#/, '');
  if (raw === 'credits') return 'admin';
  return VIEW_HASHES.has(raw as View) ? (raw as View) : 'swap';
}

export function readOwnerViewMode(storage: Pick<Storage, 'getItem'>): OwnerViewMode {
  return storage.getItem(OWNER_VIEW_MODE_KEY) === 'user' ? 'user' : 'admin';
}

export function resolveView(
  view: View,
  isOwner: boolean,
  ownerMode: OwnerViewMode,
  carouselEnabled = false,
): View {
  // Флаг выключен → #carousel не резолвится (SPEC §0.1)
  if (view === 'carousel' && !carouselEnabled) return 'swap';
  if (!isOwner && view === 'admin') return 'swap';
  if (isOwner && ownerMode === 'user' && view === 'admin') return 'swap';
  if (isOwner && ownerMode === 'admin' && (view === 'billing' || view === 'start')) return 'admin';
  return view;
}

export default function App() {
  const [session, setSession] = useState<Session>(null);
  const [view, setView] = useState<View>(viewFromHash);
  const [projectId, setProjectId] = useState<string | null>(
    () => localStorage.getItem('sf-project') || null,
  );
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [pricing, setPricing] = useState<PricingInfo | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [balance, setBalance] = useState<DollarBalanceInfo | null>(null);
  const [billingNeed, setBillingNeed] = useState<number | null>(null);
  const [journeyData, setJourneyData] = useState<JourneyData | null>(null);
  const [journeyPrefs, setJourneyPrefs] = useState<JourneyPrefs>(EMPTY_PREFS);
  const [journeyRouted, setJourneyRouted] = useState(false);
  const [ownerViewMode, setOwnerViewMode] = useState<OwnerViewMode>(() => {
    try {
      return readOwnerViewMode(localStorage);
    } catch {
      return 'admin';
    }
  });

  const isOwner = session !== null && session !== 'anon' && session.user.role === 'owner';
  const isSandbox = session !== null && session !== 'anon' && session.user.sandbox;
  const showOwnerTools = isOwner && ownerViewMode === 'admin';
  const showUserExperience = !isOwner || ownerViewMode === 'user';
  const previewAsUser = isOwner && ownerViewMode === 'user';
  const userId = session !== null && session !== 'anon' ? session.user.id : null;

  const loadSession = useCallback(() => {
    api
      .me()
      .then(setSession)
      .catch((e: unknown) => {
        setSession('anon');
        if (!(e instanceof ApiError && e.status === 401)) console.warn('me:', e);
      });
  }, []);

  useEffect(loadSession, [loadSession]);

  useEffect(() => {
    const syncView = () => {
      const next = viewFromHash();
      setView(next);
      if (window.location.hash !== `#${next}`) history.replaceState(null, '', `#${next}`);
    };
    syncView();
    window.addEventListener('hashchange', syncView);
    return () => window.removeEventListener('hashchange', syncView);
  }, []);

  const go = useCallback((next: View) => {
    if (window.location.hash === `#${next}`) setView(next);
    else window.location.hash = next;
  }, []);

  const loadJourney = useCallback(async () => {
    if (!userId || !showUserExperience) return;
    try {
      const [models, projects, nextBalance] = await Promise.all([
        api.models(),
        api.projects(),
        api.billingBalance(),
      ]);
      const hasReadyModel = models.some((model) =>
        model.variants.some((variant) =>
          model.refs.some((ref) => ref.role === 'model' && (ref.variantId === variant.id || ref.variantId === null)),
        ),
      );
      setBalance(nextBalance);
      setJourneyData({
        hasBalance: nextBalance.availableUsd > 0,
        hasProject: projects.length > 0,
        hasReadyModel,
        hasResult: projects.some((project) => project.latestRender !== null),
      });
    } catch {
      // Основные экраны покажут свою ошибку; помощник не должен блокировать кабинет.
    }
  }, [showUserExperience, userId]);

  useEffect(() => {
    if (!userId || !showUserExperience) return;
    try {
      const saved = JSON.parse(localStorage.getItem(journeyStorageKey(userId)) ?? '{}') as Partial<JourneyPrefs>;
      setJourneyPrefs({
        balanceDeferred: saved.balanceDeferred === true,
        guideSeen: saved.guideSeen === true,
        skipped: saved.skipped === true,
      });
    } catch {
      setJourneyPrefs(EMPTY_PREFS);
    }
    setJourneyData(null);
    setJourneyRouted(false);
    void loadJourney();
  }, [loadJourney, showUserExperience, userId]);

  useEffect(() => {
    if (!userId || !showUserExperience || journeyPrefs.skipped || journeyData?.hasResult) return;
    const timer = window.setInterval(() => void loadJourney(), 8_000);
    const onFocus = () => void loadJourney();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [journeyData?.hasResult, journeyPrefs.skipped, loadJourney, showUserExperience, userId]);

  const saveJourneyPrefs = useCallback((patch: Partial<JourneyPrefs>) => {
    if (!userId) return;
    setJourneyPrefs((current) => {
      const next = { ...current, ...patch };
      localStorage.setItem(journeyStorageKey(userId), JSON.stringify(next));
      return next;
    });
  }, [userId]);

  const openBilling = useCallback((needed?: number) => {
    setBillingNeed(needed && needed > 0 ? Math.ceil(needed * 100) / 100 : null);
    go('billing');
  }, [go]);

  const carouselEnabled = typeof session === 'object' && session !== null && !!session.carouselStudio;
  const activeView = resolveView(view, isOwner, ownerViewMode, carouselEnabled);
  const journeyStatus = journeyData ? buildJourneyStatus(journeyData, journeyPrefs) : null;
  const journeyActive =
    !!journeyStatus && journeyStatus.current !== 'done' && !journeyPrefs.skipped && showUserExperience;

  useEffect(() => {
    if (session === null) return; // сессия грузится — не выбивать с #carousel до ответа /api/me
    const next = resolveView(view, isOwner, ownerViewMode, carouselEnabled);
    if (next !== view) go(next);
  }, [carouselEnabled, go, isOwner, ownerViewMode, session, view]);

  useEffect(() => {
    if (!journeyActive || journeyRouted) return;
    setJourneyRouted(true);
    if (view === 'swap' && !projectId) go('start');
  }, [go, journeyActive, journeyRouted, projectId, view]);

  useEffect(() => {
    if (session === null || session === 'anon') return;
    api.health().then(setHealth).catch(() => setHealth(null));
    // USD оператора существует только для владельца — тенантам эти роуты закрыты (403)
    if (showOwnerTools) {
      api.pricing().then(setPricing).catch(() => setPricing(null));
      api.usageSummary().then(setUsage).catch(() => setUsage(null));
    } else void loadJourney();
  }, [view, session, showOwnerTools, loadJourney]);

  const changeOwnerViewMode = useCallback((next: OwnerViewMode) => {
    if (!isOwner) return;
    setOwnerViewMode(next);
    try {
      localStorage.setItem(OWNER_VIEW_MODE_KEY, next);
    } catch {
      // Режим всё равно переключится на текущую сессию.
    }
    go(next === 'admin' ? 'admin' : 'swap');
  }, [go, isOwner]);

  const openProject = useCallback((id: string) => {
    const pid = id || null;
    setProjectId(pid);
    if (pid) localStorage.setItem('sf-project', pid);
    else localStorage.removeItem('sf-project');
    go('swap');
  }, [go]);

  const openProjectAndRefresh = useCallback((id: string) => {
    openProject(id);
    window.setTimeout(() => void loadJourney(), 0);
  }, [loadJourney, openProject]);

  const journeyGo = useCallback((target: JourneyTarget) => {
    if (target === 'swap') go('swap');
    else go(target);
  }, [go]);

  const continueJourney = useCallback(() => {
    if (!journeyStatus) return;
    if (journeyStatus.current === 'balance') {
      if (activeView === 'billing') {
        saveJourneyPrefs({ balanceDeferred: true });
        go('start');
      } else go('billing');
      return;
    }
    if (journeyStatus.current === 'guide') {
      if (activeView === 'guide') {
        saveJourneyPrefs({ guideSeen: true });
        go('start');
      } else go('guide');
      return;
    }
    if (journeyStatus.current === 'video') return openProjectAndRefresh('');
    if (journeyStatus.current === 'model') return go('models');
    go('swap');
  }, [activeView, go, journeyStatus, openProjectAndRefresh, saveJourneyPrefs]);

  const logout = useCallback(() => {
    void api.logout().finally(() => {
      localStorage.removeItem('sf-project');
      setProjectId(null);
      setJourneyData(null);
      setSession('anon');
    });
  }, []);

  // Тест-клиент: сессия реально меняется на другого (metered) юзера — проект/баланс/
  // журней владельца ему не принадлежат, локальные ссылки сбрасываем.
  const [switchErr, setSwitchErr] = useState<string | null>(null);
  const switchTestClient = useCallback((enter: boolean) => {
    setSwitchErr(null);
    void (enter ? api.testClient() : api.testClientExit())
      .then(() => {
        localStorage.removeItem('sf-project');
        setProjectId(null);
        setJourneyData(null);
        setBalance(null);
        setSession(null); // спиннер до свежего /api/me
        loadSession();
        go('swap');
      })
      .catch((e) => setSwitchErr(e instanceof Error ? e.message : String(e)));
  }, [go, loadSession]);

  if (session === null) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (session === 'anon') {
    // Гайд открыт и до входа: человек может ознакомиться с сервисом по прямой ссылке #guide
    if (view === 'guide') {
      return (
        <div className="min-h-screen">
          <header className="border-b border-line px-4 sm:px-6 py-3 flex items-center gap-3 sticky top-0 bg-bg/90 backdrop-blur z-20">
            <Logo onClick={() => go('swap')} />
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => go('swap')}
              className="min-h-11 rounded-xl bg-lime px-4 text-sm font-bold text-black hover:bg-lime-dim"
            >
              Войти через Telegram
            </button>
          </header>
          <main className="w-full max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <Guide onLoginCta={() => go('swap')} />
          </main>
        </div>
      );
    }
    return <Login onAuthed={loadSession} onOpenGuide={() => go('guide')} />;
  }

  const u = session.user;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-line px-4 sm:px-6 py-3 flex items-center gap-3 sticky top-0 bg-bg/90 backdrop-blur z-20 min-w-0">
        <Logo onClick={() => go('swap')} />
        {!journeyActive && <nav className="hidden md:flex gap-1 ml-2">
          <TabBtn active={activeView === 'swap'} onClick={() => go('swap')}>
            Создать
          </TabBtn>
          <TabBtn active={activeView === 'models'} onClick={() => go('models')}>
            Пресеты
          </TabBtn>
          <TabBtn active={activeView === 'library'} onClick={() => go('library')}>
            Работы
          </TabBtn>
          {carouselEnabled && (
            <TabBtn active={activeView === 'carousel'} onClick={() => go('carousel')}>
              Карусели
            </TabBtn>
          )}
          {showOwnerTools && (
            <TabBtn active={activeView === 'admin'} onClick={() => go('admin')}>
              Админ
            </TabBtn>
          )}
        </nav>}
        <div className="flex-1" />
        {isOwner && (
          <OwnerModeSwitch
            mode={ownerViewMode}
            onChange={changeOwnerViewMode}
            className="hidden lg:flex"
          />
        )}
        {showOwnerTools && health && health.keyPresent === false && (
          <span className="text-[11px] text-danger hidden sm:inline">LLM-ключ не настроен</span>
        )}
        {showOwnerTools && health && health.diskUsedPct !== undefined && health.diskUsedPct >= 80 && (
          <span className="text-[11px] text-warn hidden sm:inline">
            хранилище {health.diskUsedPct}%
          </span>
        )}
        {showUserExperience && (
          <button
            type="button"
            onClick={() => openBilling()}
            className={`shrink-0 min-h-11 md:min-h-9 rounded-xl border px-2.5 sm:px-3 text-sm font-bold transition-colors ${
              activeView === 'billing'
                ? 'border-lime/60 bg-lime/10 text-lime'
                : balance && balance.availableUsd <= 0
                  ? 'border-warn/40 text-warn hover:border-warn/70'
                  : 'border-line2 bg-panel2 text-ink hover:border-lime/50'
            }`}
            aria-label={`Баланс ${balance ? `$${balance.availableUsd.toFixed(2)}` : 'загружается'}`}
            title="Баланс и пополнение"
          >
            <span className="hidden sm:inline text-mut font-semibold mr-1.5">Баланс</span>
            {balance ? `$${balance.availableUsd.toFixed(2)}` : '…'}
          </button>
        )}
        <UserChip
          name={u.firstName || (u.username ? `@${u.username}` : `id${u.telegramId}`)}
          photo={u.photoUrl}
          owner={showOwnerTools}
          canSwitchMode={isOwner}
          ownerMode={ownerViewMode}
          onOwnerModeChange={changeOwnerViewMode}
          onTestClient={isOwner ? () => switchTestClient(true) : undefined}
          onGuide={() => go('guide')}
          onLogout={logout}
        />
      </header>

      {isSandbox && (
        <div className="border-b border-warn/30 bg-warn/10 px-4 sm:px-6 py-2 flex items-center gap-3">
          <span className="text-sm font-bold shrink-0">🧪 Тест-клиент</span>
          <span className="text-xs text-mut hidden sm:inline min-w-0 truncate">
            Ты видишь сервис как обычный клиент: реальные цены, резервы и оплата. Баланс и проекты — отдельные.
          </span>
          <button
            type="button"
            onClick={() => switchTestClient(false)}
            className="ml-auto shrink-0 min-h-9 rounded-lg border border-line2 bg-panel2 px-3 text-xs font-bold hover:border-lime/50 hover:text-lime"
          >
            ← Вернуться к владельцу
          </button>
        </div>
      )}
      {switchErr && (
        <div className="px-4 sm:px-6 py-2 text-xs text-danger border-b border-danger/30 bg-danger/5">
          Переключение не удалось: {switchErr}
        </div>
      )}

      <main className={`flex-1 w-full min-w-0 max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-6 ${journeyActive ? 'pb-6' : 'pb-24 md:pb-6'}`}>
        {journeyActive && journeyStatus && activeView !== 'start' && (
          <JourneyBar
            status={journeyStatus}
            onOpenPlan={() => go('start')}
            onContinue={continueJourney}
            showContinue={
              journeyStatus.current === 'balance' ||
              (journeyStatus.current === 'guide' && activeView !== 'guide') ||
              (journeyStatus.current === 'video' && activeView !== 'swap') ||
              (journeyStatus.current === 'model' && activeView !== 'models') ||
              (journeyStatus.current === 'result' && activeView !== 'swap')
            }
          />
        )}
        {activeView === 'start' ? (
          journeyStatus ? (
            <JourneyHome
              status={journeyStatus}
              onGo={journeyGo}
              onNewVideo={() => openProjectAndRefresh('')}
              onBalanceLater={() => saveJourneyPrefs({ balanceDeferred: true })}
              onSkip={() => {
                saveJourneyPrefs({ skipped: true });
                go('swap');
              }}
            />
          ) : (
            <div className="flex justify-center py-24"><Spinner /></div>
          )
        ) : activeView === 'swap' ? (
          <NewSwap
            projectId={projectId}
            onProjectCreated={openProjectAndRefresh}
            onOpenModels={() => go('models')}
            onOpenBilling={openBilling}
            owner={showOwnerTools}
            previewAsUser={previewAsUser}
            guided={journeyActive}
          />
        ) : activeView === 'models' ? (
          <Models guided={journeyStatus?.current === 'model'} onProgressChange={loadJourney} />
        ) : activeView === 'carousel' ? (
          <CarouselStudio onOpenBilling={openBilling} onOpenModels={() => go('models')} />
        ) : activeView === 'billing' ? (
          <Billing
            userId={userId!}
            neededUsd={billingNeed}
            previewAsUser={previewAsUser}
            onTestClient={isOwner ? () => switchTestClient(true) : undefined}
            onBackToSwap={() => go(journeyActive ? 'start' : 'swap')}
            onBalanceChange={(next) => {
              setBalance(next);
              void loadJourney();
            }}
          />
        ) : activeView === 'guide' ? (
          <Guide
            onOpenModels={() => go('models')}
            onOpenSwap={() => go('swap')}
            onDone={journeyActive ? () => {
              saveJourneyPrefs({ guideSeen: true });
              go('swap');
            } : undefined}
          />
        ) : activeView === 'admin' ? (
          <Admin pricing={pricing} usage={usage} />
        ) : (
          <Library onOpen={openProjectAndRefresh} />
        )}
      </main>

      {showOwnerTools && (
        <footer className="border-t border-line px-4 sm:px-6 pt-3 pb-24 md:pb-3 text-[11px] text-dim flex flex-wrap gap-x-4 gap-y-1">
          <span className="hidden md:inline">SwapForge v{health?.version ?? '…'}</span>
          {health?.provider && (
          <>
            <span>
              мозг: {health.provider}/{health.model}
            </span>
            {health.dataBytes !== undefined && health.storageCapBytes !== undefined && (
              <span>
                хранилище: {(health.dataBytes / 1024 ** 3).toFixed(2)} /{' '}
                {(health.storageCapBytes / 1024 ** 3).toFixed(0)} ГБ
              </span>
            )}
          </>
          )}
          {pricing?.balanceUsd !== null && pricing?.balanceUsd !== undefined && (
          <span className={pricing.balanceUsd < 2 ? 'text-warn' : ''}>
            баланс WaveSpeed: ${pricing.balanceUsd.toFixed(2)}
          </span>
          )}
          {usage && (
          <span>
            OpenAI за месяц: ${usage.openaiUsd.toFixed(2)} · всего: ${usage.totalUsd.toFixed(2)}
            {usage.runs > 0 ? ` · ${usage.runs} рендеров` : ''}
          </span>
          )}
          {pricing?.litellmFetchedAt && (
          <span>тарифы от {pricing.litellmFetchedAt.slice(0, 10)}</span>
          )}
          <a href="legal/terms" className="hover:text-ink inline-flex items-center min-h-11 md:min-h-0">условия</a>
          <a href="legal/privacy" className="hover:text-ink inline-flex items-center min-h-11 md:min-h-0">конфиденциальность</a>
          <span className="ml-auto hidden md:inline">SwapForge · INSHIN LAB · 18+</span>
        </footer>
      )}

      {!journeyActive && (
        <MobileNav
          view={activeView}
          isOwner={showOwnerTools}
          carouselEnabled={carouselEnabled}
          onChange={(next) => (next === 'billing' ? openBilling() : go(next))}
        />
      )}
    </div>
  );
}

function MobileNav({
  view,
  isOwner,
  carouselEnabled,
  onChange,
}: {
  view: View;
  isOwner: boolean;
  carouselEnabled: boolean;
  onChange: (view: View) => void;
}) {
  const items: Array<{ view: View; icon: string; label: string }> = [
    { view: 'swap', icon: '⚡', label: 'Создать' },
    { view: 'models', icon: '◇', label: 'Пресеты' },
    { view: 'library', icon: '▦', label: 'Работы' },
    ...(carouselEnabled ? [{ view: 'carousel' as const, icon: '▤', label: 'Карусели' }] : []),
    ...(isOwner ? [{ view: 'admin' as const, icon: '◎', label: 'Админ' }] : []),
  ];
  return (
    <nav
      aria-label="Основная навигация"
      className="fixed inset-x-0 bottom-0 z-30 md:hidden flex border-t border-line bg-bg/95 backdrop-blur px-1 pt-1 pb-[calc(env(safe-area-inset-bottom)+0.25rem)]"
    >
      {items.map((item) => (
        <button
          key={item.view}
          type="button"
          aria-current={view === item.view ? 'page' : undefined}
          onClick={() => onChange(item.view)}
          className={`min-w-0 flex-1 min-h-14 rounded-xl flex flex-col items-center justify-center gap-0.5 text-[10px] font-semibold transition-colors ${
            view === item.view ? 'text-lime bg-lime/8' : 'text-mut'
          }`}
        >
          <span className="text-base leading-4" aria-hidden>{item.icon}</span>
          <span className="truncate max-w-full px-1">{item.label}</span>
        </button>
      ))}
    </nav>
  );
}

function UserChip({
  name,
  photo,
  owner,
  canSwitchMode,
  ownerMode,
  onOwnerModeChange,
  onTestClient,
  onGuide,
  onLogout,
}: {
  name: string;
  photo: string;
  owner: boolean;
  canSwitchMode: boolean;
  ownerMode: OwnerViewMode;
  onOwnerModeChange: (mode: OwnerViewMode) => void;
  /** Владелец: переключиться в настоящего metered тест-клиента. */
  onTestClient?: () => void;
  onGuide: () => void;
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onOutside);
    return () => document.removeEventListener('pointerdown', onOutside);
  }, [open]);
  return (
    <div ref={root} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-label="Меню профиля"
        className="min-h-11 md:min-h-9 flex items-center gap-2 cursor-pointer rounded-xl border border-transparent hover:border-line px-1.5 sm:px-2 select-none"
      >
        {photo ? (
          <img src={photo} alt="" className="w-7 h-7 rounded-full border border-line2 object-cover" />
        ) : (
          <span className="w-7 h-7 rounded-full bg-panel2 border border-line2 flex items-center justify-center text-[11px] text-mut">
            {name.slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className="text-sm text-mut hidden sm:inline max-w-[140px] truncate">
          {name}
          {owner && <span className="text-lime ml-1" title="владелец">★</span>}
        </span>
        <span className="hidden sm:inline text-dim text-[10px]" aria-hidden>▾</span>
      </button>
      {open && <div className={`absolute right-0 top-[calc(100%+0.4rem)] z-40 rounded-xl border border-line2 bg-panel shadow-xl p-1.5 sf-in ${canSwitchMode ? 'w-64' : 'w-48'}`}>
        {canSwitchMode && (
          <div className="p-1.5 pb-2.5 mb-1 border-b border-line space-y-2">
            <div>
              <div className="text-xs font-bold text-ink">Режим кабинета</div>
              <div className="text-[10px] text-dim mt-0.5">Переключатель доступен только владельцу</div>
            </div>
            <OwnerModeSwitch
              mode={ownerMode}
              onChange={(next) => {
                setOpen(false);
                onOwnerModeChange(next);
              }}
              className="flex w-full"
            />
          </div>
        )}
        {onTestClient && (
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onTestClient();
            }}
            className="w-full min-h-11 rounded-lg px-3 text-left text-sm text-mut hover:bg-panel2 hover:text-ink"
            title="Отдельный клиентский аккаунт с реальными ценами и оплатой — проверка пути клиента"
          >
            🧪 Войти тест-клиентом
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            onGuide();
          }}
          className="w-full min-h-11 rounded-lg px-3 text-left text-sm text-mut hover:bg-panel2 hover:text-ink"
        >
          Как это работает
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            onLogout();
          }}
          className="w-full min-h-11 rounded-lg px-3 text-left text-sm text-dim hover:bg-panel2 hover:text-ink"
        >
          Выйти
        </button>
      </div>}
    </div>
  );
}

function OwnerModeSwitch({
  mode,
  onChange,
  className = '',
}: {
  mode: OwnerViewMode;
  onChange: (mode: OwnerViewMode) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label="Режим кабинета владельца"
      className={`shrink-0 rounded-xl border border-line2 bg-panel2 p-0.5 gap-0.5 ${className}`}
    >
      <button
        type="button"
        aria-pressed={mode === 'admin'}
        onClick={() => onChange('admin')}
        className={`min-h-9 flex-1 rounded-lg px-2.5 text-xs font-bold transition-colors ${
          mode === 'admin' ? 'bg-lime text-black' : 'text-mut hover:text-ink'
        }`}
      >
        Админка
      </button>
      <button
        type="button"
        aria-pressed={mode === 'user'}
        onClick={() => onChange('user')}
        className={`min-h-9 flex-1 rounded-lg px-2.5 text-xs font-bold transition-colors ${
          mode === 'user' ? 'bg-lime text-black' : 'text-mut hover:text-ink'
        }`}
      >
        Как клиент
      </button>
    </div>
  );
}

function TabBtn({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
        active ? 'bg-panel2 text-ink border border-line2' : 'text-mut hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}

function Logo({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex items-center gap-2 select-none shrink-0" title="Создать ролик">
      <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
        <rect width="32" height="32" rx="7" fill="#131316" />
        <path d="M18.5 4 8 18h6l-1.5 10L23 14h-6l1.5-10z" fill="#C6F24E" />
      </svg>
      <span className="font-extrabold tracking-tight">
        Swap<span className="text-lime">Forge</span>
      </span>
      <span className="text-[10px] uppercase tracking-[0.18em] text-dim mt-0.5 hidden lg:inline">
        Inshin Lab
      </span>
    </button>
  );
}
