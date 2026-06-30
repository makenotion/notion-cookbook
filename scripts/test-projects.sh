#!/usr/bin/env bash
# Run each standalone project's offline tests when it declares a test script.

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CYAN=$'\033[36m'
DIM=$'\033[2m'
RESET=$'\033[0m'

for dir in examples/* workers/*; do
  if [[ ! -f "$dir/package.json" ]]; then
    continue
  fi

  if (cd "$dir" && node -e 'const p = require("./package.json"); process.exit(p.scripts?.test ? 0 : 1)'); then
    printf '%sTesting %s...%s\n' "$CYAN" "$dir" "$RESET"
    (cd "$dir" && npm test)
  else
    printf '%sSkipping %s (no test script).%s\n' "$DIM" "$dir" "$RESET"
  fi
done
