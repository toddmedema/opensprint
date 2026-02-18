#!/usr/bin/env bash
# Remove packages/shared/dist and packages/shared/tsconfig.tsbuildinfo from git tracking.
# These are build artifacts that should not be committed.
set -e
cd "$(dirname "$0")/.."
git rm -r --cached packages/shared/dist 2>/dev/null || true
git rm --cached packages/shared/tsconfig.tsbuildinfo 2>/dev/null || true
rm -rf packages/shared/dist
rm -f packages/shared/tsconfig.tsbuildinfo
