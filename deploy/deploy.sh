#!/usr/bin/env bash
# Деплой SwapForge. Запуск от root на VPS: bash /opt/swapforge/deploy/deploy.sh
# Код: /opt/swapforge (git-чекаут). Данные: /var/lib/swapforge (не трогаются, кроме холодного бэкапа БД).
set -euo pipefail

APP=/opt/swapforge
DATA=/var/lib/swapforge
BACKUPS=$DATA/backups

cd "$APP"
echo "== SwapForge deploy $(date '+%F %T') =="

git fetch origin main
git reset --hard origin/main

npm ci --no-audit --no-fund
npm run build

# Холодный бэкап БД (сервис остановлен → консистентно), keep-5
systemctl stop swapforge 2>/dev/null || true
if [ -f "$DATA/swapforge.db" ]; then
  mkdir -p "$BACKUPS"
  ts=$(date +%Y%m%d-%H%M%S)
  tar -czf "$BACKUPS/db-$ts.tar.gz" -C "$DATA" $(cd "$DATA" && ls swapforge.db* 2>/dev/null)
  ls -1t "$BACKUPS"/db-*.tar.gz 2>/dev/null | tail -n +6 | xargs -r rm -f
fi

chown -R www-data:www-data "$DATA"
systemctl start swapforge

sleep 2
if curl -fsS http://127.0.0.1:4315/api/health >/dev/null; then
  echo "OK: health зелёный"
else
  echo "FAIL: health не отвечает, последние логи:"
  journalctl -u swapforge -n 40 --no-pager
  exit 1
fi
