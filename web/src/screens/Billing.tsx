// Баланс кредитов: пакеты (оплата криптой через Crypto Pay / картой через Lava.top),
// леджер, резервы. USD здесь не существует — юзер живёт в кредитах.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  BillingPacksInfo,
  BillingProviderId,
  CreditBalanceInfo,
  CreditLedgerEntry,
  CreditPackInfo,
} from '@shared/api-types';
import { api } from '../api';
import { Button, Card, Empty, ErrorNote, SectionTitle, Spinner, Tag } from '../ui';

const PROVIDER_LABEL: Record<BillingProviderId, string> = {
  cryptopay: '💎 Криптой',
  lavatop: '💳 Картой / СБП',
};

const KIND_LABEL: Record<
  CreditLedgerEntry['kind'],
  { label: string; tone: 'ok' | 'mut' | 'warn' | 'danger' }
> = {
  purchase: { label: 'пополнение', tone: 'ok' },
  charge: { label: 'списание', tone: 'mut' },
  refund: { label: 'возврат платежа', tone: 'warn' },
  adjust: { label: 'корректировка', tone: 'warn' },
};

const PENDING_PAYMENT_KEY = 'sf-pending-payment';
const PENDING_POLL_MAX_MS = 10 * 60_000;
const PENDING_POLL_DELAYS_MS = [3_000, 5_000, 8_000, 13_000, 21_000, 30_000] as const;

interface PendingPayment {
  packTitle: string;
  credits: number;
  provider: BillingProviderId;
  balanceBefore: number;
  startedAt: number;
}

function readPendingPayment(): PendingPayment | null {
  try {
    const raw = localStorage.getItem(PENDING_PAYMENT_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PendingPayment>;
    if (
      typeof p.packTitle === 'string' &&
      typeof p.credits === 'number' &&
      (p.provider === 'cryptopay' || p.provider === 'lavatop') &&
      typeof p.balanceBefore === 'number' &&
      typeof p.startedAt === 'number' &&
      Date.now() - p.startedAt < PENDING_POLL_MAX_MS
    ) {
      return p as PendingPayment;
    }
  } catch {
    // Повреждённое локальное состояние не должно ломать экран баланса.
  }
  localStorage.removeItem(PENDING_PAYMENT_KEY);
  return null;
}

export default function Billing({
  neededCredits,
  onBackToSwap,
  onBalanceChange,
}: {
  neededCredits: number | null;
  onBackToSwap: () => void;
  onBalanceChange: (balance: CreditBalanceInfo) => void;
}) {
  const [balance, setBalance] = useState<CreditBalanceInfo | null>(null);
  const [ledger, setLedger] = useState<CreditLedgerEntry[] | null>(null);
  const [packsInfo, setPacksInfo] = useState<BillingPacksInfo | null>(null);
  const [err, setErr] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [pending, setPending] = useState<PendingPayment | null>(readPendingPayment);
  const [paymentDone, setPaymentDone] = useState<number | null>(null);
  const [paymentTimedOut, setPaymentTimedOut] = useState(false);

  const reload = useCallback(async (): Promise<CreditBalanceInfo | null> => {
    setRefreshing(true);
    try {
      const [b, l, p] = await Promise.all([
        api.creditBalance(),
        api.creditLedger(),
        api.creditPacks(),
      ]);
      setBalance(b);
      setLedger(l.entries);
      setPacksInfo(p);
      onBalanceChange(b);
      setErr('');
      return b;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setRefreshing(false);
    }
  }, [onBalanceChange]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const checkPendingBalance = useCallback(async (): Promise<boolean> => {
    if (!pending) return false;
    try {
      const b = await api.creditBalance();
      setBalance(b);
      onBalanceChange(b);
      if (b.balance <= pending.balanceBefore) return false;
      setPaymentDone(b.balance - pending.balanceBefore);
      setPending(null);
      setPaymentTimedOut(false);
      localStorage.removeItem(PENDING_PAYMENT_KEY);
      void reload();
      return true;
    } catch {
      // Ошибка фоновой проверки не перекрывает экран: следующий шаг бэкоффа повторит запрос.
      return false;
    }
  }, [onBalanceChange, pending, reload]);

  // Пока пользователь залогинен и Billing смонтирован, проверяем только лёгкий balance endpoint:
  // сразу, по focus/visibility и затем с бэкоффом. Через десять минут фоновый опрос прекращается.
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
      if (remaining <= 0) {
        expire();
        return;
      }
      const delay = PENDING_POLL_DELAYS_MS[Math.min(attempt, PENDING_POLL_DELAYS_MS.length - 1)]!;
      attempt += 1;
      timer = window.setTimeout(() => {
        void check().then((done) => {
          if (!done) schedule();
        });
      }, Math.min(delay, remaining));
    };

    const onFocus = () => void check();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    void check().then((done) => {
      if (!done) schedule();
    });
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [checkPendingBalance, pending]);

  const packs = packsInfo?.packs ?? [];
  const needsEmail = new Set(
    packsInfo?.providers.filter((p) => p.needsEmail).map((p) => p.id) ?? [],
  );
  const recommendedPackId = useMemo(() => {
    if (!neededCredits) return null;
    return (
      packs
        .filter((p) => p.credits >= neededCredits)
        .slice()
        .sort((a, b) => a.credits - b.credits)[0]?.id ?? null
    );
  }, [neededCredits, packs]);

  const checkoutStarted = (
    pack: CreditPackInfo,
    provider: BillingProviderId,
    balanceBefore: number,
  ) => {
    const next: PendingPayment = {
      packTitle: pack.title,
      credits: pack.credits,
      provider,
      balanceBefore,
      startedAt: Date.now(),
    };
    localStorage.setItem(PENDING_PAYMENT_KEY, JSON.stringify(next));
    setPending(next);
    setPaymentDone(null);
    setPaymentTimedOut(false);
    setErr('');
  };

  return (
    <div className="space-y-4 sf-in">
      <Card glow>
        <SectionTitle
          title="Баланс"
          hint="кредиты списываются по факту рендера — смету видно до запуска"
        />
        <div className="p-4 sm:p-5 space-y-4">
          {err && <ErrorNote text={err} />}

          {neededCredits && (
            <div className="rounded-xl border border-lime/35 bg-lime/5 px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex-1">
                <div className="text-sm font-semibold">Для этого свапа не хватает {neededCredits} кредитов</div>
                <div className="text-xs text-mut mt-0.5">Подходящий пакет отмечен ниже — после оплаты вернись к запуску.</div>
              </div>
              <Button kind="ghost" className="w-full sm:w-auto" onClick={onBackToSwap}>
                ← Вернуться к свапу
              </Button>
            </div>
          )}

          {pending && (
            <div className="rounded-xl border border-warn/35 bg-warn/5 px-4 py-3 flex items-start gap-3">
              <Spinner size={16} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold">Ждём зачисление пакета «{pending.packTitle}»</div>
                <div className="text-xs text-mut mt-0.5">
                  Оплата открыта через {PROVIDER_LABEL[pending.provider]}. Баланс проверяется автоматически — обычно это занимает меньше минуты.
                </div>
              </div>
              <button type="button" onClick={() => void reload()} className="text-xs text-dim hover:text-lime shrink-0">
                проверить
              </button>
            </div>
          )}

          {paymentDone !== null && (
            <div className="rounded-xl border border-ok/35 bg-ok/5 px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex-1 text-sm font-semibold text-ok">✓ Кредиты пришли: +{paymentDone}</div>
              <Button kind="primary" className="w-full sm:w-auto" onClick={onBackToSwap}>
                Вернуться к свапу
              </Button>
            </div>
          )}

          {paymentTimedOut && (
            <div className="rounded-xl border border-line bg-panel2 px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex-1">
                <div className="text-sm font-semibold">Автопроверка остановлена</div>
                <div className="text-xs text-mut mt-0.5">
                  За 10 минут баланс не изменился. Если оплата прошла, обнови его вручную.
                </div>
              </div>
              <Button kind="ghost" className="w-full sm:w-auto" onClick={() => void reload()}>
                Обновить баланс
              </Button>
            </div>
          )}

          {balance === null ? (
            <Spinner />
          ) : (
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span className="text-3xl font-extrabold">
                {balance.available}{' '}
                <span className="text-base font-semibold text-mut">кредитов</span>
              </span>
              {balance.held > 0 && (
                <span className="text-sm text-warn">
                  + {balance.held} в резерве активных свапов (спишется по факту)
                </span>
              )}
              <button type="button" onClick={() => void reload()} className="text-xs text-dim hover:text-lime ml-auto">
                {refreshing ? '…' : '↻ обновить'}
              </button>
            </div>
          )}

          <div>
            <div className="text-sm font-semibold mb-2">Купить кредиты</div>
            {packs.length === 0 ? (
              <p className="text-sm text-mut">
                Пакеты сейчас недоступны — загляни позже или напиши владельцу сервиса.
              </p>
            ) : (
              <div className="grid sm:grid-cols-3 gap-2">
                {packs.map((p) => (
                  <PackCard
                    key={p.id}
                    pack={p}
                    needsEmail={needsEmail}
                    recommended={p.id === recommendedPackId}
                    balanceBefore={balance?.balance ?? 0}
                    onCheckoutStarted={checkoutStarted}
                    onError={setErr}
                  />
                ))}
              </div>
            )}
            <p className="text-[11px] text-dim mt-2">
              Точная цена каждого свапа видна перед запуском. После оплаты ничего обновлять вручную не нужно.
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <SectionTitle title="История" hint="все движения кредитов" />
        <div className="p-4 sm:p-5">
          {ledger === null ? (
            <Spinner />
          ) : ledger.length === 0 ? (
            <Empty icon="🧾" title="Пока пусто" sub="Первое пополнение появится здесь" />
          ) : (
            <ul className="divide-y divide-line text-sm">
              {ledger.map((e) => {
                const k = KIND_LABEL[e.kind];
                return (
                  <li key={e.id} className="py-3 flex items-start gap-3">
                    <Tag tone={k.tone}>{k.label}</Tag>
                    <div className="flex-1 min-w-0">
                      <div className="text-mut text-xs truncate" title={e.note}>{e.note || '—'}</div>
                      <div className="text-dim text-[11px] mt-0.5">{e.createdAt.slice(0, 16)}</div>
                    </div>
                    <span className={`font-mono font-semibold shrink-0 ${e.delta >= 0 ? 'text-ok' : 'text-ink'}`}>
                      {e.delta >= 0 ? `+${e.delta}` : e.delta}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="mt-3">
            <Button kind="ghost" className="!py-1 !px-2 text-xs" onClick={() => void reload()}>
              ↻ обновить
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

/** Карточка пакета: выбор способа оплаты → server-initiated checkout → редирект. */
function PackCard({
  pack,
  needsEmail,
  recommended,
  balanceBefore,
  onCheckoutStarted,
  onError,
}: {
  pack: CreditPackInfo;
  needsEmail: Set<BillingProviderId>;
  recommended: boolean;
  balanceBefore: number;
  onCheckoutStarted: (
    pack: CreditPackInfo,
    provider: BillingProviderId,
    balanceBefore: number,
  ) => void;
  onError: (e: string) => void;
}) {
  const [busy, setBusy] = useState<BillingProviderId | null>(null);
  const [emailFor, setEmailFor] = useState<BillingProviderId | null>(null);
  const [email, setEmail] = useState('');
  const [emailErr, setEmailErr] = useState('');

  const pay = async (provider: BillingProviderId) => {
    if (needsEmail.has(provider) && emailFor !== provider) {
      setEmailFor(provider);
      setEmailErr('');
      return;
    }
    if (needsEmail.has(provider) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setEmailErr('Введи корректный email для чека');
      return;
    }

    // Открываем вкладку синхронно по пользовательскому клику: после await мобильный
    // браузер уже считает window.open попапом. Если вкладка всё же заблокирована,
    // ниже уйдём на оплату в текущей.
    const paymentTab = window.open('', '_blank');
    setBusy(provider);
    onError('');
    setEmailErr('');
    try {
      const { payUrl } = await api.checkout(pack.id, provider, email.trim() || undefined);
      onCheckoutStarted(pack, provider, balanceBefore);
      if (paymentTab === null) window.location.href = payUrl;
      else paymentTab.location = payUrl;
      setEmailFor(null);
    } catch (e) {
      paymentTab?.close();
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const emailId = `billing-email-${pack.id}`;
  return (
    <div className={`rounded-xl border bg-panel2 px-4 py-3 flex flex-col ${recommended ? 'border-lime/60 shadow-[0_0_24px_-16px_rgba(198,242,78,0.7)]' : 'border-line'}`}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold">{pack.title}</div>
          <div className="text-2xl font-extrabold text-lime">{pack.credits}</div>
        </div>
        {recommended && <Tag tone="lime">покроет нехватку</Tag>}
      </div>
      <div className="text-xs text-mut mb-3">кредитов · {pack.priceLabel}</div>

      {emailFor && needsEmail.has(emailFor) && (
        <div className="mb-3 rounded-lg border border-line bg-panel px-3 py-2.5">
          <div className="flex items-center gap-2 mb-1.5">
            <label htmlFor={emailId} className="text-xs font-semibold">Email для чека</label>
            <button type="button" className="text-[11px] text-dim hover:text-ink ml-auto" onClick={() => setEmailFor(null)}>
              отмена
            </button>
          </div>
          <input
            id={emailId}
            autoFocus
            type="email"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@example.com"
            className="w-full min-h-10 rounded-lg bg-panel2 border border-line px-2.5 py-2 text-sm outline-none focus:border-lime/50"
          />
          <p className="text-[11px] text-dim mt-1.5">Lava.top отправит сюда кассовый чек. Для входа email не используется.</p>
          {emailErr && <p className="text-[11px] text-danger mt-1">{emailErr}</p>}
        </div>
      )}

      <div className="flex flex-col gap-2 mt-auto">
        {pack.pay.length === 0 && <span className="text-[11px] text-dim">оплата недоступна</span>}
        {pack.pay.map((provider) => {
          const continuing = provider === emailFor && needsEmail.has(provider);
          return (
            <Button
              key={provider}
              kind={continuing ? 'primary' : 'ghost'}
              busy={busy === provider}
              className="min-h-11 !px-2 text-xs w-full"
              onClick={() => void pay(provider)}
            >
              {continuing ? 'Продолжить — картой / СБП' : PROVIDER_LABEL[provider]}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
