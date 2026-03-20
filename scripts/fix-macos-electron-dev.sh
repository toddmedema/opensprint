#!/usr/bin/env bash
# On macOS, remove quarantine/provenance and ad-hoc sign the Electron dev binary
# so "Electron quit unexpectedly" does not occur when running npm run start:desktop.
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
ELECTRON_APP="${REPO_ROOT}/node_modules/electron/dist/Electron.app"

if [ ! -d "$ELECTRON_APP" ]; then
  # Electron may be hoisted under packages/electron in some installs
  ELECTRON_APP="${REPO_ROOT}/packages/electron/node_modules/electron/dist/Electron.app"
fi

if [ ! -d "$ELECTRON_APP" ]; then
  echo "==> Electron.app not found; run npm install and try again."
  exit 0
fi

echo "==> Fixing macOS Electron dev binary: $ELECTRON_APP"
xattr -cr "$ELECTRON_APP"
codesign --force --deep --sign - "$ELECTRON_APP"
echo "==> Done."
