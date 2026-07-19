import { useCallback, useEffect, useState } from 'react';
import type { DollarBalanceInfo, HealthInfo, MeInfo, PricingInfo, UsageSummary } from '@shared/api-types';
import { ApiError, api } from './api';
import NewSwap from './screens/NewSwap';
import Library from './screens/Library';
import Login from './screens/Login';
import Models from './screens/Models';
import Billing from './screens/Billing';
import Guide from './screens/Guide';
import OwnerCredits from './screens/OwnerCredits';
import { JourneyBar, JourneyHome, type JourneyStatus, type JourneyTarget } from './screens/Onboarding';
import { Spinner } from './ui';

type View = 'start' | 'swap' | 'models' | 'library' | 'billing' | 'guide' | 'credits';
/** null = сессия ещё проверяется; 'anon' = не залогинен. */
type Session = MeInfo | 'anon' | null;

const VIEW_HASHES = new Set<View>(['start', 'swap', 'models', 'library', 'billing', 'guide', 'credits']);

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

function buildJourneyStatus(data: JourneyData, prefs: JourneyPrefs): JourneyStatus {
  const current = !data.hasBalance && !prefs.balanceDeferred
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
  return VIEW_HASHES.has(raw as View) ? (raw as View) : 'swap';
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

  const isOwner = session !== null && session !== 'anon' && session.user.role === 'owner';
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
    if (!userId || isOwner) return;
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
  }, [isOwner, userId]);

  useEffect(() => {
    if (!userId || isOwner) return;
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
  }, [isOwner, loadJourney, userId]);

  useEffect(() => {
    if (!userId || isOwner || journeyPrefs.skipped || journeyData?.hasResult) return;
    const timer = window.setInterval(() => void loadJourney(), 8_000);
    const onFocus = () => void loadJourney();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [isOwner, journeyData?.hasResult, journeyPrefs.skipped, loadJourney, userId]);

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

  const activeView: View = (isOwner && view === 'billing') || (!isOwner && view === 'credits') ? 'swap' : view;
  const journeyStatus = journeyData ? buildJourneyStatus(journeyData, journeyPrefs) : null;
  const journeyActive = !!journeyStatus && journeyStatus.current !== 'done' && !journeyPrefs.skipped && !isOwner;

  useEffect(() => {
    if ((isOwner && (view === 'billing' || view === 'start')) || (!isOwner && view === 'credits')) go('swap');
  }, [go, isOwner, view]);

  useEffect(() => {
    if (!journeyActive || journeyRouted) return;
    setJourneyRouted(true);
    if (view === 'swap' && !projectId) go('start');
  }, [go, journeyActive, journeyRouted, projectId, view]);

  useEffect(() => {
    if (session === null || session === 'anon') return;
    api.health().then(setHealth).catch(() => setHealth(null));
    // USD оператора существует только для владельца — тенантам эти роуты закрыты (403)
    if (isOwner) {
      api.pricing().then(setPricing).catch(() => setPricing(null));
      api.usageSummary().then(setUsage).catch(() => setUsage(null));
    } else void loadJourney();
  }, [view, session, isOwner, loadJourney]);

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

  if (session === null) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (session === 'anon') {
    return <Login onAuthed={loadSession} />;
  }

  const u = session.user;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-line px-4 sm:px-6 py-3 flex items-center gap-3 sticky top-0 bg-bg/90 backdrop-blur z-20 min-w-0">
        <Logo />
        {!journeyActive && <nav className="hidden md:flex gap-1 ml-2">
          <TabBtn active={activeView === 'swap'} onClick={() => go('swap')}>
            Создать
          </TabBtn>
          <TabBtn active={activeView === 'models'} onClick={() => go('models')}>
            Мои модели
          </TabBtn>
          <TabBtn active={activeView === 'library'} onClick={() => go('library')}>
            Библиотека
          </TabBtn>
          {!isOwner ? (
            <TabBtn active={activeView === 'billing'} onClick={() => openBilling()}>
              Баланс
            </TabBtn>
          ) : (
            <TabBtn active={activeView === 'credits'} onClick={() => go('credits')}>
              Начислить
            </TabBtn>
          )}
        </nav>}
        <div className="flex-1" />
        {isOwner && health && health.keyPresent === false && (
          <span className="text-[11px] text-danger hidden sm:inline">LLM-ключ не настроен</span>
        )}
        {isOwner && health && health.diskUsedPct !== undefined && health.diskUsedPct >= 80 && (
          <span className="text-[11px] text-warn hidden sm:inline">
            хранилище {health.diskUsedPct}%
          </span>
        )}
        <UserChip
          name={u.firstName || (u.username ? `@${u.username}` : `id${u.telegramId}`)}
          photo={u.photoUrl}
          owner={u.role === 'owner'}
          onLogout={logout}
        />
      </header>

      <main className="flex-1 w-full min-w-0 max-w-5xl mx-auto px-4 sm:px-6 py-4 sm:py-6 pb-24 md:pb-6">
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
            guided={journeyActive}
          />
        ) : activeView === 'models' ? (
          <Models guided={journeyStatus?.current === 'model'} onProgressChange={loadJourney} />
        ) : activeView === 'billing' ? (
          <Billing
            neededUsd={billingNeed}
            onBackToSwap={() => go(journeyActive ? 'start' : 'swap')}
            onBalanceChange={(next) => {
              setBalance(next);
              void loadJourney();
            }}
          />
        ) : activeView === 'guide' ? (
          <Guide
            onDone={journeyActive ? () => {
              saveJourneyPrefs({ guideSeen: true });
              go('start');
            } : undefined}
          />
        ) : activeView === 'credits' ? (
          <OwnerCredits />
        ) : (
          <Library onOpen={openProjectAndRefresh} />
        )}
      </main>

      <footer className="border-t border-line px-4 sm:px-6 pt-3 pb-24 md:pb-3 text-[11px] text-dim flex flex-wrap gap-x-4 gap-y-1">
        <span className="hidden md:inline">SwapForge v{health?.version ?? '…'}</span>
        {isOwner && health?.provider && (
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
        {isOwner && pricing?.balanceUsd !== null && pricing?.balanceUsd !== undefined && (
          <span className={pricing.balanceUsd < 2 ? 'text-warn' : ''}>
            баланс WaveSpeed: ${pricing.balanceUsd.toFixed(2)}
          </span>
        )}
        {isOwner && usage && usage.totalUsd > 0 && (
          <span>
            за месяц: ${usage.totalUsd.toFixed(2)}
            {usage.runs > 0 ? ` · ${usage.runs} рендеров` : ''}
          </span>
        )}
        {isOwner && pricing?.litellmFetchedAt && (
          <span>тарифы от {pricing.litellmFetchedAt.slice(0, 10)}</span>
        )}
        {!isOwner && balance && (
          <button
            type="button"
            onClick={() => openBilling()}
            className={`${balance.availableUsd <= 0 ? 'text-warn' : ''} hover:text-lime transition-colors hidden md:inline-flex items-center min-h-11 md:min-h-0`}
          >
            баланс: ${balance.availableUsd.toFixed(2)}
          </button>
        )}
        {!journeyActive && <button type="button" onClick={() => go('guide')} className="hover:text-ink inline-flex items-center min-h-11 md:min-h-0">как это работает</button>}
        <a href="legal/terms" className="hover:text-ink inline-flex items-center min-h-11 md:min-h-0">условия</a>
        <a href="legal/privacy" className="hover:text-ink inline-flex items-center min-h-11 md:min-h-0">конфиденциальность</a>
        <span className="ml-auto hidden md:inline">SwapForge · INSHIN LAB · 18+</span>
      </footer>

      {!journeyActive && (
        <MobileNav
          view={activeView}
          isOwner={isOwner}
          onChange={(next) => (next === 'billing' ? openBilling() : go(next))}
        />
      )}
    </div>
  );
}

function MobileNav({
  view,
  isOwner,
  onChange,
}: {
  view: View;
  isOwner: boolean;
  onChange: (view: View) => void;
}) {
  const items: Array<{ view: View; icon: string; label: string }> = [
    { view: 'swap', icon: '⚡', label: 'Создать' },
    { view: 'models', icon: '◇', label: 'Модели' },
    { view: 'library', icon: '▦', label: 'Работы' },
    ...(!isOwner ? [{ view: 'billing' as const, icon: '●', label: 'Баланс' }] : []),
    ...(isOwner ? [{ view: 'credits' as const, icon: '$', label: 'Начислить' }] : []),
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
  onLogout,
}: {
  name: string;
  photo: string;
  owner: boolean;
  onLogout: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      {photo ? (
        <img src={photo} alt="" className="w-7 h-7 rounded-full border border-line2 object-cover" />
      ) : (
        <div className="w-7 h-7 rounded-full bg-panel2 border border-line2 flex items-center justify-center text-[11px] text-mut">
          {name.slice(0, 1).toUpperCase()}
        </div>
      )}
      <span className="text-sm text-mut hidden sm:inline max-w-[140px] truncate">
        {name}
        {owner && <span className="text-lime ml-1" title="владелец">★</span>}
      </span>
      <button
        type="button"
        onClick={onLogout}
        className="min-h-11 sm:min-h-0 text-[11px] text-dim hover:text-ink border border-line rounded-lg px-3 sm:px-2 py-1 transition-colors"
        title="Выйти из аккаунта"
      >
        Выйти
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

function Logo() {
  return (
    <div className="flex items-center gap-2 select-none">
      <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
        <rect width="32" height="32" rx="7" fill="#131316" />
        <path d="M18.5 4 8 18h6l-1.5 10L23 14h-6l1.5-10z" fill="#C6F24E" />
      </svg>
      <span className="font-extrabold tracking-tight">
        Swap<span className="text-lime">Forge</span>
      </span>
      <span className="text-[10px] uppercase tracking-[0.18em] text-dim mt-0.5 hidden sm:inline">
        Inshin Lab
      </span>
    </div>
  );
}
