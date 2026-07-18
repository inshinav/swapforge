import { useEffect, useRef, useState } from 'react';
import type { HealthInfo, TgWidgetPayload } from '@shared/api-types';
import { api } from '../api';
import { Card, ErrorNote, Spinner } from '../ui';

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
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const widgetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
  }, []);

  useEffect(() => {
    const bot = health?.tgBot;
    const host = widgetRef.current;
    if (!bot || !host) return;
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
    host.appendChild(s);
    return () => {
      host.innerHTML = '';
      delete window.onTelegramAuth;
    };
  }, [health?.tgBot, onAuthed]);

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
    <div className="min-h-[70vh] flex items-center justify-center px-4">
      <Card glow>
        <div className="p-8 sm:p-10 max-w-md text-center flex flex-col items-center gap-5">
          <div className="text-4xl">⚡</div>
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              Swap<span className="text-lime">Forge</span>
            </h1>
            <p className="text-mut text-sm mt-2 leading-relaxed">
              Твоя AI-модель — в любом ролике. Загрузи референсы один раз, кидай видео и
              получай чистый свап: мир, свет и движение исходника нетронуты.
            </p>
          </div>

          {health === null && <Spinner />}

          {health && !health.tgBot && !health.devAuth && (
            <p className="text-warn text-sm">
              Вход не настроен на сервере (нет TELEGRAM_BOT_NAME) — загляни позже.
            </p>
          )}

          <div ref={widgetRef} className="min-h-[46px] flex items-center justify-center" />
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
            Входя, ты принимаешь условия сервиса. 18+.
          </p>
        </div>
      </Card>
    </div>
  );
}
