# SwapForge operations runbook

## Release contract

- CI обязан пройти `npm audit --omit=dev`, typecheck, lint, server+web tests и build.
- Deploy принимает exact commit: `bash deploy/deploy.sh <git-sha>`.
- Release собирается в `/opt/swapforge-releases/<sha>`; `/opt/swapforge-current` переключается атомарно.
- `/api/ready` проверяет DB, storage, FFmpeg, auth/owner, AI и хотя бы один billing provider.
- При красном readiness deploy автоматически возвращает предыдущий symlink и SHA.
- Миграции во время rollback должны оставаться additive и читаться предыдущим приложением.

Сам deploy выполняется только после отдельного разрешения владельца.

## Backup

`deploy/backup.sh` кратко останавливает сервис и сохраняет весь DATA_DIR: SQLite, проекты,
референсы, модели и media. Локально остаются пять архивов с SHA-256.

Для шифрованной off-host копии:

```bash
export RESTIC_REPOSITORY='s3:https://s3.example/bucket/swapforge'
export RESTIC_PASSWORD_FILE='/etc/swapforge-restic-password'
export AWS_ACCESS_KEY_ID='...'
export AWS_SECRET_ACCESS_KEY='...'
export REQUIRE_OFFSITE_BACKUP=1
bash deploy/backup.sh
```

На production `REQUIRE_OFFSITE_BACKUP=1` включается только после передачи bucket и credentials.

## Restore and drill

В чистый каталог:

```bash
bash deploy/restore.sh /var/lib/swapforge/backups/full-*.tar.gz --target /tmp/swapforge-restored
```

Полный clean-host drill без изменения production:

```bash
bash deploy/restore-drill.sh /var/lib/swapforge/backups/full-20260721T000000Z.tar.gz
```

Из off-host snapshot:

```bash
bash deploy/restore-drill.sh restic:latest
```

Фильтрация `latest` по тегу и восстановление в отдельный target следуют официальному
[restic restore contract](https://restic.readthedocs.io/en/stable/050_restore.html).

Restore проверяет checksum, SQLite `quick_check` и ключевые таблицы. При `--force` прежний
DATA_DIR не удаляется, а переименовывается в `*.restore-previous-<timestamp>`.

## Operator alerts

Админка показывает pending/quarantined payments, просроченные job leases, зависшие renders,
старые holds, ошибки jobs за 24 часа и заполнение диска. Каждый HTTP-ответ содержит безопасный
`x-request-id`; nginx передаёт тот же correlation ID в приложение и структурированные Fastify-логи.
