#!/usr/bin/env bash
# One-time setup: install npm dependencies, ensure ~/.opensprint exists,
# write default SQLite databaseUrl to global-settings if missing, apply schema.
# Optional: set USE_POSTGRES=1 to install/start local PostgreSQL and create user/DB.
# Run from repo root: npm run setup
# Idempotent; safe to run again.

set -e

echo "==> Open Sprint setup"

if ! command -v git >/dev/null 2>&1; then
  echo "==> Git is required for setup but was not found in PATH."
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "==> Run setup from the repository root (inside a git working tree)."
  exit 1
fi

# Ensure repository-local git user identity exists so automated commits can run on fresh machines.
DEFAULT_GIT_NAME="${OPENSPRINT_DEFAULT_GIT_NAME:-Open Sprint}"
DEFAULT_GIT_EMAIL="${OPENSPRINT_DEFAULT_GIT_EMAIL:-example@example.com}"
if ! git config --get user.name >/dev/null 2>&1; then
  git config user.name "$DEFAULT_GIT_NAME"
  echo "==> Set local git user.name to \"$DEFAULT_GIT_NAME\""
fi
if ! git config --get user.email >/dev/null 2>&1; then
  git config user.email "$DEFAULT_GIT_EMAIL"
  echo "==> Set local git user.email to \"$DEFAULT_GIT_EMAIL\""
fi

MINIMAL_SETUP=0
if [ "${OPENSPRINT_SETUP_MINIMAL:-0}" = "1" ]; then
  MINIMAL_SETUP=1
  echo "==> Minimal setup mode: installing shared/backend/frontend deps only (skipping Electron/Puppeteer workspace deps)"
  npm install --include-workspace-root=false -w packages/shared -w packages/backend -w packages/frontend
  # Keep root `npm run dev` usable without installing the full root dependency set.
  npm install --no-save concurrently
else
  npm install
fi

# Ensure ~/.opensprint exists and global-settings has default databaseUrl if missing
npx tsx scripts/ensure-global-settings.ts

# Backend setup helpers import @opensprint/shared, whose dist output is not present
# on a fresh install until we build it explicitly.
npm run build -w packages/shared
npm run build -w packages/backend

is_wsl() {
  [ -n "${WSL_DISTRO_NAME:-}" ] || [ -n "${WSL_INTEROP:-}" ] || \
    grep -qi microsoft /proc/version 2>/dev/null
}

print_wsl_setup_guidance() {
  cat <<'EOF'
==> Open Sprint Windows support requires running npm run setup and npm run dev inside WSL2.
==> PostgreSQL must already be reachable from WSL before continuing.
==> Supported database options:
    - PostgreSQL running inside your WSL distro on localhost:5432
    - PostgreSQL exposed to WSL on localhost:5432 from Docker Desktop or similar
    - Remote PostgreSQL configured via DATABASE_URL or ~/.opensprint/global-settings.json
==> Store your project repo in the WSL filesystem (for example /home/<user>/src/app), not under /mnt/c/...
EOF
}

# --- Install and start PostgreSQL (platform-specific), create user and DB ---
OS_USER="opensprint"
OS_PASSWORD="opensprint"
OS_DB="opensprint"
OS_TEST_DB="opensprint_test"
APP_POSTGRES_DB_URL="postgresql://${OS_USER}:${OS_PASSWORD}@localhost:5432/postgres"
APP_MAIN_DB_URL="postgresql://${OS_USER}:${OS_PASSWORD}@localhost:5432/${OS_DB}"
APP_TEST_DB_URL="postgresql://${OS_USER}:${OS_PASSWORD}@localhost:5432/${OS_TEST_DB}"
POSTGRES_SUPERUSER_DB_URL="postgresql://postgres:${OS_PASSWORD}@localhost:5432/postgres"

can_connect_with_url() {
  local db_url="$1"
  psql "$db_url" -tAc "SELECT 1" >/dev/null 2>&1
}

run_psql_with_url() {
  local db_url="$1"
  shift
  psql "$db_url" "$@"
}

can_connect_as_postgres_os_user() {
  if ! command -v sudo >/dev/null 2>&1; then
    return 1
  fi
  sudo -u postgres psql -d postgres -tAc "SELECT 1" >/dev/null 2>&1
}

run_psql_as_postgres_os_user() {
  if ! command -v sudo >/dev/null 2>&1; then
    return 1
  fi
  sudo -u postgres psql "$@"
}

database_exists_with_url() {
  local db_url="$1"
  local db_name="$2"
  [ "$(psql "$db_url" -tAc "SELECT 1 FROM pg_database WHERE datname = '${db_name}'" 2>/dev/null | tr -d '[:space:]')" = "1" ]
}

database_exists_as_postgres_os_user() {
  local db_name="$1"
  [ "$(sudo -u postgres psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '${db_name}'" 2>/dev/null | tr -d '[:space:]')" = "1" ]
}

ensure_local_postgres_role_and_databases_via_password() {
  local bootstrap_url=""

  if can_connect_with_url "$APP_POSTGRES_DB_URL" && \
     can_connect_with_url "$APP_MAIN_DB_URL" && \
     can_connect_with_url "$APP_TEST_DB_URL"; then
    return 0
  fi

  if ! can_connect_with_url "$POSTGRES_SUPERUSER_DB_URL"; then
    return 1
  fi

  echo "==> opensprint login failed or local databases are missing. Bootstrapping with postgres/opensprint..."
  bootstrap_url="$POSTGRES_SUPERUSER_DB_URL"

  run_psql_with_url "$bootstrap_url" -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${OS_USER}') THEN
    CREATE ROLE ${OS_USER} WITH LOGIN PASSWORD '${OS_PASSWORD}' CREATEDB;
  ELSE
    ALTER ROLE ${OS_USER} WITH PASSWORD '${OS_PASSWORD}';
    ALTER ROLE ${OS_USER} CREATEDB;
  END IF;
END
\$\$;
SQL

  if ! database_exists_with_url "$bootstrap_url" "$OS_DB"; then
    run_psql_with_url "$bootstrap_url" -c "CREATE DATABASE ${OS_DB} OWNER ${OS_USER};" >/dev/null
  fi
  if ! database_exists_with_url "$bootstrap_url" "$OS_TEST_DB"; then
    run_psql_with_url "$bootstrap_url" -c "CREATE DATABASE ${OS_TEST_DB} OWNER ${OS_USER};" >/dev/null
  fi

  can_connect_with_url "$APP_MAIN_DB_URL" && can_connect_with_url "$APP_TEST_DB_URL"
}

ensure_local_postgres_role_and_databases_via_peer_auth() {
  if ! can_connect_as_postgres_os_user; then
    return 1
  fi

  echo "==> opensprint login failed. Bootstrapping with sudo -u postgres psql..."

  run_psql_as_postgres_os_user -d postgres -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${OS_USER}') THEN
    CREATE ROLE ${OS_USER} WITH LOGIN PASSWORD '${OS_PASSWORD}' CREATEDB;
  ELSE
    ALTER ROLE ${OS_USER} WITH PASSWORD '${OS_PASSWORD}';
    ALTER ROLE ${OS_USER} CREATEDB;
  END IF;
END
\$\$;
SQL

  if ! database_exists_as_postgres_os_user "$OS_DB"; then
    run_psql_as_postgres_os_user -d postgres -c "CREATE DATABASE ${OS_DB} OWNER ${OS_USER};" >/dev/null
  fi
  if ! database_exists_as_postgres_os_user "$OS_TEST_DB"; then
    run_psql_as_postgres_os_user -d postgres -c "CREATE DATABASE ${OS_TEST_DB} OWNER ${OS_USER};" >/dev/null
  fi

  can_connect_with_url "$APP_MAIN_DB_URL" && can_connect_with_url "$APP_TEST_DB_URL"
}

bootstrap_wsl_local_postgres_if_possible() {
  if ! command -v psql >/dev/null 2>&1; then
    return 0
  fi

  if ensure_local_postgres_role_and_databases_via_password || \
     ensure_local_postgres_role_and_databases_via_peer_auth; then
    echo "==> PostgreSQL ready (user ${OS_USER}, databases ${OS_DB} and ${OS_TEST_DB})"
  fi
}

install_and_start_postgres_mac() {
  if ! command -v brew >/dev/null 2>&1; then
    echo "==> Homebrew not found. Install from https://brew.sh or use a remote Postgres and set databaseUrl in ~/.opensprint/global-settings.json"
    return 1
  fi
  if ! brew list postgresql@18 >/dev/null 2>&1 && ! brew list postgresql >/dev/null 2>&1; then
    echo "==> Installing PostgreSQL via Homebrew..."
    brew install postgresql@18 2>/dev/null || brew install postgresql
  fi
  # Prefer postgresql@18 if present, else postgresql
  if brew list postgresql@18 >/dev/null 2>&1; then
    PG_PREFIX="$(brew --prefix postgresql@18)"
    brew services start postgresql@18 2>/dev/null || true
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
  if ensure_local_postgres_role_and_databases_via_password; then
    echo "==> PostgreSQL ready (user ${OS_USER}, databases ${OS_DB} and ${OS_TEST_DB})"
    return 0
  fi
  # Create role and database (idempotent; ignore errors if already exist). CREATEDB lets test teardown recreate opensprint_test.
  psql -d postgres -c "CREATE ROLE ${OS_USER} WITH LOGIN PASSWORD '${OS_PASSWORD}' CREATEDB;" 2>/dev/null || \
    psql -d postgres -c "ALTER ROLE ${OS_USER} WITH PASSWORD '${OS_PASSWORD}';" 2>/dev/null || true
  psql -d postgres -c "ALTER ROLE ${OS_USER} CREATEDB;" 2>/dev/null || true
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
  if ensure_local_postgres_role_and_databases_via_password; then
    echo "==> PostgreSQL ready (user ${OS_USER}, databases ${OS_DB} and ${OS_TEST_DB})"
    return 0
  fi
  sudo -u postgres psql -d postgres -c "CREATE ROLE ${OS_USER} WITH LOGIN PASSWORD '${OS_PASSWORD}';" 2>/dev/null || \
    sudo -u postgres psql -d postgres -c "ALTER ROLE ${OS_USER} WITH PASSWORD '${OS_PASSWORD}';" 2>/dev/null || true
  sudo -u postgres psql -d postgres -c "CREATE DATABASE ${OS_DB} OWNER ${OS_USER};" 2>/dev/null || true
  sudo -u postgres psql -d postgres -c "CREATE DATABASE ${OS_TEST_DB} OWNER ${OS_USER};" 2>/dev/null || true
  echo "==> PostgreSQL ready (user ${OS_USER}, databases ${OS_DB} and ${OS_TEST_DB})"
  return 0
}

UNAME="$(uname -s)"
IS_WSL=0
if [ "$UNAME" = "Linux" ] && is_wsl; then
  IS_WSL=1
fi

# Optional: install and start PostgreSQL (set USE_POSTGRES=1 to enable)
if [ "${USE_POSTGRES:-0}" = "1" ]; then
  case "$UNAME" in
    Darwin)
      install_and_start_postgres_mac || true
      ;;
    Linux)
      if [ "$IS_WSL" -eq 1 ]; then
        echo "==> WSL detected. Skipping package-manager and service-manager PostgreSQL setup."
        bootstrap_wsl_local_postgres_if_possible
      else
        install_and_start_postgres_linux || true
      fi
      ;;
    *)
      echo "==> Unsupported OS for PostgreSQL. Use SQLite (default) or set databaseUrl in Settings."
      ;;
  esac
else
  echo "==> Using SQLite by default (data in ~/.opensprint/data/opensprint.sqlite). Set USE_POSTGRES=1 to install PostgreSQL."
fi

# Apply database schema (SQLite or PostgreSQL per global-settings) so the backend can start
echo "==> Applying database schema..."
if [ "$IS_WSL" -eq 1 ]; then
  if npx tsx scripts/ensure-db-schema.ts; then
    echo "==> Database schema applied"
  else
    print_wsl_setup_guidance
    exit 1
  fi
else
  if npx tsx scripts/ensure-db-schema.ts 2>/dev/null; then
    echo "==> Database schema applied"
  else
    echo "==> Could not apply schema. Backend will apply schema on first start."
  fi
fi

if [ "$IS_WSL" -eq 1 ]; then
  echo "==> Setup complete. Run: npm run dev from your WSL terminal"
else
  echo "==> Setup complete. Run: npm run dev"
fi
if [ "$MINIMAL_SETUP" -eq 1 ]; then
  echo "==> Minimal mode skipped desktop/tooling packages. For desktop builds or full tooling, run: npm install"
fi
echo "==> To use PostgreSQL instead of SQLite, see Settings in the app or set databaseUrl in ~/.opensprint/global-settings.json"
