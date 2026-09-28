#!/usr/bin/env bash
# Run one verification stage across standalone projects in bounded batches.

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

stage="${1:-}"
if [[ "$stage" != install && "$stage" != typecheck && "$stage" != test ]]; then
  echo "Usage: $0 {install|typecheck|test}" >&2
  exit 2
fi

jobs="${PROJECT_VERIFY_JOBS:-4}"
if [[ ! "$jobs" =~ ^[1-9][0-9]*$ ]]; then
  echo "PROJECT_VERIFY_JOBS must be a positive integer" >&2
  exit 2
fi

log_dir="$(mktemp -d)"
trap 'rm -rf "$log_dir"' EXIT

run_project() {
  local dir="$1"
  cd "$dir"
  case "$stage" in
    install) npm install ;;
    typecheck)
      if node -e 'const p = require("./package.json"); process.exit(p.scripts?.check ? 0 : 1)'; then
        npm run check
      else
        npm exec -- tsc --noEmit
      fi
      ;;
    test) npm test ;;
  esac
}

wait_for_batch() {
  local failed=0
  local i
  for i in "${!pids[@]}"; do
    if wait "${pids[$i]}"; then
      printf 'Passed %s: %s\n' "$stage" "${dirs[$i]}"
    else
      printf 'Failed %s: %s\n' "$stage" "${dirs[$i]}" >&2
      cat "${logs[$i]}" >&2
      failed=1
    fi
  done
  if (( failed )); then
    exit 1
  fi
  pids=()
  dirs=()
  logs=()
}

pids=()
dirs=()
logs=()
for dir in examples/* apps/templates/* workers/templates/* workers/templates/custom-blocks/* workers/templates/workflows/*; do
  if [[ ! -f "$dir/package.json" ]]; then
    continue
  fi
  if [[ "$stage" == typecheck && ! -f "$dir/tsconfig.json" ]]; then
    continue
  fi
  if [[ "$stage" == test ]] && ! (cd "$dir" && node -e 'const p = require("./package.json"); process.exit(p.scripts?.test ? 0 : 1)'); then
    printf 'Skipping %s (no test script).\n' "$dir"
    continue
  fi

  log="$log_dir/${#dirs[@]}"
  printf 'Running %s: %s\n' "$stage" "$dir"
  (run_project "$dir") >"$log" 2>&1 &
  pids+=("$!")
  dirs+=("$dir")
  logs+=("$log")

  if (( ${#pids[@]} == jobs )); then
    wait_for_batch
  fi
done
if (( ${#pids[@]} )); then
  wait_for_batch
fi
