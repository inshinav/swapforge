# SwapForge v4 — чеклист запуска публичного сервиса

Код v4 собран и запушен в main. Прод НЕ задеплоен: боту нужен env (шаг 1), иначе
`assertAuthConfig` намеренно уронит бут (fail-loud вместо дырявого auth).
Порядок ниже — строгий. Basic auth снимается ПОСЛЕДНИМ.

## 1. Auth-бот Telegram (руками, ~5 минут)

1. @BotFather → `/newbot` → отдельный бот для входа (например `SwapForgeAuthBot`).
   НЕ используй Tribute-бота и НЕ шли токен в чаты.
2. `/setdomain` для этого бота → `inshinlab.com` (виджет проверяет origin страницы).
3. Свой telegram_id: напиши @userinfobot → число.
4. В `/etc/swapforge.env` добавь (строки с реальными значениями):
   ```
   NODE_ENV=production
   TELEGRAM_BOT_TOKEN=<токен из BotFather>
   TELEGRAM_BOT_NAME=<username бота без @>
   OWNER_TELEGRAM_ID=<твой telegram_id>
   ```

## 2. Деплой этапа 0–5 (Claude может сам после шага 1)

```
ssh inshinlab-vps 'bash /opt/swapforge/deploy/deploy.sh'
```
На буте пройдут миграции: m001 (все старые проекты → твой аккаунт) и m002
(6 пресетов → модели «MotoLola» и «Lunaria» твоего аккаунта).
Деплой также синкнет nginx-сниппет (в нём новая локация вебхука Tribute без basic auth).

**Чекпоинт 0/1 (руками, за basic auth):** зайди на https://inshinlab.com/swapforge/ →
кнопка Telegram → вход; старые проекты на месте; вкладка «Мои модели» показывает
MotoLola и Lunaria с вариантами; кнопки на экране свапа прежние 6. Вторым
TG-аккаунтом (жена/тестовый) — пустая библиотека, чужих проектов нет.

## 3. Tribute (руками)

1. В Tribute создай «цифровые продукты» — пакеты кредитов (например: Старт 300 кр /
   299 ₽, Средний 700 кр / 599 ₽, Большой 1500 кр / 999 ₽). Цена = себестоимость×2
   при курсе ~90₽/$ (1 кредит = 1 цент себестоимости с наценкой; 6-сек рендер ≈
   $2.10+LLM ≈ 450 кредитов).
2. Дашборд Tribute → Settings → API Keys → сгенерируй ключ; webhook URL:
   `https://inshinlab.com/swapforge/api/billing/tribute/webhook`
3. В `/etc/swapforge.env`:
   ```
   TRIBUTE_API_KEY=<api-ключ Tribute>
   CREDIT_MARKUP=2
   SWAPFORGE_PACKS_JSON=[{"id":"start","title":"Старт","credits":300,"priceLabel":"299 ₽","url":"<ссылка на продукт>","tributeProductId":<id продукта>},...]
   ```
   `tributeProductId` — числовой id продукта Tribute (приходит в вебхуке
   `payload.product_id`); фолбэк-маппинг — по `amountMinor`+`currency` (29900+"rub").
4. `systemctl restart swapforge`.

**Чекпоинт 2 (руками, ~10 мин):** тест-аккаунтом купи самый дешёвый пакет живым
платежом → кредиты пришли (вкладка «Баланс», строка «пополнение») → запусти свап
→ в леджере «списание» ≤ сметы → у твоего аккаунта всё без ограничений (unmetered).
Заодно проверить допущение: WaveSpeed НЕ биллит фейлы (если биллит — скажи Claude,
переключим release-политику).

## 4. Опциональные env (дефолты разумные)

```
USER_STORAGE_CAP_GB=3      # кап хранилища юзера
USER_QUEUE_CAP=2           # queued-задач на юзера
LIMIT_PROJECTS_PER_DAY=20
LIMIT_CLASSIFY_PER_DAY=60
LIMIT_DESCRIBE_PER_DAY=30
LIMIT_MANUAL_LLM_PER_DAY=40
```

## 5. Живая приёмка (Claude гоняет с тобой, ≤$10 API)

Свежий TG-аккаунт: вход → модель из 2 листов (автоописание) → ролик 6–8с → смета
в кредитах → пакет через Tribute → рендер → 👍 → леджер честный → второй аккаунт
ничего чужого не видит → одна очередь двумя аккаунтами → один retry-путь.

## 6. Запуск = снять basic auth (только ты)

В `/etc/nginx/snippets/swapforge.conf` удали 2 строки `auth_basic` из локации
`^~ /swapforge/` (точная локация вебхука уже без них) → `nginx -t && systemctl reload nginx`.
С этого момента сервис публичный: вход только через Telegram.

## Откат

- Код: `ssh inshinlab-vps 'cd /opt/swapforge && git reset --hard <прежний коммит> && bash deploy/deploy.sh'`
- БД: холодные tar-бэкапы deploy.sh (keep-5) в /var/lib/swapforge.
- Публичность: вернуть auth_basic + reload nginx.

## Заметки

- Юр-страницы: /swapforge/legal/{terms,privacy,acceptable-use} — черновики, финал за юристом.
- `presets.ts` + `server/assets/presets/` вырезаем отдельным коммитом ПОСЛЕ чекпоинта 1.
- `AUTH_DEV_BYPASS` в prod запрещён (бут упадёт) — только для локальной разработки.
