import { useMemo, useRef, useState } from 'react';
import type { OwnerBillingUser } from '@shared/api-types';
import { api } from '../api';
import { Button, Card, ErrorNote, SectionTitle, Tag } from '../ui';

interface PendingRequest {
  fingerprint: string;
  requestId: string;
}

const fieldClass =
  'w-full min-h-11 rounded-xl border border-line2 bg-panel2 px-3 py-2.5 text-sm text-ink outline-none focus:border-lime/60';

function normalizeUsername(value: string): string {
  return value.trim().replace(/^@/, '');
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

export default function OwnerCredits() {
  const [username, setUsername] = useState('');
  const [target, setTarget] = useState<OwnerBillingUser | null>(null);
  const [amount, setAmount] = useState('5.00');
  const [note, setNote] = useState('Оплата напрямую');
  const [busy, setBusy] = useState<'search' | 'topup' | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const pendingRequest = useRef<PendingRequest | null>(null);

  const amountUsd = useMemo(() => Number(amount.replace(',', '.')), [amount]);
  const amountError = !Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > 10_000 ||
    Math.abs(amountUsd * 100 - Math.round(amountUsd * 100)) > 1e-7;

  const findUser = async () => {
    const clean = normalizeUsername(username);
    if (!/^[A-Za-z0-9_]{5,32}$/.test(clean)) {
      setError('Введи Telegram-ник, например @username');
      setTarget(null);
      return;
    }
    setBusy('search');
    setError('');
    setSuccess('');
    try {
      const result = await api.ownerBillingUser(clean);
      setUsername(`@${result.user.username}`);
      setTarget(result.user);
      pendingRequest.current = null;
    } catch (e) {
      setTarget(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const topup = async () => {
    if (!target || amountError) return;
    const normalizedAmount = Math.round(amountUsd * 100) / 100;
    const fingerprint = `${target.id}:${normalizedAmount.toFixed(2)}:${note.trim()}`;
    const requestId = pendingRequest.current?.fingerprint === fingerprint
      ? pendingRequest.current.requestId
      : crypto.randomUUID();
    pendingRequest.current = { fingerprint, requestId };
    setBusy('topup');
    setError('');
    setSuccess('');
    try {
      const result = await api.ownerManualTopup({
        userId: target.id,
        amountUsd: normalizedAmount,
        note: note.trim(),
        requestId,
      });
      setTarget(result.user);
      setSuccess(
        result.replayed
          ? `Начисление уже было выполнено. Баланс @${result.user.username}: ${money(result.user.balance.availableUsd)}`
          : `Готово: @${result.user.username} получил ${money(normalizedAmount)}. Баланс: ${money(result.user.balance.availableUsd)}`,
      );
      pendingRequest.current = null;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <Card>
        <SectionTitle
          title="Ручное пополнение"
          hint="когда пользователь перевёл деньги тебе напрямую"
        />
        <div className="p-4 sm:p-5 space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="manual-tg-username" className="text-xs font-semibold text-mut">
              Telegram-ник пользователя
            </label>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                id="manual-tg-username"
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  setTarget(null);
                  setSuccess('');
                  pendingRequest.current = null;
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void findUser();
                }}
                placeholder="@username"
                autoCapitalize="none"
                autoCorrect="off"
                className={fieldClass}
              />
              <Button
                kind="ghost"
                onClick={() => void findUser()}
                busy={busy === 'search'}
                disabled={busy !== null}
                className="sm:w-28 shrink-0"
              >
                Найти
              </Button>
            </div>
            <p className="text-[11px] text-dim">
              Пользователь должен хотя бы раз войти в SwapForge через Telegram.
            </p>
          </div>

          {target && (
            <div className="rounded-xl border border-lime/30 bg-lime/5 p-4 space-y-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-full bg-lime text-black flex items-center justify-center font-bold shrink-0">
                  {(target.firstName || target.username).slice(0, 1).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold truncate">{target.firstName || `@${target.username}`}</div>
                  <div className="text-xs text-mut truncate">
                    @{target.username} · Telegram ID {target.telegramId}
                  </div>
                </div>
                <Tag tone="lime">баланс {money(target.balance.availableUsd)}</Tag>
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label htmlFor="manual-amount" className="text-xs font-semibold text-mut">Сумма, $</label>
                  <input
                    id="manual-amount"
                    value={amount}
                    onChange={(e) => {
                      setAmount(e.target.value);
                      setSuccess('');
                    }}
                    inputMode="decimal"
                    className={fieldClass}
                  />
                  {amountError && <p className="text-[11px] text-danger">От $0.01 до $10 000, максимум 2 знака</p>}
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="manual-note" className="text-xs font-semibold text-mut">Комментарий</label>
                  <input
                    id="manual-note"
                    value={note}
                    onChange={(e) => {
                      setNote(e.target.value);
                      setSuccess('');
                    }}
                    maxLength={180}
                    placeholder="Например: перевод в личку"
                    className={fieldClass}
                  />
                </div>
              </div>

              <Button
                kind="primary"
                onClick={() => void topup()}
                busy={busy === 'topup'}
                disabled={busy !== null || amountError}
                className="w-full sm:w-auto"
              >
                Начислить {amountError ? '' : money(Math.round(amountUsd * 100) / 100)}
              </Button>
            </div>
          )}

          {error && <ErrorNote text={error} />}
          {success && (
            <div className="rounded-xl border border-ok/30 bg-ok/5 px-4 py-3 text-sm text-ok">
              {success}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
