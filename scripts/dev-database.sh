#!/usr/bin/env bash
# A project-owned PostgreSQL 17 instance. Never uses DATABASE_URL or a system service.
set -euo pipefail
umask 077

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
state="$root/.data/dev-postgres"
data="$state/data"
port=55432
role=aihot_dev
action=${1:-status}

fail() { printf '%s\n' "$*" >&2; exit 1; }
case "$action" in start|stop|status) ;; *) fail 'Usage: bash scripts/dev-database.sh start|stop|status' ;; esac

if [[ -z "${PG_BIN:-}" ]]; then
  for candidate in /opt/homebrew/opt/postgresql@17/bin /usr/local/opt/postgresql@17/bin /usr/lib/postgresql/17/bin; do
    if [[ -x "$candidate/postgres" ]]; then PG_BIN=$candidate; break; fi
  done
fi
[[ -n "${PG_BIN:-}" && -x "$PG_BIN/postgres" ]] || fail 'PostgreSQL 17 is required. Install it or set PG_BIN to its bin directory.'
[[ $("$PG_BIN/postgres" --version) == *' 17.'* ]] || fail 'Use PostgreSQL 17 to match the project CI.'

if [[ -f "$state/project-root" ]]; then
  [[ $(cat "$state/project-root") == "$root" ]] || fail 'This database belongs to a different checkout; refusing to operate it.'
elif [[ -e "$data" ]]; then
  fail 'Existing data directory has no project ownership marker; refusing to operate it.'
elif [[ "$action" != start ]]; then
  printf 'Project database is not initialized.\n'
  exit 0
fi

if [[ "$action" == start ]]; then
  mkdir -p "$state"
  chmod 700 "$state"
  if [[ ! -f "$data/PG_VERSION" ]]; then
    [[ ! -e "$data" ]] || fail 'Incomplete data directory; inspect it before retrying initialization.'
    if [[ ! -f "$state/password" ]]; then openssl rand -hex 24 > "$state/password"; fi
    if ! "$PG_BIN/initdb" -D "$data" -U "$role" --encoding=UTF8 --locale=C \
      --auth-host=scram-sha-256 --auth-local=scram-sha-256 --pwfile="$state/password" > "$state/initdb.log" 2>&1; then
      tail -n 20 "$state/initdb.log" >&2
      fail 'PostgreSQL initialization failed; see the log above.'
    fi
    cat >> "$data/postgresql.conf" <<'CONFIG'

# Project-local development only; no Unix socket or network interface exposure.
listen_addresses = '127.0.0.1'
port = 55432
unix_socket_directories = ''
CONFIG
    printf '%s\n' "$root" > "$state/project-root"
  fi
  [[ -f "$state/password" ]] || fail 'Project database password file is missing.'
  if ! "$PG_BIN/pg_ctl" -D "$data" status > /dev/null 2>&1; then
    "$PG_BIN/pg_ctl" -D "$data" -l "$state/server.log" -w start
  fi
elif [[ "$action" == stop ]]; then
  if "$PG_BIN/pg_ctl" -D "$data" status > /dev/null 2>&1; then
    "$PG_BIN/pg_ctl" -D "$data" -m fast -w stop
  else
    printf 'Project database is already stopped.\n'
  fi
  exit 0
else
  if ! "$PG_BIN/pg_ctl" -D "$data" status; then exit 1; fi
fi

# Explicit connection settings prevent inherited libpq service/options or ~/.pgpass from being used.
unset PGSERVICE PGSERVICEFILE PGOPTIONS PGHOSTADDR
export PGHOST=127.0.0.1 PGPORT="$port" PGUSER="$role" PGDATABASE=postgres PGSSLMODE=disable PGPASSFILE=/dev/null
PGPASSWORD=$(cat "$state/password")
export PGPASSWORD
actual_data=$("$PG_BIN/psql" -X -At -v ON_ERROR_STOP=1 -c 'SHOW data_directory')
[[ "$actual_data" == "$data" ]] || fail 'The listening server is not this project database.'

if [[ "$action" == start ]]; then
  for database in aihot_dev aihot_test aihot_space_test; do
    exists=$("$PG_BIN/psql" -X -At -v ON_ERROR_STOP=1 -c "SELECT 1 FROM pg_database WHERE datname = '$database'")
    if [[ "$exists" != 1 ]]; then "$PG_BIN/createdb" "$database"; fi
  done
  printf 'DATABASE_URL=postgres://%s:%s@127.0.0.1:%s/aihot_dev\n' "$role" "$PGPASSWORD" "$port" > "$state/dev.env"
  cat >> "$state/dev.env" <<'ENV'
SITE_URL=http://127.0.0.1:3000
API_BASE_URL=http://127.0.0.1:3001
API_HOST=127.0.0.1
API_PORT=3001
PORT=127.0.0.1:3000
COLLECT_ENABLED=false
MODEL_CALLS_ENABLED=false
FEISHU_CONTENT_PUSH_ENABLED=false
FEISHU_INTERNAL_ENABLED=false
INDEXNOW_SUBMIT_ENABLED=false
ENV
  printf 'AIHOT_DATA_DIR="%s/.data/dev-app"\nAIHOT_CREDENTIALS_DIR="%s/no-credentials"\n' "$root" "$state" >> "$state/dev.env"
  printf 'DATABASE_URL=postgres://%s:%s@127.0.0.1:%s/aihot_test\n' "$role" "$PGPASSWORD" "$port" > "$state/test.env"
  printf 'MULTI_SPACE_DATABASE_URL=postgres://%s:%s@127.0.0.1:%s/aihot_space_test\n' "$role" "$PGPASSWORD" "$port" > "$state/proof.env"
fi
"$PG_BIN/psql" -X -At -v ON_ERROR_STOP=1 -c "SELECT 'PostgreSQL ' || current_setting('server_version') || ' on ' || inet_server_addr() || ':' || inet_server_port()"
printf 'Project data: %s\n' "$data"
printf 'Connection files: .data/dev-postgres/{dev,test,proof}.env (private, Git-ignored)\n'
