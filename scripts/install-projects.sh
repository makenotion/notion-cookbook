#!/usr/bin/env bash
# Install dependencies for every standalone cookbook project.

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CYAN=$'\033[36m'
RESET=$'\033[0m'

for dir in examples/* workers/*; do
  if [[ -f "$dir/package.json" ]]; then
    printf '%sInstalling %s...%s\n' "$CYAN" "$dir" "$RESET"
    (cd "$dir" && npm install)
  fi
done
