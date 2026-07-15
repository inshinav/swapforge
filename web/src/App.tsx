import { useCallback, useEffect, useState } from 'react';
import type { HealthInfo } from '@shared/api-types';
import { api } from './api';
import NewSwap from './screens/NewSwap';
import Library from './screens/Library';

type View = 'new' | 'library';

export default function App() {
  const [view, setView] = useState<View>('new');
  const [projectId, setProjectId] = useState<string | null>(
    () => localStorage.getItem('sf-project') || null,
  );
  const [health, setHealth] = useState<HealthInfo | null>(null);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
  }, [view]);

  const openProject = useCallback((id: string) => {
    const pid = id || null;
    setProjectId(pid);
    if (pid) localStorage.setItem('sf-project', pid);
    else localStorage.removeItem('sf-project');
    setView('new');
  }, []);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-line px-4 sm:px-6 py-3 flex items-center gap-4 sticky top-0 bg-bg/85 backdrop-blur z-10">
        <Logo />
        <nav className="flex gap-1 ml-2">
          <TabBtn active={view === 'new'} onClick={() => setView('new')}>
            Свап
          </TabBtn>
          <TabBtn active={view === 'library'} onClick={() => setView('library')}>
            Библиотека
          </TabBtn>
        </nav>
        <div className="flex-1" />
        {health && !health.keyPresent && (
          <span className="text-[11px] text-danger hidden sm:inline">LLM-ключ не настроен</span>
        )}
        {health && health.diskUsedPct >= 80 && (
          <span className="text-[11px] text-warn hidden sm:inline">
            хранилище {health.diskUsedPct}%
          </span>
        )}
      </header>

      <main className="flex-1 w-full max-w-5xl mx-auto px-4 sm:px-6 py-6">
        {view === 'new' ? (
          <NewSwap projectId={projectId} onProjectCreated={openProject} />
        ) : (
          <Library onOpen={openProject} />
        )}
      </main>

      <footer className="border-t border-line px-6 py-3 text-[11px] text-dim flex flex-wrap gap-x-4 gap-y-1">
        <span>SwapForge v{health?.version ?? '…'}</span>
        {health && (
          <>
            <span>
              мозг: {health.provider}/{health.model}
            </span>
            <span>
              хранилище: {(health.dataBytes / 1024 ** 3).toFixed(2)} /{' '}
              {(health.storageCapBytes / 1024 ** 3).toFixed(0)} ГБ
            </span>
          </>
        )}
        <span className="ml-auto">INSHIN LAB · внутренний инструмент</span>
      </footer>
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
