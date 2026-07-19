# SwapForge v4 — чеклист запуска публичного сервиса

Код v4 собран и запушен в main. Прод НЕ задеплоен: боту нужен env (шаг 1), иначе
`assertAuthConfig` намеренно уронит бут (fail-loud вместо дырявого auth).
Порядок ниже — строгий. Basic auth снимается ПОСЛЕДНИМ.

## 1. Auth-бот Telegram (руками, ~5 минут)

1. @BotFather → `/newbot` → отдельный бот для входа (например `SwapForgeAuthBot`).
   Отдельный бот только для входа; НЕ шли токен в чаты.
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
Деплой также синкнет nginx-сниппет (в нём новые локации вебхуков платёжных провайдеров без basic auth).

**Чекпоинт 0/1 (руками, за basic auth):** зайди на https://inshinlab.com/swapforge/ →
кнопка Telegram → вход; старые проекты на месте; вкладка «Мои модели» показывает
MotoLola и Lunaria с вариантами; кнопки на экране свапа прежние 6. Вторым
TG-аккаунтом (жена/тестовый) — пустая библиотека, чужих проектов нет.

## 3. Платёжные провайдеры: Crypto Pay (крипта) + Lava.top (карты/СБП)

Оба server-initiated: сервер сам создаёт инвойс через API и кладёт наш userId+сумму
в round-trip канал (payload у Crypto Pay, clientUtm у Lava) → вебхук возвращает их
обратно, маппинг платёж→юзер 100%-й. Пользователь видит только итоговую цену и баланс
в USD. В БД 1 внутренняя единица = 1 цент; цена = полная себестоимость промтов,
изображений и видео × 1.25. Пользователь видит только эту финальную цену.

**3a. Crypto Pay (@CryptoBot):**
1. @CryptoBot → Crypto Pay → Create App → получи **API Token**.
2. My Apps → выбери приложение → **Webhooks** → Enable → URL
   `https://inshinlab.com/swapforge/api/billing/webhook/cryptopay`.
3. Отладка бесплатно: @CryptoTestnetBot + `CRYPTO_PAY_TESTNET=1` (потом убрать).

**3b. Lava.top:**
1. ЛК lava.top → Профиль → Интеграция → **Добавить API-ключ** (это `X-Api-Key`).
2. Там же настрой вебхук «Результат платежа» → URL
   `https://inshinlab.com/swapforge/api/billing/webhook/lavatop`, тип авторизации
   **ApiKeyWebhookAuth** → задай секрет (пойдёт в `LAVA_WEBHOOK_SECRET`).
3. Создай один оффер с **динамической ценой в RUB**, скопируй его **offerId**.
4. (Опц.) в nginx-локации вебхука можно захардить их IP `158.160.60.174`.

**3c. env `/etc/swapforge.env`:**
```
USER_MARGIN_PCT=25        # единственная маржа поверх полной себестоимости
BILLING_PROVIDERS=cryptopay,lavatop      # можно только один
CRYPTO_PAY_TOKEN=<токен приложения Crypto Pay>
CRYPTO_PAY_TESTNET=1                      # на время отладки, потом убрать
CRYPTO_PAY_ACCEPTED_ASSETS=USDT,TON,BTC,ETH,USDC
LAVA_API_KEY=<X-Api-Key из ЛК lava.top>
LAVA_WEBHOOK_SECRET=<секрет вебхука lava>
LAVA_DYNAMIC_OFFER_ID=<offerId динамического RUB-оффера>
LAVA_RUB_PER_USD=100                    # фиксированный курс: $1 баланса = 100 ₽ в Lava
MIN_TOPUP_USD=5
MAX_TOPUP_USD=1000
PUBLIC_BASE_URL=https://inshinlab.com/swapforge/
```
Crypto Pay создаёт fiat-USD инвойс с оплатой выбранной криптовалютой. Lava создаёт RUB-счёт:
выбранная сумма USD-баланса умножается на `LAVA_RUB_PER_USD`, а webhook зачисляет исходную
USD-сумму только после полной оплаты в RUB. Затем `systemctl restart swapforge`.

**Чекпоинт 2 (руками, ~15 мин):** тест-аккаунт → вкладка «Баланс» → введи сумму от $5:
- «Криптой» → редирект на Crypto Pay (testnet) → оплата → доллары пришли;
- «Картой/СБП» → форма email → `$5 = 500 ₽` → редирект на Lava → оплата → `$5` пришли.
Леджер показывает «пополнение»; запусти свап → «списание» ≤ сметы; у владельца всё
unmetered. Проверь допущение: WaveSpeed НЕ биллит фейлы (если биллит — скажи Claude,
переключим release-политику).

## 4. Опциональные env (дефолты разумные)

```
USER_STORAGE_CAP_GB=3      # кап хранилища юзера
USER_QUEUE_CAP=2           # queued-задач на юзера
RENDER_CONCURRENCY=3       # столько разных проектов рендерятся одновременно
LIMIT_PROJECTS_PER_DAY=20
LIMIT_CLASSIFY_PER_DAY=60
LIMIT_DESCRIBE_PER_DAY=30
LIMIT_MANUAL_LLM_PER_DAY=40
```

## 5. Живая приёмка (Claude гоняет с тобой, ≤$10 API)

Свежий TG-аккаунт: вход → модель из 2 листов (автоописание) → ролик 6–8с → смета
в кредитах → пакет (Crypto Pay или Lava.top) → рендер → 👍 → леджер честный → второй аккаунт
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
