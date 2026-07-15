import { useEffect, useState } from 'react';
import type { HealthInfo } from '@shared/api-types';

export default function App() {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then(setHealth)
      .catch((e) => setErr(String(e)));
  }, []);

  return (
    <div className="min-h-screen">
      <header className="border-b border-line px-6 py-4 flex items-center gap-3">
        <Logo />
        <div className="text-sm text-mut">генератор промтов для Seedance 2.0 subject-swap</div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-24 text-center sf-in">
        <div className="text-5xl mb-4">⚒️</div>
        <h1 className="text-2xl font-bold mb-2">Каркас SwapForge поднят</h1>
        <p className="text-mut mb-8">Этап 1 из 6 — пайплайн ingest → анализ → промты уже в работе.</p>
        {health && (
          <div className="inline-flex flex-wrap justify-center gap-2 text-xs">
            <Chip ok>v{health.version}</Chip>
            <Chip ok={health.ffmpeg}>ffmpeg {health.ffmpeg ? 'на месте' : 'нет'}</Chip>
            <Chip ok={health.keyPresent}>
              {health.provider}/{health.model} · ключ {health.keyPresent ? 'есть' : 'нет'}
            </Chip>
          </div>
        )}
        {err && <div className="text-danger text-sm">API недоступен: {err}</div>}
      </main>
    </div>
  );
}

export function Logo() {
  return (
    <div className="flex items-center gap-2 select-none">
      <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
        <rect width="32" height="32" rx="7" fill="#131316" />
        <path d="M18.5 4 8 18h6l-1.5 10L23 14h-6l1.5-10z" fill="#C6F24E" />
      </svg>
      <span className="font-extrabold tracking-tight">
        Swap<span className="text-lime">Forge</span>
      </span>
      <span className="text-[10px] uppercase tracking-[0.18em] text-dim mt-0.5">Inshin Lab</span>
    </div>
  );
}

export function Chip({ children, ok = true }: { children: React.ReactNode; ok?: boolean }) {
  return (
    <span
      className={`px-2.5 py-1 rounded-full border ${
        ok ? 'border-line text-mut' : 'border-danger/40 text-danger'
      } bg-panel`}
    >
      {children}
    </span>
  );
}
