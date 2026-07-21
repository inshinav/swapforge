#!/usr/bin/env bash
# Immutable deploy exact SHA. Никаких реальных запусков без отдельного разрешения владельца.
set -euo pipefail

main() {
  local REPO=${SWAPFORGE_REPO:-/opt/swapforge}
  local RELEASES=${SWAPFORGE_RELEASES:-/opt/swapforge-releases}
  local CURRENT=${SWAPFORGE_CURRENT:-/opt/swapforge-current}
  local DATA=${SWAPFORGE_DATA_DIR:-/var/lib/swapforge}
  local requested=${1:-origin/main}

  cd "$REPO"
  git fetch origin --prune
  local sha
  sha=$(git rev-parse --verify "$requested^{commit}")
  local release="$RELEASES/$sha"
  local previous=''
  mkdir -p "$RELEASES"

  echo "== SwapForge immutable deploy $sha =="
  if ! node -e "require('node:sqlite')" >/dev/null 2>&1; then
    echo "FAIL: node $(node -v) не поддерживает node:sqlite" >&2
    exit 1
  fi

  if [ ! -f "$release/.release-ready" ]; then
    if [ -e "$release" ]; then
      case "$release" in "$RELEASES"/*) git worktree remove --force "$release" 2>/dev/null || rm -rf -- "$release" ;; esac
    fi
    git worktree add --detach "$release" "$sha"
    cd "$release"
    npm ci --no-audit --no-fund
    npm audit --omit=dev
    npm run typecheck
    npm run lint
    npm run test
    npm run build
    printf '%s\n' "$sha" > .release-sha
    touch .release-ready
  fi

  if [ -L "$CURRENT" ]; then previous=$(readlink -f "$CURRENT"); fi

  # Конфиги валидируем до остановки сервиса.
  if ! cmp -s "$release/deploy/swapforge.service" /etc/systemd/system/swapforge.service 2>/dev/null; then
    cp "$release/deploy/swapforge.service" /etc/systemd/system/swapforge.service
    systemctl daemon-reload
  fi
  mkdir -p /etc/nginx/snippets
  cp "$release/deploy/nginx-swapforge.conf" /etc/nginx/snippets/swapforge.conf
  nginx -t

  # Blocking full snapshot. При ошибке старый release немедленно возвращается в работу.
  if ! BACKUP_LEAVE_STOPPED=1 SWAPFORGE_DATA_DIR="$DATA" \
       REQUIRE_OFFSITE_BACKUP=${REQUIRE_OFFSITE_BACKUP:-0} \
       bash "$release/deploy/backup.sh"; then
    systemctl start swapforge || true
    exit 1
  fi

  printf 'SWAPFORGE_RELEASE_SHA=%s\n' "$sha" > /etc/swapforge-release.env
  ln -s "$release" "$CURRENT.next"
  mv -Tf "$CURRENT.next" "$CURRENT"
  chown -R www-data:www-data "$DATA"
  systemctl start swapforge
  systemctl reload nginx

  local ready=0
  for _ in 1 2 3 4 5 6 7 8; do
    sleep 2
    if curl -fsS http://127.0.0.1:4315/api/ready >/dev/null 2>&1; then ready=1; break; fi
  done

  if [ "$ready" != 1 ]; then
    echo "FAIL: readiness красный для $sha; rollback" >&2
    journalctl -u swapforge -n 60 --no-pager || true
    systemctl stop swapforge || true
    if [ -n "$previous" ] && [ -d "$previous" ]; then
      ln -s "$previous" "$CURRENT.rollback"
      mv -Tf "$CURRENT.rollback" "$CURRENT"
      if [ -f "$previous/.release-sha" ]; then
        printf 'SWAPFORGE_RELEASE_SHA=%s\n' "$(cat "$previous/.release-sha")" > /etc/swapforge-release.env
      fi
      systemctl start swapforge
      curl -fsS --retry 6 --retry-delay 2 http://127.0.0.1:4315/api/health >/dev/null
      echo "ROLLBACK OK: $previous" >&2
    fi
    exit 1
  fi

  # Удаляем только проверенные старые worktree внутри RELEASES; current и previous сохраняем.
  mapfile -t old_releases < <(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | tail -n +4 | cut -d' ' -f2-)
  for old in "${old_releases[@]:-}"; do
    [ -n "$old" ] || continue
    [ "$old" = "$release" ] && continue
    [ -n "$previous" ] && [ "$old" = "$previous" ] && continue
    case "$old" in "$RELEASES"/*) git -C "$REPO" worktree remove --force "$old" 2>/dev/null || rm -rf -- "$old" ;; esac
  done

  echo "OK: release $sha ready"
}

main "$@"
