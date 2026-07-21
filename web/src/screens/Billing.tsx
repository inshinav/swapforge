import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  BillingMethodsInfo,
  BillingProviderId,
  DollarBalanceInfo,
  DollarLedgerEntry,
  PaymentIntentInfo,
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

const PENDING_POLL_MAX_MS = 10 * 60_000;
const PENDING_POLL_DELAYS_MS = [3_000, 5_000, 8_000, 13_000, 21_000, 30_000] as const;

function money(value: number): string {
  return `${value < 0 ? '-$' : '$'}${Math.abs(value).toFixed(2)}`;
}

function rubles(value: number): string {
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value)} ₽`;
}

const ACTIVE_PAYMENT = new Set<PaymentIntentInfo['status']>(['creating', 'pending', 'paid']);

interface PendingPaymentHint {
  intentId: string;
  provider: BillingProviderId;
  amountUsd: number;
  startedAt: number;
}

function pendingPaymentKey(userId: string): string {
  return `sf-pending-payment:${userId}`;
}

function readPendingPaymentHint(userId: string): PendingPaymentHint | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(pendingPaymentKey(userId)) ?? 'null') as Partial<PendingPaymentHint> | null;
    if (
      parsed &&
      typeof parsed.intentId === 'string' &&
      (parsed.provider === 'cryptopay' || parsed.provider === 'lavatop') &&
      typeof parsed.amountUsd === 'number' &&
      typeof parsed.startedAt === 'number' &&
      Date.now() - parsed.startedAt < PENDING_POLL_MAX_MS
    ) {
      return parsed as PendingPaymentHint;
    }
  } catch {
    // The server remains the source of truth; a damaged local hint is disposable.
  }
  localStorage.removeItem(pendingPaymentKey(userId));
  return null;
}

function intentStartedAt(intent: PaymentIntentInfo): number {
  const parsed = Date.parse(intent.createdAt.includes('T') ? intent.createdAt : `${intent.createdAt.replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export default function Billing({
  userId,
  neededUsd,
  previewAsUser = false,
  onTestClient,
  onBackToSwap,
  onBalanceChange,
}: {
  userId: string;
  neededUsd: number | null;
  previewAsUser?: boolean;
  /** Владелец: пройти оплату по-настоящему из отдельного клиентского аккаунта. */
  onTestClient?: () => void;
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
  const [pending, setPending] = useState<PaymentIntentInfo | null>(null);
  const [paymentDone, setPaymentDone] = useState<number | null>(null);
  const [paymentTimedOut, setPaymentTimedOut] = useState(false);

  const reload = useCallback(async (): Promise<DollarBalanceInfo | null> => {
    try {
      const [b, l, m, payments] = await Promise.all([
        api.billingBalance(),
        api.billingLedger(),
        api.billingMethods(previewAsUser),
        api.billingPaymentIntents(),
      ]);
      setBalance(b);
      setLedger(l.entries);
      setMethods(m);
      const hint = readPendingPaymentHint(userId);
      setPending(
        payments.intents.find((intent) => ACTIVE_PAYMENT.has(intent.status) && intent.id === hint?.intentId) ??
          payments.intents.find((intent) => ACTIVE_PAYMENT.has(intent.status)) ??
          null,
      );
      onBalanceChange(b);
      setErr('');
      return b;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [onBalanceChange, previewAsUser, userId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!methods) return;
    const suggested = Math.max(methods.minTopupUsd, neededUsd ?? 0);
    setAmount(suggested.toFixed(2));
  }, [methods, neededUsd]);

  const checkPendingPayment = useCallback(async (): Promise<boolean> => {
    if (!pending) return false;
    try {
      const { intents } = await api.billingPaymentIntents();
      const current = pending.id
        ? intents.find((intent) => intent.id === pending.id)
        : intents.find(
            (intent) =>
              ACTIVE_PAYMENT.has(intent.status) &&
              intent.provider === pending.provider &&
              Math.abs(intent.amountUsd - pending.amountUsd) < 0.001,
          );
      if (!current) return false;
      setPending((previous) =>
        previous?.id === current.id &&
        previous.status === current.status &&
        previous.updatedAt === current.updatedAt
          ? previous
          : current,
      );
      if (current.status === 'credited') {
        localStorage.removeItem(pendingPaymentKey(userId));
        setPaymentDone(current.amountUsd);
        setPending(null);
        setPaymentTimedOut(false);
        void reload();
        return true;
      }
      if (!ACTIVE_PAYMENT.has(current.status)) {
        localStorage.removeItem(pendingPaymentKey(userId));
        setPending(null);
        setPaymentTimedOut(true);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, [pending, reload, userId]);

  useEffect(() => {
    if (!pending) return;
    let alive = true;
    let checking = false;
    let attempt = 0;
    let timer: number | null = null;

    const expire = () => {
      if (!alive) return;
      localStorage.removeItem(pendingPaymentKey(userId));
      setPending(null);
      setPaymentTimedOut(true);
    };
    const check = async () => {
      if (!alive || checking) return false;
      if (Date.now() - intentStartedAt(pending) >= PENDING_POLL_MAX_MS) {
        expire();
        return true;
      }
      checking = true;
      try {
        return await checkPendingPayment();
      } finally {
        checking = false;
      }
    };
    const schedule = () => {
      if (!alive) return;
      const remaining = PENDING_POLL_MAX_MS - (Date.now() - intentStartedAt(pending));
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
  }, [checkPendingPayment, pending, userId]);

  const amountUsd = Number(amount.replace(',', '.'));
  const amountError = useMemo(() => {
    if (!methods) return '';
    if (!Number.isFinite(amountUsd) || !/^\d+(?:[.,]\d{0,2})?$/.test(amount)) return 'Укажи сумму в долларах';
    if (amountUsd < methods.minTopupUsd) return `Минимум ${money(methods.minTopupUsd)}`;
    if (amountUsd > methods.maxTopupUsd) return `Максимум ${money(methods.maxTopupUsd)}`;
    return '';
  }, [amount, amountUsd, methods]);
  const lavaMethod = methods?.providers.find((provider) => provider.id === 'lavatop');
  const lavaAmountRub = !amountError && lavaMethod?.rubPerUsd
    ? Math.round(amountUsd * lavaMethod.rubPerUsd * 100) / 100
    : null;

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
    if (paymentTab !== null) paymentTab.opener = null;
    setBusy(provider);
    setErr('');
    try {
      const { payUrl } = await api.checkout(amountUsd, provider, email.trim() || undefined);
      const now = new Date();
      const hint: PaymentIntentInfo = {
        id: '',
        amountUsd,
        provider,
        status: 'pending',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt: null,
        creditedAt: null,
      };
      const next = await api
        .billingPaymentIntents()
        .then(({ intents }) =>
          intents.find(
            (intent) =>
              ACTIVE_PAYMENT.has(intent.status) &&
              intent.provider === provider &&
              Math.abs(intent.amountUsd - amountUsd) < 0.001,
          ) ?? hint,
        )
        .catch(() => hint);
      localStorage.setItem(
        pendingPaymentKey(userId),
        JSON.stringify({ intentId: next.id, provider, amountUsd, startedAt: Date.now() } satisfies PendingPaymentHint),
      );
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

          {previewAsUser && (
            <div className="rounded-xl border border-warn/35 bg-warn/5 px-4 py-3 text-sm space-y-2">
              <div>
                Ты владелец в режиме просмотра: пополнение отсюда уйдёт на баланс владельца и в работе
                не списывается. Чтобы пройти оплату и списания по-настоящему — включи тест-клиента.
              </div>
              {onTestClient && (
                <Button kind="primary" onClick={onTestClient}>🧪 Войти тест-клиентом</Button>
              )}
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
              <button type="button" onClick={() => void checkPendingPayment()} className="min-h-11 px-2 text-xs text-mut hover:text-lime">Проверить</button>
            </div>
          )}

          {paymentDone !== null && (
            <div className="rounded-xl border border-ok/35 bg-ok/5 px-4 py-3 flex items-center gap-3">
              <span className="text-sm font-semibold text-ok flex-1">Деньги пришли: +{money(paymentDone)}</span>
              <Button kind="primary" onClick={onBackToSwap}>К ролику</Button>
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
            {lavaAmountRub !== null && lavaMethod?.rubPerUsd && (
              <div className="text-xs text-mut">
                Картой / СБП: {rubles(lavaAmountRub)} · курс $1 = {rubles(lavaMethod.rubPerUsd)}
              </div>
            )}

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
                  {emailFor === provider.id
                    ? 'Продолжить'
                    : provider.id === 'lavatop' && lavaAmountRub !== null
                      ? `${PROVIDER_LABEL[provider.id]} · ${rubles(lavaAmountRub)}`
                      : PROVIDER_LABEL[provider.id]}
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
