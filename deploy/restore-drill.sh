#!/usr/bin/env bash
# Clean-host drill без касания production DATA_DIR.
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: $0 <full-*.tar.gz|restic:<snapshot>>" >&2; exit 2; }

drill=$(mktemp -d /tmp/swapforge-drill.XXXXXX)
cleanup() {
  case "$drill" in /tmp/swapforge-drill.*) rm -rf -- "$drill" ;; esac
}
trap cleanup EXIT

SWAPFORGE_SERVICE='' SWAPFORGE_DATA_OWNER='' SWAPFORGE_DATA_DIR="$drill/data" \
  bash "$(dirname "$0")/restore.sh" "$1" --target "$drill/data"

node --no-warnings - "$drill/data/swapforge.db" <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const result = db.prepare('PRAGMA quick_check').get();
if (!result || Object.values(result)[0] !== 'ok') throw new Error('restore drill quick_check failed');
console.log('OK: clean-host restore drill прошёл');
NODE
