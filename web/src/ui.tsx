import { useState, type ReactNode } from 'react';

/** Копирование с фолбэком: navigator.clipboard живёт только в secure context (HTTPS/localhost). */
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* падаем в фолбэк */
    }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    return document.execCommand('copy');
  } finally {
    ta.remove();
  }
}

export function Card({
  children,
  className = '',
  glow = false,
}: {
  children: ReactNode;
  className?: string;
  glow?: boolean;
}) {
  return (
    <section
      className={`rounded-2xl border border-line bg-panel ${
        glow ? 'shadow-[0_0_48px_-18px_rgba(198,242,78,0.25)]' : ''
      } ${className}`}
    >
      {children}
    </section>
  );
}

export function SectionTitle({
  step,
  title,
  hint,
  right,
}: {
  step?: string;
  title: string;
  hint?: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3 border-b border-line">
      <div className="flex items-baseline gap-3 min-w-0">
        {step && (
          <span className="text-[11px] font-bold text-lime bg-lime/10 border border-lime/25 rounded-md px-1.5 py-0.5 shrink-0">
            {step}
          </span>
        )}
        <h2 className="font-bold tracking-tight truncate">{title}</h2>
        {hint && <span className="text-xs text-mut hidden sm:inline truncate">{hint}</span>}
      </div>
      {right}
    </div>
  );
}

export function Button({
  children,
  onClick,
  kind = 'ghost',
  disabled,
  busy,
  className = '',
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: 'primary' | 'ghost' | 'danger';
  disabled?: boolean;
  busy?: boolean;
  className?: string;
  title?: string;
}) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  const kinds = {
    primary: 'bg-lime text-black hover:bg-lime-dim',
    ghost: 'border border-line2 text-ink hover:border-lime/50 hover:text-lime bg-panel2',
    danger: 'border border-danger/30 text-danger hover:bg-danger/10',
  } as const;
  return (
    <button
      type="button"
      title={title}
      className={`${base} ${kinds[kind]} ${className}`}
      onClick={onClick}
      disabled={disabled || busy}
    >
      {busy && <Spinner size={14} dark={kind === 'primary'} />}
      {children}
    </button>
  );
}

export function Spinner({ size = 16, dark = false }: { size?: number; dark?: boolean }) {
  return (
    <span
      className="inline-block rounded-full border-2 animate-spin"
      style={{
        width: size,
        height: size,
        borderColor: dark ? 'rgba(0,0,0,0.25)' : 'rgba(198,242,78,0.25)',
        borderTopColor: dark ? '#000' : '#C6F24E',
      }}
    />
  );
}

export function Tag({ children, tone = 'mut' }: { children: ReactNode; tone?: 'mut' | 'lime' | 'warn' | 'danger' | 'ok' }) {
  const tones = {
    mut: 'border-line text-mut',
    lime: 'border-lime/30 text-lime bg-lime/5',
    warn: 'border-warn/30 text-warn bg-warn/5',
    danger: 'border-danger/30 text-danger bg-danger/5',
    ok: 'border-ok/30 text-ok bg-ok/5',
  } as const;
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] leading-4 ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function CopyBlock({
  title,
  badge,
  text,
  mono = true,
}: {
  title: string;
  badge?: string;
  text: string;
  mono?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void copyText(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };
  return (
    <div className="rounded-xl border border-line bg-panel2 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-line">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-semibold truncate">{title}</span>
          {badge && <Tag tone="lime">{badge}</Tag>}
        </div>
        <Button kind={copied ? 'primary' : 'ghost'} onClick={copy} className="!py-1 !px-2.5 text-xs">
          {copied ? '✓ Скопировано' : 'Копировать'}
        </Button>
      </div>
      <pre
        className={`px-4 py-3 text-[13px] leading-relaxed whitespace-pre-wrap break-words sf-scroll max-h-80 overflow-y-auto ${
          mono ? 'font-mono' : 'font-sans'
        } text-ink/90`}
      >
        {text}
      </pre>
    </div>
  );
}

export function Empty({ icon, title, sub }: { icon: string; title: string; sub?: string }) {
  return (
    <div className="text-center py-14 px-6">
      <div className="text-4xl mb-3">{icon}</div>
      <div className="font-semibold">{title}</div>
      {sub && <div className="text-sm text-mut mt-1 max-w-md mx-auto">{sub}</div>}
    </div>
  );
}

export function ErrorNote({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm">
      <span className="text-danger shrink-0">⚠</span>
      <div className="flex-1 text-ink/90">{text}</div>
      {onRetry && (
        <Button kind="ghost" onClick={onRetry} className="!py-1 !px-2.5 text-xs shrink-0">
          Повторить
        </Button>
      )}
    </div>
  );
}
