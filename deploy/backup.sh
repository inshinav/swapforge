#!/usr/bin/env bash
# Полный консистентный snapshot DB + projects + models + media.
# По умолчанию кратко останавливает swapforge; deploy.sh оставляет его остановленным до switch.
set -euo pipefail
umask 077

DATA=${SWAPFORGE_DATA_DIR:-/var/lib/swapforge}
BACKUPS=${SWAPFORGE_BACKUP_DIR:-$DATA/backups}
SERVICE=${SWAPFORGE_SERVICE:-swapforge}
KEEP=${SWAPFORGE_LOCAL_BACKUP_KEEP:-5}
LEAVE_STOPPED=${BACKUP_LEAVE_STOPPED:-0}
REQUIRE_OFFSITE=${REQUIRE_OFFSITE_BACKUP:-0}
was_active=0

restart_service() {
  if [ "$was_active" = 1 ] && [ "$LEAVE_STOPPED" != 1 ]; then
    systemctl start "$SERVICE"
    was_active=0
  fi
}
trap restart_service EXIT

if [ -n "$SERVICE" ] && command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$SERVICE"; then
  systemctl stop "$SERVICE"
  was_active=1
fi

if [ ! -f "$DATA/swapforge.db" ]; then
  echo "FAIL: $DATA/swapforge.db не найден" >&2
  exit 1
fi

# Битую БД не архивируем как пригодный backup.
node --no-warnings - "$DATA/swapforge.db" <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const row = db.prepare('PRAGMA quick_check').get();
if (!row || Object.values(row)[0] !== 'ok') throw new Error(`SQLite quick_check: ${JSON.stringify(row)}`);
NODE

mkdir -p "$BACKUPS"
ts=$(date -u +%Y%m%dT%H%M%SZ)
archive="$BACKUPS/full-$ts.tar.gz"
partial="$archive.part"
tar --one-file-system --exclude='./backups' -czf "$partial" -C "$DATA" .
mv "$partial" "$archive"
(
  cd "$BACKUPS"
  sha256sum "$(basename "$archive")" > "$(basename "$archive").sha256"
)

# Локально оставляем пять полных snapshot и соответствующие checksums.
mapfile -t old < <(find "$BACKUPS" -maxdepth 1 -type f -name 'full-*.tar.gz' -printf '%T@ %p\n' | sort -nr | tail -n "+$((KEEP + 1))" | cut -d' ' -f2-)
for file in "${old[@]:-}"; do
  [ -n "$file" ] || continue
  rm -f -- "$file" "$file.sha256"
done

if [ -n "${RESTIC_REPOSITORY:-}" ] && { [ -n "${RESTIC_PASSWORD:-}" ] || [ -n "${RESTIC_PASSWORD_FILE:-}" ]; }; then
  command -v restic >/dev/null 2>&1 || { echo 'FAIL: restic не установлен' >&2; exit 1; }
  restic backup "$archive" "$archive.sha256" --tag swapforge-full
  restic forget --tag swapforge-full --keep-last 5 --prune
elif [ "$REQUIRE_OFFSITE" = 1 ]; then
  echo 'FAIL: off-host backup обязателен, но RESTIC_REPOSITORY/пароль не настроены' >&2
  exit 1
else
  echo 'WARN: off-host restic не настроен; локальный snapshot создан' >&2
fi

restart_service
trap - EXIT
echo "$archive"
