import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AdminOverview,
  AdminUserOverview,
  BillingHealthInfo,
  PricingInfo,
  UsageSummary,
} from '@shared/api-types';
import { api } from '../api';
import { Button, Card, ErrorNote, SectionTitle, Spinner, Tag } from '../ui';

interface PendingRequest {
  fingerprint: string;
  requestId: string;
}

const fieldClass =
  'w-full min-h-11 rounded-xl border border-line2 bg-panel2 px-3 py-2.5 text-sm text-ink outline-none focus:border-lime/60';

const ACTIVE_LABELS: Record<string, string> = {
  queued: 'В очереди',
  uploading_assets: 'Загружает файлы',
  submitted: 'Запускает ролик',
  rendering: 'Генерирует ролик',
  downloading: 'Сохраняет результат',
  storyboarding: 'Разбирает видео',
  analyzing: 'Анализирует сцену',
  generating: 'Готовит промпт',
  startframing: 'Делает стартовый кадр',
};

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

function activity(user: AdminUserOverview): { label: string; tone: 'mut' | 'lime' | 'warn' | 'danger' | 'ok' } {
  if (user.status === 'blocked') return { label: 'Заблокирован', tone: 'danger' };
  const active = ACTIVE_LABELS[user.latestGenerationStatus ?? ''] ?? ACTIVE_LABELS[user.latestProjectStatus ?? ''];
  if (user.activeRenders > 0 || active) return { label: active ?? 'Работает', tone: 'lime' };
  if (user.latestGenerationStatus === 'failed') return { label: 'Ошибка ролика', tone: 'danger' };
  if (user.latestGenerationStatus === 'done') return { label: 'Ролик готов', tone: 'ok' };
  if (user.projects > 0) return { label: 'Создаёт проект', tone: 'warn' };
  return { label: 'Зарегистрирован', tone: 'mut' };
}

function parseDate(value: string): number {
  return Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
}

function ago(value: string | null): string {
  if (!value) return 'не входил';
  const seconds = Math.max(0, Math.floor((Date.now() - parseDate(value)) / 1000));
  if (seconds < 60) return 'сейчас';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} мин назад`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} ч назад`;
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)} дн назад`;
  return new Date(parseDate(value)).toLocaleDateString('ru-RU');
}

function Stat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-panel2 px-3 py-3 min-w-0">
      <div className={`text-xl font-extrabold truncate ${accent ? 'text-lime' : ''}`}>{value}</div>
      <div className="text-[11px] text-dim mt-0.5 truncate">{label}</div>
    </div>
  );
}

const OPENAI_BALANCE_URL = 'https://platform.openai.com/settings/organization/billing/credit-grants';

export default function Admin({
  pricing,
  usage,
}: {
  pricing: PricingInfo | null;
  usage: UsageSummary | null;
}) {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [overviewError, setOverviewError] = useState('');
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState<AdminUserOverview | null>(null);
  const [amount, setAmount] = useState('5.00');
  const [note, setNote] = useState('Оплата напрямую');
  const [topupBusy, setTopupBusy] = useState(false);
  const [topupError, setTopupError] = useState('');
  const [success, setSuccess] = useState('');
  const pendingRequest = useRef<PendingRequest | null>(null);

  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    else setRefreshing(true);
    try {
      const next = await api.adminOverview();
      setOverview(next);
      setOverviewError('');
      setTarget((current) => next.users.find((user) => user.id === current?.id) ?? null);
    } catch (e) {
      setOverviewError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
    const timer = window.setInterval(() => void load(), 10_000);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [load]);

  const filteredUsers = useMemo(() => {
    const q = search.trim().replace(/^@/, '').toLocaleLowerCase('ru-RU');
    if (!q) return overview?.users ?? [];
    return (overview?.users ?? []).filter((user) =>
      [user.username, user.firstName, String(user.telegramId)].some((value) =>
        value.toLocaleLowerCase('ru-RU').includes(q),
      ),
    );
  }, [overview, search]);

  const amountUsd = Number(amount.replace(',', '.'));
  const amountError =
    !Number.isFinite(amountUsd) ||
    amountUsd <= 0 ||
    amountUsd > 10_000 ||
    Math.abs(amountUsd * 100 - Math.round(amountUsd * 100)) > 1e-7;

  const chooseTarget = (user: AdminUserOverview) => {
    setTarget(user);
    setAmount('5.00');
    setNote('Оплата напрямую');
    setTopupError('');
    setSuccess('');
    pendingRequest.current = null;
  };

  const topup = async () => {
    if (!target || amountError) return;
    const normalizedAmount = Math.round(amountUsd * 100) / 100;
    const fingerprint = `${target.id}:${normalizedAmount.toFixed(2)}:${note.trim()}`;
    const requestId = pendingRequest.current?.fingerprint === fingerprint
      ? pendingRequest.current.requestId
      : crypto.randomUUID();
    pendingRequest.current = { fingerprint, requestId };
    setTopupBusy(true);
    setTopupError('');
    setSuccess('');
    try {
      const result = await api.ownerManualTopup({
        userId: target.id,
        amountUsd: normalizedAmount,
        note: note.trim(),
        requestId,
      });
      setSuccess(
        result.replayed
          ? `Уже начислено. Баланс @${result.user.username}: ${money(result.user.balance.availableUsd)}`
          : `Готово: +${money(normalizedAmount)} для @${result.user.username}`,
      );
      pendingRequest.current = null;
      await load();
    } catch (e) {
      setTopupError(e instanceof Error ? e.message : String(e));
    } finally {
      setTopupBusy(false);
    }
  };

  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      <Card>
        <SectionTitle
          title="Админ"
          hint={overview ? `обновлено ${ago(overview.generatedAt)}` : 'пользователи и активность'}
          right={
            <Button kind="ghost" busy={refreshing} disabled={loading} onClick={() => void load()} className="shrink-0">
              Обновить
            </Button>
          }
        />
        <div className="p-4 sm:p-5 space-y-4">
          {loading && overview === null ? (
            <div className="flex justify-center py-10"><Spinner /></div>
          ) : overview && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                <Stat label="пользователей" value={String(overview.summary.users)} />
                <Stat label="на балансах" value={money(overview.summary.totalBalanceUsd)} accent />
                <Stat label="зарезервировано" value={money(overview.summary.heldUsd)} />
                <Stat label="сейчас в работе" value={String(overview.summary.activeRenders)} accent={overview.summary.activeRenders > 0} />
                <Stat label="готовых роликов" value={String(overview.summary.completedRenders)} />
              </div>
              <div className="grid sm:grid-cols-2 gap-2" aria-label="Мои балансы AI-провайдеров">
                <div className="rounded-xl border border-line bg-panel2 px-3 py-3 min-w-0">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-xs font-bold text-ink">OpenAI</div>
                    <a
                      href={OPENAI_BALANCE_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] font-semibold text-lime hover:text-lime-dim shrink-0"
                    >
                      Точный баланс ↗
                    </a>
                  </div>
                  <div className="text-xl font-extrabold mt-1">
                    {usage ? money(usage.openaiUsd) : '—'}
                  </div>
                  <div className="text-[11px] text-dim mt-0.5">
                    расходы SwapForge за текущий месяц
                  </div>
                </div>
                <div className="rounded-xl border border-line bg-panel2 px-3 py-3 min-w-0">
                  <div className="text-xs font-bold text-ink">WaveSpeed</div>
                  <div className={`text-xl font-extrabold mt-1 ${
                    pricing?.balanceUsd !== null && pricing?.balanceUsd !== undefined && pricing.balanceUsd < 2
                      ? 'text-warn'
                      : ''
                  }`}>
                    {pricing?.balanceUsd !== null && pricing?.balanceUsd !== undefined
                      ? money(pricing.balanceUsd)
                      : '—'}
                  </div>
                  <div className="text-[11px] text-dim mt-0.5">текущий баланс рендеров</div>
                </div>
              </div>
              <div
                role="status"
                aria-live="polite"
                className={`rounded-xl border px-3 py-2 text-xs ${
                  overview.operations.alerts.length
                    ? 'border-warn/40 bg-warn/5 text-warn'
                    : 'border-ok/30 bg-ok/5 text-ok'
                }`}
              >
                {overview.operations.alerts.length
                  ? overview.operations.alerts.join(' · ')
                  : `Система в норме · платежей в ожидании ${overview.operations.pendingPayments} · диск ${overview.operations.diskUsedPct}%`}
              </div>
            </div>
          )}

          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Найти по @нику, имени или Telegram ID"
            autoCapitalize="none"
            autoCorrect="off"
            className={fieldClass}
          />
          {overviewError && <ErrorNote text={overviewError} onRetry={() => void load()} />}
        </div>
      </Card>

      <BillingOps />

      <Card>
        <SectionTitle
          title="Пользователи"
          hint={overview ? `${filteredUsers.length} из ${overview.users.length}` : undefined}
        />
        <div className="divide-y divide-line">
          {!loading && filteredUsers.length === 0 && (
            <div className="p-8 text-center text-sm text-mut">Никого не найдено</div>
          )}
          {filteredUsers.map((user) => {
            const state = activity(user);
            const selected = target?.id === user.id;
            return (
              <article key={user.id} className="p-4 sm:p-5 space-y-3">
                <div className="flex items-start gap-3 min-w-0">
                  {user.photoUrl ? (
                    <img src={user.photoUrl} alt="" className="w-10 h-10 rounded-full object-cover border border-line2 shrink-0" />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-panel2 border border-line2 flex items-center justify-center font-bold shrink-0">
                      {(user.firstName || user.username || '?').slice(0, 1).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold truncate">{user.firstName || `@${user.username}`}</div>
                    <div className="text-xs text-mut truncate">
                      {user.username ? `@${user.username} · ` : ''}ID {user.telegramId}
                    </div>
                  </div>
                  <div className="flex flex-wrap justify-end gap-1.5 min-w-0">
                    <Tag tone={state.tone}>{state.label}</Tag>
                    <Tag tone={user.balance.availableUsd > 0 ? 'lime' : 'mut'}>
                      {money(user.balance.availableUsd)}
                    </Tag>
                    {user.balance.heldUsd > 0 && <Tag tone="warn">резерв {money(user.balance.heldUsd)}</Tag>}
                  </div>
                </div>

                <div className="grid grid-cols-4 gap-2 text-center">
                  <div><div className="font-bold text-sm">{user.projects}</div><div className="text-[10px] text-dim">проектов</div></div>
                  <div><div className="font-bold text-sm">{user.models}</div><div className="text-[10px] text-dim">моделей</div></div>
                  <div><div className="font-bold text-sm">{user.renders}</div><div className="text-[10px] text-dim">запусков</div></div>
                  <div><div className="font-bold text-sm">{user.doneRenders}</div><div className="text-[10px] text-dim">готово</div></div>
                </div>

                <div className="flex flex-col sm:flex-row sm:items-center gap-2 text-xs text-mut min-w-0">
                  <span className="truncate flex-1">
                    {user.latestProjectTitle ? `Последний проект: ${user.latestProjectTitle}` : 'Проектов пока нет'}
                  </span>
                  <span className="shrink-0">Активность: {ago(user.lastActivityAt)}</span>
                  <span className="shrink-0">Вход: {ago(user.lastLoginAt)}</span>
                  <Button
                    kind={selected ? 'primary' : 'ghost'}
                    onClick={() => selected ? setTarget(null) : chooseTarget(user)}
                    className="sm:ml-1 shrink-0"
                  >
                    {selected ? 'Закрыть' : 'Начислить'}
                  </Button>
                </div>

                {selected && (
                  <div className="rounded-xl border border-lime/30 bg-lime/5 p-3 sm:p-4 space-y-3">
                    <div className="text-sm font-semibold">
                      Начислить {user.username ? `@${user.username}` : `ID ${user.telegramId}`}
                      <span className="text-mut font-normal"> · сейчас {money(target.balance.availableUsd)}</span>
                    </div>
                    <div className="grid sm:grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label htmlFor={`amount-${user.id}`} className="text-xs text-mut">Сумма, $</label>
                        <input
                          id={`amount-${user.id}`}
                          value={amount}
                          onChange={(e) => {
                            setAmount(e.target.value.replace(/[^\d.,]/g, ''));
                            setSuccess('');
                          }}
                          inputMode="decimal"
                          className={fieldClass}
                        />
                        {amountError && <div className="text-[11px] text-danger">От $0.01 до $10 000, максимум 2 знака</div>}
                      </div>
                      <div className="space-y-1">
                        <label htmlFor={`note-${user.id}`} className="text-xs text-mut">Комментарий</label>
                        <input
                          id={`note-${user.id}`}
                          value={note}
                          onChange={(e) => {
                            setNote(e.target.value);
                            setSuccess('');
                          }}
                          maxLength={180}
                          className={fieldClass}
                        />
                      </div>
                    </div>
                    <Button kind="primary" busy={topupBusy} disabled={amountError} onClick={() => void topup()} className="w-full sm:w-auto">
                      Начислить {amountError ? '' : money(Math.round(amountUsd * 100) / 100)}
                    </Button>
                    {topupError && <ErrorNote text={topupError} />}
                    {success && <div className="text-sm text-ok">{success}</div>}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </Card>
    </div>
  );
}

// ── Оплата: живой health-check провайдеров + застрявшие счета ───────────────

const PROVIDER_RU: Record<string, string> = { cryptopay: 'Крипта (Crypto Pay)', lavatop: 'Карта / СБП (Lava.top)' };
const INTENT_STATUS_RU: Record<string, string> = {
  creating: 'создаётся',
  pending: 'ждёт оплаты',
  paid: 'оплачен, не зачислен',
  credited: 'зачислен',
  expired: 'истёк',
  cancelled: 'отменён',
  failed: 'не удался',
  quarantined: 'в карантине',
};
const EVENT_OUTCOME_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'mut'> = {
  credited: 'ok',
  replay: 'mut',
  ignored: 'mut',
  received: 'mut',
  rejected: 'danger',
  invalid: 'danger',
  quarantined: 'warn',
};

interface StuckIntent {
  id: string;
  user_id: string;
  provider: 'cryptopay' | 'lavatop';
  credits_cents: number;
  status: string;
  last_error: string | null;
  created_at: string;
}

function BillingOps() {
  const [health, setHealth] = useState<BillingHealthInfo | null>(null);
  const [stuck, setStuck] = useState<StuckIntent[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState('');
  const [reconciling, setReconciling] = useState<string | null>(null);

  const check = useCallback(async () => {
    setChecking(true);
    setErr('');
    try {
      const [nextHealth, creating, pending, quarantined] = await Promise.all([
        api.billingHealth(),
        api.adminPaymentIntents('creating'),
        api.adminPaymentIntents('pending'),
        api.adminPaymentIntents('quarantined'),
      ]);
      setHealth(nextHealth);
      setStuck([...quarantined.intents, ...creating.intents, ...pending.intents] as StuckIntent[]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const reconcile = async (id: string) => {
    setReconciling(id);
    try {
      await api.adminReconcilePayment(id);
      await check();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setReconciling(null);
    }
  };

  return (
    <Card>
      <SectionTitle
        title="Оплата"
        hint="живой пинг провайдеров и застрявшие счета"
        right={
          <Button kind="ghost" busy={checking} onClick={() => void check()} className="shrink-0">
            Проверить провайдеров
          </Button>
        }
      />
      <div className="p-4 sm:p-5 space-y-4">
        {health === null && !err ? (
          <div className="flex justify-center py-6"><Spinner /></div>
        ) : health && (
          <>
            <div className="grid sm:grid-cols-2 gap-2">
              {health.providers.map((p) => (
                <div key={p.id} className={`rounded-xl border px-3 py-3 space-y-1.5 ${p.check.ok ? 'border-ok/30 bg-ok/5' : 'border-danger/35 bg-danger/5'}`}>
                  <div className="flex items-center gap-2">
                    <span className={p.check.ok ? 'text-ok' : 'text-danger'}>{p.check.ok ? '✓' : '✗'}</span>
                    <span className="text-sm font-semibold">{PROVIDER_RU[p.id] ?? p.id}</span>
                    {p.testnet && <Tag tone="warn">тестнет</Tag>}
                    {!p.availableToUsers && <Tag tone="warn">клиентам скрыт</Tag>}
                  </div>
                  <div className="text-xs text-mut">{p.check.detail}</div>
                  {p.testnet && (
                    <div className="text-[11px] text-dim">
                      Платить криптой могут только владелец и тест-клиент. Для публики создай mainnet-приложение в @CryptoBot и замени CRYPTO_PAY_TOKEN.
                    </div>
                  )}
                </div>
              ))}
              {health.providers.length === 0 && (
                <div className="text-sm text-warn">Ни один платёжный провайдер не сконфигурирован (BILLING_PROVIDERS)</div>
              )}
            </div>

            <div className="flex flex-wrap gap-1.5 text-xs" aria-label="Счета по статусам">
              {Object.entries(health.intents).map(([status, n]) => (
                <Tag key={status} tone={status === 'credited' ? 'ok' : ['quarantined', 'failed'].includes(status) ? 'danger' : ['creating', 'paid'].includes(status) ? 'warn' : 'mut'}>
                  {INTENT_STATUS_RU[status] ?? status}: {n}
                </Tag>
              ))}
              {Object.keys(health.intents).length === 0 && <span className="text-mut">счетов ещё не было</span>}
            </div>

            {stuck && stuck.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-xs font-bold uppercase tracking-wider text-dim">Требуют внимания</div>
                {stuck.map((intent) => (
                  <div key={intent.id} className="rounded-lg border border-line bg-panel2 px-3 py-2 flex flex-wrap items-center gap-2 text-xs">
                    <Tag tone={intent.status === 'quarantined' ? 'danger' : 'warn'}>{INTENT_STATUS_RU[intent.status] ?? intent.status}</Tag>
                    <span className="font-semibold">{money(intent.credits_cents / 100)}</span>
                    <span className="text-mut">{PROVIDER_RU[intent.provider] ?? intent.provider}</span>
                    <span className="text-dim">{ago(intent.created_at)}</span>
                    {intent.last_error && <span className="text-danger truncate max-w-60" title={intent.last_error}>{intent.last_error}</span>}
                    <button
                      type="button"
                      disabled={reconciling === intent.id}
                      onClick={() => void reconcile(intent.id)}
                      className="ml-auto text-lime hover:underline disabled:opacity-50 min-h-8"
                      title="Спросить провайдера о судьбе счёта: оплаченный — зачислится, мёртвый — закроется"
                    >
                      {reconciling === intent.id ? 'сверяю…' : 'сверить'}
                    </button>
                  </div>
                ))}
              </div>
            )}

            {health.events.length > 0 && (
              <details open className="rounded-xl border border-line bg-panel2">
                <summary className="cursor-pointer px-3 py-2 text-xs font-semibold">
                  Последние события оплат ({health.events.length})
                </summary>
                <div className="border-t border-line px-3 py-2 space-y-1">
                  {health.events.map((event, index) => (
                    <div key={`${event.createdAt}-${index}`} className="flex flex-wrap items-center gap-2 text-xs py-0.5">
                      <Tag tone={EVENT_OUTCOME_TONE[event.outcome] ?? 'mut'}>{event.outcome}</Tag>
                      <span className="text-mut">{event.provider}</span>
                      <span className="text-dim">{event.source}</span>
                      {!event.verified && <span className="text-danger">подпись не сошлась</span>}
                      {event.reason && <span className="text-mut truncate max-w-52" title={event.reason}>{event.reason}</span>}
                      <span className="text-dim ml-auto">{ago(event.createdAt)}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}

            <div className="text-[11px] text-dim">
              Полную оплату «глазами клиента» проверяй тест-клиентом: меню профиля → «Войти тест-клиентом» —
              реальные цены, резерв и зачисление на отдельном балансе.
            </div>
          </>
        )}
        {err && <ErrorNote text={err} onRetry={() => void check()} />}
      </div>
    </Card>
  );
}
