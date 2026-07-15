#!/usr/bin/env bash
# Деплой SwapForge. Запуск от root на VPS: bash /opt/swapforge/deploy/deploy.sh
# Код: /opt/swapforge (git-чекаут). Данные: /var/lib/swapforge (не трогаются, кроме холодного бэкапа БД).
set -euo pipefail

# Всё тело — в функции: git reset подменяет этот файл посреди выполнения,
# а bash дочитывает скрипт по мере исполнения. Функция парсится целиком до старта.
main() {
  local APP=/opt/swapforge
  local DATA=/var/lib/swapforge
  local BACKUPS=$DATA/backups

  cd "$APP"
  echo "== SwapForge deploy $(date '+%F %T') =="

  # node:sqlite требует Node >= 22.13 — проверяем до всего остального
  if ! node -e "require('node:sqlite')" >/dev/null 2>&1; then
    echo "FAIL: node ($(node -v)) не поддерживает node:sqlite — нужен Node >= 22.13"
    exit 1
  fi

  if [ -n "$(git status --porcelain)" ]; then
    echo "ВНИМАНИЕ: в /opt/swapforge есть локальные правки — git reset --hard их сотрёт:"
    git status --porcelain
  fi

  git fetch origin main
  git reset --hard origin/main

  npm ci --no-audit --no-fund
  npm run build

  mkdir -p "$DATA"

  # systemd unit и nginx-конфиг из репо — доносим изменения до системы
  if ! cmp -s deploy/swapforge.service /etc/systemd/system/swapforge.service; then
    cp deploy/swapforge.service /etc/systemd/system/swapforge.service
    systemctl daemon-reload
    echo "systemd unit обновлён"
  fi
  if [ -f /etc/nginx/sites-available/swapforge.inshinlab.com ] &&
     ! grep -q 'managed by Certbot' /etc/nginx/sites-available/swapforge.inshinlab.com &&
     ! cmp -s deploy/nginx-swapforge.conf /etc/nginx/sites-available/swapforge.inshinlab.com; then
    cp deploy/nginx-swapforge.conf /etc/nginx/sites-available/swapforge.inshinlab.com
    nginx -t && systemctl reload nginx
    echo "nginx-конфиг обновлён"
  fi

  # Холодный бэкап БД (сервис остановлен => консистентно), keep-5.
  # Ошибка бэкапа не должна оставить сервис лежать.
  systemctl stop swapforge 2>/dev/null || true
  if [ -f "$DATA/swapforge.db" ]; then
    mkdir -p "$BACKUPS"
    local ts
    ts=$(date +%Y%m%d-%H%M%S)
    if tar -czf "$BACKUPS/db-$ts.tar.gz" -C "$DATA" $(cd "$DATA" && ls swapforge.db* 2>/dev/null); then
      ls -1t "$BACKUPS"/db-*.tar.gz 2>/dev/null | tail -n +6 | xargs -r rm -f
    else
      echo "ВНИМАНИЕ: бэкап БД не удался — продолжаю деплой"
    fi
  fi

  chown -R www-data:www-data "$DATA"
  systemctl start swapforge

  # health с ретраями: холодный старт (ротация/скан каталога) может занять >2с
  local i
  for i in 1 2 3 4 5 6; do
    sleep 2
    if curl -fsS http://127.0.0.1:4315/api/health >/dev/null 2>&1; then
      echo "OK: health зелёный (попытка $i)"
      return 0
    fi
  done
  echo "FAIL: health не отвечает, последние логи:"
  journalctl -u swapforge -n 40 --no-pager
  exit 1
}

main "$@"
