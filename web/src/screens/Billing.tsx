import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  BillingMethodsInfo,
  BillingProviderId,
  DollarBalanceInfo,
  DollarLedgerEntry,
} from '@shared/api-types';
import { api } from '../api';
import { Button, Card, ErrorNote, SectionTitle, Spinner, Tag } from '../ui';

const PROVIDER_LABEL: Record<BillingProviderId, string> = {
  cryptopay: 'Криптой',
  lavatop: 'Картой / СБП',
};

const KIND_LABEL: Record<
  DollarLedgerEntry['kind'],
  { label: string; tone: 'ok' | 'mut' | 'warn' }
> = {
  purchase: { label: 'пополнение', tone: 'ok' },
  charge: { label: 'списание', tone: 'mut' },
  refund: { label: 'возврат', tone: 'warn' },
  adjust: { label: 'корректировка', tone: 'warn' },
};

const PENDING_PAYMENT_KEY = 'sf-pending-payment';
const PENDING_POLL_MAX_MS = 10 * 60_000;
const PENDING_POLL_DELAYS_MS = [3_000, 5_000, 8_000, 13_000, 21_000, 30_000] as const;

interface PendingPayment {
  amountUsd: number;
  provider: BillingProviderId;
  balanceBeforeUsd: number;
  startedAt: number;
}

function money(value: number): string {
  return `${value < 0 ? '-$' : '$'}${Math.abs(value).toFixed(2)}`;
}

function readPendingPayment(): PendingPayment | null {
  try {
    const raw = localStorage.getItem(PENDING_PAYMENT_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PendingPayment>;
    if (
      typeof p.amountUsd === 'number' &&
      (p.provider === 'cryptopay' || p.provider === 'lavatop') &&
      typeof p.balanceBeforeUsd === 'number' &&
      typeof p.startedAt === 'number' &&
      Date.now() - p.startedAt < PENDING_POLL_MAX_MS
    ) {
      return p as PendingPayment;
    }
  } catch {
    // Повреждённое локальное состояние просто сбрасываем.
  }
  localStorage.removeItem(PENDING_PAYMENT_KEY);
  return null;
}

export default function Billing({
  neededUsd,
  onBackToSwap,
  onBalanceChange,
}: {
  neededUsd: number | null;
  onBackToSwap: () => void;
  onBalanceChange: (balance: DollarBalanceInfo) => void;
}) {
  const [balance, setBalance] = useState<DollarBalanceInfo | null>(null);
  const [ledger, setLedger] = useState<DollarLedgerEntry[] | null>(null);
  const [methods, setMethods] = useState<BillingMethodsInfo | null>(null);
  const [amount, setAmount] = useState('5.00');
  const [emailFor, setEmailFor] = useState<BillingProviderId | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState<BillingProviderId | null>(null);
  const [err, setErr] = useState('');
  const [pending, setPending] = useState<PendingPayment | null>(readPendingPayment);
  const [paymentDone, setPaymentDone] = useState<number | null>(null);
  const [paymentTimedOut, setPaymentTimedOut] = useState(false);

  const reload = useCallback(async (): Promise<DollarBalanceInfo | null> => {
    try {
      const [b, l, m] = await Promise.all([
        api.billingBalance(),
        api.billingLedger(),
        api.billingMethods(),
      ]);
      setBalance(b);
      setLedger(l.entries);
      setMethods(m);
      onBalanceChange(b);
      setErr('');
      return b;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [onBalanceChange]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!methods) return;
    const suggested = Math.max(methods.minTopupUsd, neededUsd ?? 0);
    setAmount(suggested.toFixed(2));
  }, [methods, neededUsd]);

  const checkPendingBalance = useCallback(async (): Promise<boolean> => {
    if (!pending) return false;
    try {
      const b = await api.billingBalance();
      setBalance(b);
      onBalanceChange(b);
      if (b.balanceUsd <= pending.balanceBeforeUsd) return false;
      setPaymentDone(b.balanceUsd - pending.balanceBeforeUsd);
      setPending(null);
      setPaymentTimedOut(false);
      localStorage.removeItem(PENDING_PAYMENT_KEY);
      void reload();
      return true;
    } catch {
      return false;
    }
  }, [onBalanceChange, pending, reload]);

  useEffect(() => {
    if (!pending) return;
    let alive = true;
    let checking = false;
    let attempt = 0;
    let timer: number | null = null;

    const expire = () => {
      if (!alive) return;
      localStorage.removeItem(PENDING_PAYMENT_KEY);
      setPending(null);
      setPaymentTimedOut(true);
    };
    const check = async () => {
      if (!alive || checking) return false;
      if (Date.now() - pending.startedAt >= PENDING_POLL_MAX_MS) {
        expire();
        return true;
      }
      checking = true;
      try {
        return await checkPendingBalance();
      } finally {
        checking = false;
      }
    };
    const schedule = () => {
      if (!alive) return;
      const remaining = PENDING_POLL_MAX_MS - (Date.now() - pending.startedAt);
      if (remaining <= 0) return expire();
      const delay = PENDING_POLL_DELAYS_MS[Math.min(attempt++, PENDING_POLL_DELAYS_MS.length - 1)]!;
      timer = window.setTimeout(() => void check().then((done) => !done && schedule()), Math.min(delay, remaining));
    };
    const onFocus = () => void check();
    const onVisible = () => document.visibilityState === 'visible' && void check();
    void check().then((done) => !done && schedule());
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [checkPendingBalance, pending]);

  const amountUsd = Number(amount.replace(',', '.'));
  const amountError = useMemo(() => {
    if (!methods) return '';
    if (!Number.isFinite(amountUsd) || !/^\d+(?:[.,]\d{0,2})?$/.test(amount)) return 'Укажи сумму в долларах';
    if (amountUsd < methods.minTopupUsd) return `Минимум ${money(methods.minTopupUsd)}`;
    if (amountUsd > methods.maxTopupUsd) return `Максимум ${money(methods.maxTopupUsd)}`;
    return '';
  }, [amount, amountUsd, methods]);

  const pay = async (provider: BillingProviderId) => {
    const needsEmail = methods?.providers.find((p) => p.id === provider)?.needsEmail ?? false;
    if (needsEmail && emailFor !== provider) {
      setEmailFor(provider);
      setErr('');
      return;
    }
    if (amountError) return setErr(amountError);
    if (needsEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return setErr('Укажи email для чека');
    }

    // Вкладка резервируется прямо в click-handler, иначе мобильный браузер заблокирует её после await.
    const paymentTab = window.open('', '_blank');
    setBusy(provider);
    setErr('');
    try {
      const { payUrl } = await api.checkout(amountUsd, provider, email.trim() || undefined);
      const next: PendingPayment = {
        amountUsd,
        provider,
        balanceBeforeUsd: balance?.balanceUsd ?? 0,
        startedAt: Date.now(),
      };
      localStorage.setItem(PENDING_PAYMENT_KEY, JSON.stringify(next));
      setPending(next);
      setPaymentDone(null);
      setPaymentTimedOut(false);
      setEmailFor(null);
      if (paymentTab === null) window.location.href = payUrl;
      else paymentTab.location = payUrl;
    } catch (e) {
      paymentTab?.close();
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3 sf-in max-w-2xl mx-auto">
      <Card glow>
        <SectionTitle title="Баланс" />
        <div className="p-4 sm:p-6 space-y-5">
          {balance === null ? (
            <Spinner />
          ) : (
            <div>
              <div className="text-4xl font-extrabold tracking-tight">{money(balance.availableUsd)}</div>
              {balance.heldUsd > 0 && <div className="text-xs text-mut mt-1">{money(balance.heldUsd)} зарезервировано</div>}
            </div>
          )}

          {neededUsd && (
            <div className="rounded-xl border border-lime/35 bg-lime/5 px-4 py-3 text-sm">
              Для запуска не хватает {money(neededUsd)}
            </div>
          )}

          {pending && (
            <div className="rounded-xl border border-warn/35 bg-warn/5 px-4 py-3 flex items-center gap-3">
              <Spinner size={16} />
              <span className="text-sm flex-1">Ждём зачисление {money(pending.amountUsd)}</span>
              <button type="button" onClick={() => void checkPendingBalance()} className="min-h-11 px-2 text-xs text-mut hover:text-lime">Проверить</button>
            </div>
          )}

          {paymentDone !== null && (
            <div className="rounded-xl border border-ok/35 bg-ok/5 px-4 py-3 flex items-center gap-3">
              <span className="text-sm font-semibold text-ok flex-1">Деньги пришли: +{money(paymentDone)}</span>
              <Button kind="primary" onClick={onBackToSwap}>К свапу</Button>
            </div>
          )}

          {paymentTimedOut && <div className="text-sm text-mut">Зачисление ещё не видно. Обнови баланс позже.</div>}
          {err && <ErrorNote text={err} />}

          <div className="space-y-3">
            <label htmlFor="topup-amount" className="block text-sm font-semibold">Сумма пополнения</label>
            <div className="relative">
              <span className="absolute left-4 inset-y-0 flex items-center text-xl text-mut">$</span>
              <input
                id="topup-amount"
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ''))}
                className="w-full min-h-14 rounded-xl bg-panel2 border border-line pl-9 pr-4 py-3 text-xl font-semibold outline-none focus:border-lime/60"
                aria-describedby="topup-limit"
              />
            </div>
            <div id="topup-limit" className={amountError ? 'text-xs text-danger' : 'text-xs text-dim'}>
              {amountError || `От ${money(methods?.minTopupUsd ?? 5)}`}
            </div>

            {emailFor && (
              <input
                autoFocus
                type="email"
                inputMode="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email для чека"
                className="w-full min-h-12 rounded-xl bg-panel2 border border-line px-4 py-3 text-sm outline-none focus:border-lime/60"
              />
            )}

            <div className="grid sm:grid-cols-2 gap-2">
              {methods?.providers.map((provider) => (
                <Button
                  key={provider.id}
                  kind={emailFor === provider.id ? 'primary' : 'ghost'}
                  busy={busy === provider.id}
                  className="min-h-12 w-full"
                  onClick={() => void pay(provider.id)}
                >
                  {emailFor === provider.id ? 'Продолжить' : PROVIDER_LABEL[provider.id]}
                </Button>
              ))}
            </div>
            {methods && methods.providers.length === 0 && <div className="text-sm text-mut">Оплата временно недоступна</div>}
          </div>
        </div>
      </Card>

      <details className="rounded-xl border border-line bg-panel">
        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold">История</summary>
        <div className="border-t border-line px-4">
          {ledger === null ? <div className="py-4"><Spinner /></div> : ledger.length === 0 ? (
            <div className="py-4 text-sm text-mut">Пока пусто</div>
          ) : (
            <ul className="divide-y divide-line">
              {ledger.map((entry) => {
                const kind = KIND_LABEL[entry.kind];
                return (
                  <li key={entry.id} className="py-3 flex items-center gap-3 text-sm">
                    <Tag tone={kind.tone}>{kind.label}</Tag>
                    <span className="text-xs text-dim flex-1">{entry.createdAt.slice(0, 10)}</span>
                    <span className={entry.deltaUsd >= 0 ? 'font-semibold text-ok' : 'font-semibold'}>
                      {entry.deltaUsd >= 0 ? '+' : ''}{money(entry.deltaUsd)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </details>
    </div>
  );
}
