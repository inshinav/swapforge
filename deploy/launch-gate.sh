#!/usr/bin/env bash
# Финальный fail-closed GO gate. Evidence-файлы действуют только для exact SHA.
set -euo pipefail

REPO=${SWAPFORGE_REPO:-$(cd "$(dirname "$0")/.." && pwd)}
requested=${1:-HEAD}
cd "$REPO"
sha=$(git rev-parse --verify "$requested^{commit}")
evidence=${SWAPFORGE_RELEASE_EVIDENCE:-$REPO/release-evidence/$sha}

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo 'BLOCKED: tracked working tree не чист' >&2
  exit 1
fi

npm audit --omit=dev
npm run typecheck
npm run lint
npm run test
npm run build
bash -n deploy/backup.sh deploy/restore.sh deploy/restore-drill.sh deploy/deploy.sh deploy/launch-gate.sh

required=(
  legal-approved.sha
  browser-matrix.sha
  offsite-restore.sha
  staging-ready.sha
  crypto-testnet.sha
  paid-ai-smoke.sha
  real-payment-smoke.sha
)
missing=()
for name in "${required[@]}"; do
  file="$evidence/$name"
  if [ ! -f "$file" ] || [ "$(head -n 1 "$file")" != "$sha" ]; then
    missing+=("$name")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "BLOCKED: release $sha не имеет exact-SHA evidence:" >&2
  printf '  - %s\n' "${missing[@]}" >&2
  exit 1
fi

echo "GO: все автоматические и ручные gates подтверждены для $sha"
