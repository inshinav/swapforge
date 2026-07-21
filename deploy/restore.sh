#!/usr/bin/env bash
# Восстановление локального full-archive или restic:<snapshot> в чистый каталог.
set -euo pipefail
umask 077

usage() {
  echo "usage: $0 <full-*.tar.gz|restic:<snapshot>> [--target DIR] [--force]" >&2
  exit 2
}

[ $# -ge 1 ] || usage
source_ref=$1
shift
TARGET=${SWAPFORGE_DATA_DIR:-/var/lib/swapforge}
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --target) [ $# -ge 2 ] || usage; TARGET=$2; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) usage ;;
  esac
done

download_dir=''
if [[ "$source_ref" == restic:* ]]; then
  command -v restic >/dev/null 2>&1 || { echo 'FAIL: restic не установлен' >&2; exit 1; }
  snapshot=${source_ref#restic:}
  download_dir=$(mktemp -d)
  if [ "$snapshot" = latest ]; then
    restic restore latest --tag swapforge-full --target "$download_dir"
  else
    restic restore "$snapshot" --target "$download_dir"
  fi
  archive=$(find "$download_dir" -type f -name 'full-*.tar.gz' -printf '%T@ %p\n' | sort -nr | head -n 1 | cut -d' ' -f2-)
else
  archive=$(realpath "$source_ref")
fi
[ -n "${archive:-}" ] && [ -f "$archive" ] || { echo 'FAIL: snapshot не найден' >&2; exit 1; }

cleanup() {
  [ -z "$download_dir" ] || rm -rf -- "$download_dir"
  if [ -n "${stage:-}" ] && [ -d "$stage" ]; then rm -rf -- "$stage"; fi
}
trap cleanup EXIT

checksum="$archive.sha256"
if [ -f "$checksum" ]; then
  (cd "$(dirname "$archive")" && sha256sum -c "$(basename "$checksum")")
else
  echo 'WARN: рядом со snapshot нет checksum' >&2
fi

parent=$(dirname "$TARGET")
mkdir -p "$parent"
stage=$(mktemp -d "$parent/.swapforge-restore.XXXXXX")
tar -xzf "$archive" -C "$stage"
[ -f "$stage/swapforge.db" ] || { echo 'FAIL: в snapshot нет swapforge.db' >&2; exit 1; }

node --no-warnings - "$stage/swapforge.db" <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const row = db.prepare('PRAGMA quick_check').get();
if (!row || Object.values(row)[0] !== 'ok') throw new Error(`SQLite quick_check: ${JSON.stringify(row)}`);
for (const table of ['users', 'projects', 'models', 'generations', 'payment_intents']) {
  db.prepare(`SELECT COUNT(*) FROM ${table}`).get();
}
NODE

if [ -d "$TARGET" ] && [ -n "$(find "$TARGET" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
  [ "$FORCE" = 1 ] || { echo "FAIL: $TARGET не пуст; нужен --force" >&2; exit 1; }
fi

SERVICE=${SWAPFORGE_SERVICE:-swapforge}
LIVE_DATA=${SWAPFORGE_LIVE_DATA_DIR:-/var/lib/swapforge}
was_active=0
if [ "$TARGET" = "$LIVE_DATA" ] && [ -n "$SERVICE" ] && command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$SERVICE"; then
  systemctl stop "$SERVICE"
  was_active=1
fi

if [ -e "$TARGET" ]; then
  previous="$TARGET.restore-previous-$(date -u +%Y%m%dT%H%M%SZ)"
  mv "$TARGET" "$previous"
  echo "Предыдущее состояние сохранено: $previous"
fi
mv "$stage" "$TARGET"
stage=''

if [ "$TARGET" = "$LIVE_DATA" ] && [ -n "${SWAPFORGE_DATA_OWNER:-www-data:www-data}" ]; then
  chown -R "${SWAPFORGE_DATA_OWNER:-www-data:www-data}" "$TARGET"
fi
if [ "$was_active" = 1 ]; then
  systemctl start "$SERVICE"
  for _ in 1 2 3 4 5 6; do
    sleep 2
    curl -fsS http://127.0.0.1:4315/api/ready >/dev/null && break
  done
  curl -fsS http://127.0.0.1:4315/api/ready >/dev/null
fi

trap - EXIT
cleanup
echo "OK: восстановлено в $TARGET"
