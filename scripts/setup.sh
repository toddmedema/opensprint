#!/usr/bin/env bash
# One-time setup: install npm dependencies, ensure ~/.opensprint exists,
# install/start local PostgreSQL, create opensprint user and database,
# write default databaseUrl to global-settings if missing, apply schema.
# Run from repo root: npm run setup
# Idempotent; safe to run again.

set -e

echo "==> OpenSprint setup"

npm install

# Ensure ~/.opensprint exists and global-settings has default databaseUrl if missing
npx tsx scripts/ensure-global-settings.ts

# --- Install and start PostgreSQL (platform-specific), create user and DB ---
OS_USER="opensprint"
OS_PASSWORD="opensprint"
OS_DB="opensprint"
OS_TEST_DB="opensprint_test"

install_and_start_postgres_mac() {
  if ! command -v brew >/dev/null 2>&1; then
    echo "==> Homebrew not found. Install from https://brew.sh or use a remote Postgres and set databaseUrl in ~/.opensprint/global-settings.json"
    return 1
  fi
  if ! brew list postgresql@16 >/dev/null 2>&1 && ! brew list postgresql >/dev/null 2>&1; then
    echo "==> Installing PostgreSQL via Homebrew..."
    brew install postgresql@16 2>/dev/null || brew install postgresql
  fi
  # Prefer postgresql@16 if present, else postgresql
  if brew list postgresql@16 >/dev/null 2>&1; then
    PG_PREFIX="$(brew --prefix postgresql@16)"
    brew services start postgresql@16 2>/dev/null || true
  else
    PG_PREFIX="$(brew --prefix postgresql)"
    brew services start postgresql 2>/dev/null || true
  fi
  export PATH="${PG_PREFIX}/bin:${PATH}"
  # Wait for Postgres to accept connections (Unix socket)
  echo "==> Waiting for PostgreSQL to be ready..."
  for i in $(seq 1 30); do
    if psql -d postgres -tAc "SELECT 1" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  if ! psql -d postgres -tAc "SELECT 1" >/dev/null 2>&1; then
    echo "==> PostgreSQL did not become ready. Check: brew services list"
    return 1
  fi
  # Create role and database (idempotent; ignore errors if already exist)
  psql -d postgres -c "CREATE ROLE ${OS_USER} WITH LOGIN PASSWORD '${OS_PASSWORD}';" 2>/dev/null || \
    psql -d postgres -c "ALTER ROLE ${OS_USER} WITH PASSWORD '${OS_PASSWORD}';" 2>/dev/null || true
  psql -d postgres -c "CREATE DATABASE ${OS_DB} OWNER ${OS_USER};" 2>/dev/null || true
  psql -d postgres -c "CREATE DATABASE ${OS_TEST_DB} OWNER ${OS_USER};" 2>/dev/null || true
  echo "==> PostgreSQL ready (user ${OS_USER}, databases ${OS_DB} and ${OS_TEST_DB})"
  return 0
}

install_and_start_postgres_linux() {
  if command -v apt-get >/dev/null 2>&1; then
    if ! command -v psql >/dev/null 2>&1; then
      echo "==> Installing PostgreSQL via apt..."
      sudo apt-get update -qq && sudo apt-get install -y postgresql postgresql-contrib
    fi
    sudo systemctl start postgresql 2>/dev/null || sudo service postgresql start 2>/dev/null || true
  elif command -v yum >/dev/null 2>&1 || command -v dnf >/dev/null 2>&1; then
    if ! command -v psql >/dev/null 2>&1; then
      echo "==> Installing PostgreSQL via yum/dnf..."
      (command -v dnf >/dev/null 2>&1 && sudo dnf install -y postgresql-server postgresql) || \
        sudo yum install -y postgresql-server postgresql
      sudo postgresql-setup initdb 2>/dev/null || true
    fi
    sudo systemctl start postgresql 2>/dev/null || sudo service postgresql start 2>/dev/null || true
  else
    echo "==> Unsupported Linux package manager. Install PostgreSQL and create user/database manually, or set databaseUrl in ~/.opensprint/global-settings.json"
    return 1
  fi
  echo "==> Waiting for PostgreSQL to be ready..."
  for i in $(seq 1 30); do
    if sudo -u postgres psql -d postgres -tAc "SELECT 1" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  if ! sudo -u postgres psql -d postgres -tAc "SELECT 1" >/dev/null 2>&1; then
    echo "==> PostgreSQL did not become ready. Check: sudo systemctl status postgresql"
    return 1
  fi
  sudo -u postgres psql -d postgres -c "CREATE ROLE ${OS_USER} WITH LOGIN PASSWORD '${OS_PASSWORD}';" 2>/dev/null || \
    sudo -u postgres psql -d postgres -c "ALTER ROLE ${OS_USER} WITH PASSWORD '${OS_PASSWORD}';" 2>/dev/null || true
  sudo -u postgres psql -d postgres -c "CREATE DATABASE ${OS_DB} OWNER ${OS_USER};" 2>/dev/null || true
  sudo -u postgres psql -d postgres -c "CREATE DATABASE ${OS_TEST_DB} OWNER ${OS_USER};" 2>/dev/null || true
  echo "==> PostgreSQL ready (user ${OS_USER}, databases ${OS_DB} and ${OS_TEST_DB})"
  return 0
}

UNAME="$(uname -s)"
case "$UNAME" in
  Darwin)
    install_and_start_postgres_mac || true
    ;;
  Linux)
    install_and_start_postgres_linux || true
    ;;
  MINGW*|MSYS*)
    echo "==> On Windows, install PostgreSQL from https://www.postgresql.org/download/windows/ or use Chocolatey: choco install postgresql"
    echo "    Create user 'opensprint' with password 'opensprint', databases 'opensprint' and 'opensprint_test', or set databaseUrl in ~/.opensprint/global-settings.json"
    ;;
  *)
    echo "==> Unsupported OS. Install PostgreSQL and set databaseUrl in ~/.opensprint/global-settings.json"
    ;;
esac

# Apply database schema (tables and indexes) so the backend can start without errors
echo "==> Applying database schema..."
if npx tsx scripts/ensure-db-schema.ts 2>/dev/null; then
  echo "==> Database schema applied"
else
  echo "==> Could not apply schema (is Postgres running and user/db created?). Backend will apply schema on first start."
fi

echo "==> Setup complete. Run: npm run dev"
