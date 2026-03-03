#!/usr/bin/env bash
# Ensures local PostgreSQL is running (for npm run dev). Starts the service if needed on Mac/Linux.
# No-op if Postgres is already accepting connections on localhost:5432.
set -e

is_wsl() {
  [ -n "${WSL_DISTRO_NAME:-}" ] || [ -n "${WSL_INTEROP:-}" ] || \
    grep -qi microsoft /proc/version 2>/dev/null
}

UNAME="$(uname -s)"
IS_WSL=0
if [ "$UNAME" = "Linux" ] && is_wsl; then
  IS_WSL=1
fi

if command -v pg_isready >/dev/null 2>&1; then
  if pg_isready -h localhost -p 5432 -q 2>/dev/null; then
    exit 0
  fi
fi

if [ "$IS_WSL" -eq 1 ]; then
  echo "==> WSL detected. Skipping PostgreSQL service start. Ensure Postgres is reachable from WSL on localhost:5432 or configure DATABASE_URL."
  exit 0
fi

case "$UNAME" in
  Darwin)
    if command -v brew >/dev/null 2>&1; then
      brew services start postgresql@16 2>/dev/null || brew services start postgresql 2>/dev/null || true
    fi
    ;;
  Linux)
    sudo systemctl start postgresql 2>/dev/null || sudo service postgresql start 2>/dev/null || true
    ;;
esac
exit 0
