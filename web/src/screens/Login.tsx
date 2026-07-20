import { useCallback, useEffect, useRef, useState } from 'react';
import type { HealthInfo, TgWidgetPayload } from '@shared/api-types';
import { api, appBase } from '../api';
import { Card, ErrorNote, Spinner, Tag } from '../ui';

declare global {
  interface Window {
    onTelegramAuth?: (user: TgWidgetPayload) => void;
  }
}

/**
 * Вход через Telegram Login Widget (режим data-onauth: payload уходит JS-ом на наш
 * POST — редирект-режим не работает под basic auth из-за user:pass@ в URL).
 */
export default function Login({ onAuthed }: { onAuthed: () => void }) {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [healthError, setHealthError] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [widgetState, setWidgetState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [widgetAttempt, setWidgetAttempt] = useState(0);
  const widgetRef = useRef<HTMLDivElement>(null);

  const loadHealth = useCallback(() => {
    setHealth(null);
    setHealthError(false);
    api.health().then(setHealth).catch(() => setHealthError(true));
  }, []);

  useEffect(loadHealth, [loadHealth]);

  useEffect(() => {
    const bot = health?.tgBot;
    const host = widgetRef.current;
    if (!bot || !host) return;
    setWidgetState('loading');
    window.onTelegramAuth = (user) => {
      setBusy(true);
      setErr('');
      api
        .authTelegram(user)
        .then(() => onAuthed())
        .catch((e: Error) => setErr(e.message))
        .finally(() => setBusy(false));
    };
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://telegram.org/js/telegram-widget.js?22';
    s.setAttribute('data-telegram-login', bot);
    s.setAttribute('data-size', 'large');
    s.setAttribute('data-radius', '12');
    s.setAttribute('data-onauth', 'onTelegramAuth(user)');
    s.onload = () => setWidgetState('ready');
    s.onerror = () => setWidgetState('error');
    host.appendChild(s);
    const timeout = window.setTimeout(() => {
      if (!host.querySelector('iframe')) setWidgetState('error');
    }, 8_000);
    return () => {
      window.clearTimeout(timeout);
      host.innerHTML = '';
      delete window.onTelegramAuth;
    };
  }, [health?.tgBot, onAuthed, widgetAttempt]);

  const devLogin = (id: number, name: string) => {
    setBusy(true);
    setErr('');
    api
      .devLogin(id, name)
      .then(() => onAuthed())
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-8">
      <Card glow className="w-full max-w-md">
        <div className="p-6 sm:p-10 text-center flex flex-col items-center gap-5">
          <Tag tone="lime">шаг 1 из 6</Tag>
          <div className="text-4xl">⚡</div>
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              Swap<span className="text-lime">Forge</span>
            </h1>
            <p className="text-mut text-sm mt-2">Замени персонажа в видео за несколько шагов.</p>
          </div>

          {health === null && !healthError && <Spinner />}
          {healthError && (
            <div className="w-full space-y-2" aria-live="polite">
              <ErrorNote text="Не удалось связаться с сервисом. Проверь интернет и попробуй снова." />
              <button
                type="button"
                onClick={loadHealth}
                className="min-h-11 rounded-lg border border-line2 bg-panel2 px-4 py-2 text-sm font-semibold hover:border-lime/50 hover:text-lime"
              >
                Повторить
              </button>
            </div>
          )}

          {health && !health.tgBot && !health.devAuth && (
            <p className="text-warn text-sm">
              Вход не настроен на сервере (нет TELEGRAM_BOT_NAME) — загляни позже.
            </p>
          )}

          {(health?.tgBot || health?.devAuth) && <div className="font-semibold">Войти через Telegram</div>}

          <div ref={widgetRef} className="min-h-[46px] flex items-center justify-center" />
          {health?.tgBot && widgetState === 'loading' && (
            <div className="flex items-center gap-2 text-sm text-mut" aria-live="polite">
              <Spinner size={14} /> загружаю кнопку Telegram…
            </div>
          )}
          {health?.tgBot && widgetState === 'error' && (
            <div className="w-full space-y-2" aria-live="polite">
              <ErrorNote text="Кнопка Telegram не загрузилась. Проверь соединение и попробуй ещё раз." />
              <button
                type="button"
                onClick={() => setWidgetAttempt((n) => n + 1)}
                className="min-h-11 rounded-lg border border-line2 bg-panel2 px-4 py-2 text-sm font-semibold hover:border-lime/50 hover:text-lime"
              >
                ↻ Загрузить кнопку снова
              </button>
            </div>
          )}
          {busy && <Spinner />}
          {err && <ErrorNote text={err} />}

          {health?.devAuth && (
            <div className="flex gap-2 text-xs">
              <button
                type="button"
                className="px-3 py-1.5 rounded-lg border border-line text-mut hover:text-ink"
                onClick={() => devLogin(1001, 'Дев-Алекс')}
              >
                dev: юзер А
              </button>
              <button
                type="button"
                className="px-3 py-1.5 rounded-lg border border-line text-mut hover:text-ink"
                onClick={() => devLogin(1002, 'Дев-Боб')}
              >
                dev: юзер Б
              </button>
            </div>
          )}

          <p className="text-[11px] text-dim leading-relaxed">
            Входя, ты принимаешь{' '}
            <a href={`${appBase}legal/terms`} className="underline hover:text-ink">условия</a>,{' '}
            <a href={`${appBase}legal/privacy`} className="underline hover:text-ink">конфиденциальность</a> и{' '}
            <a href={`${appBase}legal/acceptable-use`} className="underline hover:text-ink">правила контента</a>. 18+.
          </p>
        </div>
      </Card>
    </div>
  );
}
