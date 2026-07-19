import { useCallback, useEffect, useState } from 'react';
import type { CreditBalanceInfo, HealthInfo, MeInfo, PricingInfo, UsageSummary } from '@shared/api-types';
import { ApiError, api } from './api';
import NewSwap from './screens/NewSwap';
import Library from './screens/Library';
import Login from './screens/Login';
import Models from './screens/Models';
import Billing from './screens/Billing';
import Guide from './screens/Guide';
import { Spinner } from './ui';

type View = 'swap' | 'models' | 'library' | 'billing' | 'guide';
/** null = сессия ещё проверяется; 'anon' = не залогинен. */
type Session = MeInfo | 'anon' | null;

const VIEW_HASHES = new Set<View>(['swap', 'models', 'library', 'billing', 'guide']);

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
  const [credits, setCredits] = useState<CreditBalanceInfo | null>(null);
  const [billingNeed, setBillingNeed] = useState<number | null>(null);

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

  const openBilling = useCallback((needed?: number) => {
    setBillingNeed(needed && needed > 0 ? Math.ceil(needed) : null);
    go('billing');
  }, [go]);

  const isOwner = session !== null && session !== 'anon' && session.user.role === 'owner';

  useEffect(() => {
    if (session === null || session === 'anon') return;
    api.health().then(setHealth).catch(() => setHealth(null));
    // USD оператора существует только для владельца — тенантам эти роуты закрыты (403)
    if (isOwner) {
      api.pricing().then(setPricing).catch(() => setPricing(null));
      api.usageSummary().then(setUsage).catch(() => setUsage(null));
    } else {
      api.creditBalance().then(setCredits).catch(() => setCredits(null));
    }
  }, [view, session, isOwner]);

  const openProject = useCallback((id: string) => {
    const pid = id || null;
    setProjectId(pid);
    if (pid) localStorage.setItem('sf-project', pid);
    else localStorage.removeItem('sf-project');
    go('swap');
  }, [go]);

  const logout = useCallback(() => {
    void api.logout().finally(() => {
      localStorage.removeItem('sf-project');
      setProjectId(null);
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
        <nav className="hidden md:flex gap-1 ml-2">
          <TabBtn active={view === 'swap'} onClick={() => go('swap')}>
            Свап
          </TabBtn>
          <TabBtn active={view === 'models'} onClick={() => go('models')}>
            Мои модели
          </TabBtn>
          <TabBtn active={view === 'library'} onClick={() => go('library')}>
            Библиотека
          </TabBtn>
          {!isOwner && (
            <TabBtn active={view === 'billing'} onClick={() => openBilling()}>
              Баланс
            </TabBtn>
          )}
          <TabBtn active={view === 'guide'} onClick={() => go('guide')}>
            Гайд
          </TabBtn>
        </nav>
        <div className="flex-1" />
        {health && health.keyPresent === false && (
          <span className="text-[11px] text-danger hidden sm:inline">LLM-ключ не настроен</span>
        )}
        {health && health.diskUsedPct !== undefined && health.diskUsedPct >= 80 && (
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
        {view === 'swap' ? (
          <NewSwap
            projectId={projectId}
            onProjectCreated={openProject}
            onOpenModels={() => go('models')}
            onOpenBilling={openBilling}
          />
        ) : view === 'models' ? (
          <Models />
        ) : view === 'billing' ? (
          <Billing
            neededCredits={billingNeed}
            onBackToSwap={() => go('swap')}
            onBalanceChange={setCredits}
          />
        ) : view === 'guide' ? (
          <Guide />
        ) : (
          <Library onOpen={openProject} />
        )}
      </main>

      <footer className="border-t border-line px-4 sm:px-6 pt-3 pb-24 md:pb-3 text-[11px] text-dim flex flex-wrap gap-x-4 gap-y-1">
        <span>SwapForge v{health?.version ?? '…'}</span>
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
        {!isOwner && credits && (
          <button
            type="button"
            onClick={() => openBilling()}
            className={`${credits.available <= 0 ? 'text-warn' : ''} hover:text-lime transition-colors`}
          >
            баланс: {credits.available} кредитов
            {credits.held > 0 ? ` (+${credits.held} в резерве)` : ''}
          </button>
        )}
        <a href="legal/terms" className="hover:text-ink">условия</a>
        <a href="legal/privacy" className="hover:text-ink">конфиденциальность</a>
        <span className="ml-auto">SwapForge · INSHIN LAB · 18+</span>
      </footer>

      <MobileNav
        view={view}
        isOwner={isOwner}
        onChange={(next) => (next === 'billing' ? openBilling() : go(next))}
      />
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
    { view: 'swap', icon: '⚡', label: 'Свап' },
    { view: 'models', icon: '◇', label: 'Модели' },
    { view: 'library', icon: '▦', label: 'Работы' },
    ...(!isOwner ? [{ view: 'billing' as const, icon: '●', label: 'Баланс' }] : []),
    { view: 'guide', icon: '?', label: 'Гайд' },
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
        className="text-[11px] text-dim hover:text-ink border border-line rounded-lg px-2 py-1 transition-colors"
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
