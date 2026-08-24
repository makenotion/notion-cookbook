#!/usr/bin/env bash
# Typecheck every standalone cookbook project.

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CYAN=$'\033[36m'
RESET=$'\033[0m'

for dir in examples/* workers/templates/* workers/templates/custom-blocks/*; do
  if [[ ! -f "$dir/package.json" || ! -f "$dir/tsconfig.json" ]]; then
    continue
  fi

  # TODO(workflow-v2): Remove this skip when the archived v2 template builds
  # with the current Workers SDK.
  if [[ "$dir" == "workers/templates/workflow" ]]; then
    printf '%sSkipping %s (legacy v2 SDK API).%s\n' "$CYAN" "$dir" "$RESET"
    continue
  fi

  printf '%sTypechecking %s...%s\n' "$CYAN" "$dir" "$RESET"
  if (cd "$dir" && node -e 'const p = require("./package.json"); process.exit(p.scripts?.check ? 0 : 1)'); then
    (cd "$dir" && npm run check)
  else
    (cd "$dir" && npm exec -- tsc --noEmit)
  fi
done
