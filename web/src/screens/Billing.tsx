// Баланс кредитов: пакеты (оплата криптой через Crypto Pay / картой через Lava.top),
// леджер, резервы. USD здесь не существует — юзер живёт в кредитах.
import { useCallback, useEffect, useState } from 'react';
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

const KIND_LABEL: Record<CreditLedgerEntry['kind'], { label: string; tone: 'ok' | 'mut' | 'warn' | 'danger' }> = {
  purchase: { label: 'пополнение', tone: 'ok' },
  charge: { label: 'списание', tone: 'mut' },
  refund: { label: 'возврат платежа', tone: 'warn' },
  adjust: { label: 'корректировка', tone: 'warn' },
};

export default function Billing() {
  const [balance, setBalance] = useState<CreditBalanceInfo | null>(null);
  const [ledger, setLedger] = useState<CreditLedgerEntry[] | null>(null);
  const [packsInfo, setPacksInfo] = useState<BillingPacksInfo | null>(null);
  const [err, setErr] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const reload = useCallback(() => {
    setRefreshing(true);
    Promise.all([api.creditBalance(), api.creditLedger(), api.creditPacks()])
      .then(([b, l, p]) => {
        setBalance(b);
        setLedger(l.entries);
        setPacksInfo(p);
        setErr('');
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setRefreshing(false));
  }, []);

  useEffect(reload, [reload]);

  const packs = packsInfo?.packs ?? [];
  const needsEmail = new Set(packsInfo?.providers.filter((p) => p.needsEmail).map((p) => p.id) ?? []);

  return (
    <div className="space-y-4 sf-in">
      <Card glow>
        <SectionTitle title="Баланс" hint="кредиты списываются по факту рендера — смету видно до запуска" />
        <div className="p-5 space-y-4">
          {err && <ErrorNote text={err} onRetry={reload} />}
          {balance === null ? (
            <Spinner />
          ) : (
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span className="text-3xl font-extrabold">
                {balance.available} <span className="text-base font-semibold text-mut">кредитов</span>
              </span>
              {balance.held > 0 && (
                <span className="text-sm text-warn">
                  + {balance.held} в резерве активных свапов (спишется по факту)
                </span>
              )}
              <button type="button" onClick={reload} className="text-xs text-dim hover:text-lime ml-auto">
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
                  <PackCard key={p.id} pack={p} needsEmail={needsEmail} onDone={reload} onError={setErr} />
                ))}
              </div>
            )}
            <p className="text-[11px] text-dim mt-2">
              После оплаты кредиты придут в течение минуты — нажми «обновить».
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <SectionTitle title="История" hint="все движения кредитов" />
        <div className="p-5">
          {ledger === null ? (
            <Spinner />
          ) : ledger.length === 0 ? (
            <Empty icon="🧾" title="Пока пусто" sub="Первое пополнение появится здесь" />
          ) : (
            <ul className="divide-y divide-line text-sm">
              {ledger.map((e) => {
                const k = KIND_LABEL[e.kind];
                return (
                  <li key={e.id} className="py-2 flex items-center gap-3">
                    <Tag tone={k.tone}>{k.label}</Tag>
                    <span className="text-mut text-xs flex-1 truncate" title={e.note}>
                      {e.note || '—'}
                    </span>
                    <span className={`font-mono font-semibold ${e.delta >= 0 ? 'text-ok' : 'text-ink'}`}>
                      {e.delta >= 0 ? `+${e.delta}` : e.delta}
                    </span>
                    <span className="text-dim text-[11px] w-32 text-right">{e.createdAt.slice(0, 16)}</span>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="mt-3">
            <Button kind="ghost" className="!py-1 !px-2 text-xs" onClick={reload}>
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
  onDone,
  onError,
}: {
  pack: CreditPackInfo;
  needsEmail: Set<BillingProviderId>;
  onDone: () => void;
  onError: (e: string) => void;
}) {
  const [busy, setBusy] = useState<BillingProviderId | null>(null);
  const [emailFor, setEmailFor] = useState<BillingProviderId | null>(null);
  const [email, setEmail] = useState('');

  const pay = async (provider: BillingProviderId) => {
    if (needsEmail.has(provider) && !email.trim() && emailFor !== provider) {
      setEmailFor(provider); // сначала показать поле email
      return;
    }
    setBusy(provider);
    onError('');
    try {
      const { payUrl } = await api.checkout(pack.id, provider, email.trim() || undefined);
      window.open(payUrl, '_blank', 'noopener');
      setEmailFor(null);
      onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-xl border border-line bg-panel2 px-4 py-3 flex flex-col">
      <div className="text-sm font-semibold">{pack.title}</div>
      <div className="text-2xl font-extrabold text-lime">{pack.credits}</div>
      <div className="text-xs text-mut mb-2">кредитов · {pack.priceLabel}</div>

      {emailFor && needsEmail.has(emailFor) && (
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="email для чека"
          className="mb-2 rounded-lg bg-panel border border-line px-2 py-1 text-xs outline-none focus:border-lime/50"
        />
      )}

      <div className="flex flex-col gap-1.5 mt-auto">
        {pack.pay.length === 0 && <span className="text-[11px] text-dim">оплата недоступна</span>}
        {pack.pay.map((provider) => (
          <Button
            key={provider}
            kind="ghost"
            busy={busy === provider}
            className="!py-1.5 !px-2 text-xs"
            onClick={() => void pay(provider)}
          >
            {PROVIDER_LABEL[provider]}
          </Button>
        ))}
      </div>
    </div>
  );
}
