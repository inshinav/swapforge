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
      Date.now() - p.startedAt < 24 * 60 * 60_000
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

  // Вебхук обычно приходит за секунды. Проверяем баланс автоматически, а также сразу
  // после возврата фокуса с платёжной вкладки/Telegram.
  useEffect(() => {
    if (!pending) return;
    let alive = true;
    const check = async () => {
      const b = await reload();
      if (!alive || !b || b.balance <= pending.balanceBefore) return;
      setPaymentDone(b.balance - pending.balanceBefore);
      setPending(null);
      localStorage.removeItem(PENDING_PAYMENT_KEY);
    };
    const onFocus = () => void check();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    void check();
    const timer = window.setInterval(() => void check(), 3_000);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [pending, reload]);

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
    const paymentTab = window.open('about:blank', '_blank');
    if (paymentTab) paymentTab.opener = null;
    setBusy(provider);
    onError('');
    setEmailErr('');
    try {
      const { payUrl } = await api.checkout(pack.id, provider, email.trim() || undefined);
      onCheckoutStarted(pack, provider, balanceBefore);
      if (paymentTab && !paymentTab.closed) paymentTab.location.replace(payUrl);
      else window.location.assign(payUrl);
      setEmailFor(null);
    } catch (e) {
      if (paymentTab && !paymentTab.closed) paymentTab.close();
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
