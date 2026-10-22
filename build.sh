#!/usr/bin/env bash
set -euo pipefail

OMQ_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "[build] Node.js was not found in PATH." >&2
  echo "[build] Install Node.js 20 or newer and try again." >&2
  exit 1
fi

exec node "$OMQ_ROOT/build.js" "$@"
