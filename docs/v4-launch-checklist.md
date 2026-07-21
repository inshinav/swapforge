# SwapForge — строгий чеклист публичного запуска

Публичный запуск выполняется только для exact SHA и только после `deploy/launch-gate.sh`.
Реальные платежи, платные AI-запуски и production deploy требуют отдельного разрешения владельца.

## 1. Production env

Обязательны Telegram auth, ровно один owner, OpenAI, WaveSpeed и хотя бы один payment provider.
Секреты хранятся только в `/etc/swapforge.env`; токены нельзя писать в git, отчёты или чат.

```dotenv
NODE_ENV=production
TELEGRAM_BOT_TOKEN=...
TELEGRAM_BOT_NAME=SwapForgeBot
OWNER_TELEGRAM_ID=...
OPENAI_API_KEY=...
WAVESPEED_API_KEY=...

USER_MARGIN_PCT=25
BILLING_PROVIDERS=cryptopay,lavatop
CRYPTO_PAY_TOKEN=...
CRYPTO_PAY_TESTNET=1
LAVA_API_KEY=...
LAVA_WEBHOOK_SECRET=...
LAVA_DYNAMIC_OFFER_ID=...
LAVA_RUB_PER_USD=100
MIN_TOPUP_USD=5
MAX_TOPUP_USD=1000
PUBLIC_BASE_URL=https://inshinlab.com/swapforge/
```

Пользователь видит USD и одну финальную цену с уже включённой маржой 25%. Lava принимает
RUB по фиксированному продуктовым решением курсу 100 RUB = $1 баланса.

## 2. Webhooks

- Crypto Pay: `https://inshinlab.com/swapforge/api/billing/webhook/cryptopay`
- Lava.top: `https://inshinlab.com/swapforge/api/billing/webhook/lavatop`

Не добавлять неофициальный статический IP Lava. Защита строится на подписи/секрете,
durable event inbox, replay protection; CIDR разрешается задавать только по актуальному
официальному списку провайдера.

## 3. Backup contract

Перед staging/production нужны:

1. `RESTIC_REPOSITORY`, пароль и S3-compatible credentials.
2. `REQUIRE_OFFSITE_BACKUP=1`.
3. Успешный `deploy/backup.sh`.
4. Успешный `deploy/restore-drill.sh restic:latest` на чистом каталоге.

Локальный keep-5 без off-host копии недостаточен для публичного GO.

## 4. Безопасные автоматические проверки

```bash
npm audit --omit=dev
npm run typecheck
npm run lint
npm run test
npm run build
bash -n deploy/*.sh
```

Synthetic FFmpeg short/long выполняется в тестах без платного AI. Тесты не имеют права
выходить во внешнюю сеть.

## 5. Browser matrix

Для exact SHA проверяются:

- desktop: 1024×768, 1280×720, 1366×768, 1440×900, 1920×1080;
- mobile: 320, 375, 390, 768;
- Login, onboarding, empty/filled Swap, preset model+object, preflight, queue/error,
  result/download, Library, Billing, Guide, Admin;
- `scrollWidth <= clientWidth` в каждом состоянии;
- keyboard-only путь до кнопки подтверждения запуска, без фактического платного запуска.

Результат фиксируется как `release-evidence/<sha>/browser-matrix.sha`, первая строка — SHA.

## 6. Legal

`/legal/terms`, `/legal/privacy`, `/legal/acceptable-use` остаются release blocker до
утверждения владельцем/юристом. Автоматически придумывать юридическую редакцию нельзя.
После утверждения создаётся `legal-approved.sha` для exact SHA.

## 7. Staging и controlled smoke

Порядок не меняется:

1. Deploy exact SHA на staging.
2. Проверить `/api/ready`, Telegram login, admin alerts и восстановление после restart.
3. Crypto Pay testnet owner-only; Lava — mocked failure matrix.
4. Только по отдельному разрешению и лимиту бюджета: один short и один long render.
5. Только по отдельному разрешению: минимальный реальный payment smoke.
6. Проверить цену, один hold/settle, бесшовность, скачивание и credited message.

Каждый результат подтверждается `.sha`-файлом из списка `deploy/launch-gate.sh`.

## 8. Immutable deploy и rollback

```bash
ssh inshinlab-vps 'cd /opt/swapforge && bash deploy/deploy.sh <exact-git-sha>'
```

Deploy повторяет все gates, создаёт `/opt/swapforge-releases/<sha>`, делает blocking backup,
атомарно переключает `/opt/swapforge-current`, ждёт readiness и автоматически возвращает
предыдущий symlink при ошибке. Production deploy выполняется только после разрешения владельца.

## 9. Финальный GO

```bash
bash deploy/launch-gate.sh <exact-git-sha>
```

Если хотя бы один evidence отсутствует, относится к другому SHA или автоматический gate красный,
результат обязан быть `BLOCKED`, а basic auth/публичный доступ не меняются.
