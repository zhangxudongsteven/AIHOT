#!/usr/bin/env bash
# Run on the application server. The existing PostgreSQL is never managed by this script.
set -Eeuo pipefail
umask 077

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
env_file="$root/.env.lan"
action=
phase=checks
backup_dir=

usage() {
  cat <<'HELP'
Usage: bash scripts/deploy-lan.sh [--env-file PATH] check|deploy|status|logs|stop

Run this script on the server from a checkout or unpacked release. Docker Compose
and its daemon are required; Node.js and PostgreSQL tools run inside the image.
The environment file defaults to .env.lan at the repository root. It must be a
private regular file (chmod 600), not a symlink. Within the repository only
.env.lan or a file under .data/ is allowed; other paths must be outside the build
context so credentials cannot enter the image. Its application settings take
precedence over inherited shell values; the regular .env and docker-compose.yml
are never loaded.

  check   Validate Compose configuration and Docker daemon access; no containers start.
  deploy  Build, check the database, stop the app, back up database/files, migrate,
          start with health checks, then run website smoke checks including MCP initialize.
  status  Show this deployment's API, worker and Web containers.
  logs    Follow their last 100 log lines (Ctrl-C exits).
  stop    Gracefully stop only API, worker and Web; preserve PostgreSQL and data volumes.

Stop any other API/worker/import writers connected to this database before deploy.
Backups are kept in .data/lan-backups with private permissions; they are not deleted
automatically. Archive validation is not a full restore rehearsal. A failed backup
or migration leaves the application stopped for inspection; no rollback is attempted.
Multi-channel identity cutover remains a separate, explicitly confirmed operation.
HELP
}

fail() { printf '%s\n' "$*" >&2; exit 1; }
on_error() {
  local result=$?
  trap - ERR
  printf 'LAN deployment command failed during %s (exit %s).\n' "$phase" "$result" >&2
  if [[ -n "$backup_dir" ]]; then printf 'Backup directory: %s\n' "$backup_dir" >&2; fi
  case "$phase" in
    stopping|backup|migration) printf 'Do not restart an old image automatically; inspect the failure and backup first.\n' >&2 ;;
    startup|smoke) printf 'Inspect status and logs; the new application may be running. No automatic rollback was performed.\n' >&2 ;;
  esac
  exit "$result"
}
trap on_error ERR

while (($#)); do
  case "$1" in
    --env-file)
      (($# >= 2)) || fail '--env-file requires a path.'
      env_file=$2
      shift 2
      ;;
    --help|-h) usage; exit 0 ;;
    check|deploy|status|logs|stop)
      [[ -z "$action" ]] || fail 'Choose only one action.'
      action=$1
      shift
      ;;
    *) fail "Unknown argument: $1" ;;
  esac
done
if [[ -z "$action" ]]; then usage; exit 0; fi

[[ ! -L "$env_file" ]] || fail 'The LAN environment file must be a regular file, not a symlink.'
[[ -f "$env_file" && -r "$env_file" ]] || fail 'The private LAN environment file is missing or unreadable. Copy deploy/lan.env.example, fill it in, then chmod 600 the copy.'
env_file=$(cd "$(dirname "$env_file")" && printf '%s/%s' "$(pwd -P)" "$(basename "$env_file")")
# Docker COPY includes ordinary files anywhere in the checkout. Resolve parent
# symlinks before allowing only the two locations explicitly excluded by .dockerignore.
case "$env_file" in
  "$root/.env.lan"|"$root/.data/"*) ;;
  "$root/"*) fail 'Inside the repository, use only .env.lan or .data/ for the private environment file; otherwise keep it outside the Docker build context.' ;;
esac
permissions=$(stat -c '%a' "$env_file" 2>/dev/null || stat -f '%Lp' "$env_file")
[[ "$permissions" =~ ^[0-7]+$ ]] || fail 'Could not inspect environment file permissions.'
(( (8#$permissions & 077) == 0 )) || fail 'The LAN environment file is readable by other users; run chmod 600 on it.'
command -v docker > /dev/null || fail 'Docker with the Compose plugin is required.'

# Compose normally lets exported variables override --env-file. Clear only inputs
# used by this deployment; keep PATH, HOME and Docker connection/context settings.
compose() {
  env -u DATABASE_URL -u PGPASSWORD -u DATABASE_POOL_MAX -u SITE_URL -u PORT \
    -u ADMIN_PASSWORD -u SESSION_SECRET -u IMG_PROXY_SIGN_SECRET -u AIHOT_RELEASE -u LOG_LEVEL \
    -u COMPOSE_FILE -u COMPOSE_PROJECT_NAME -u COMPOSE_PROFILES -u COMPOSE_ENV_FILES \
    -u COMPOSE_DISABLE_ENV_FILE \
    docker compose --project-directory "$root" --project-name myhot-lan \
    --env-file "$env_file" -f "$root/compose.lan.yml" "$@"
}

docker compose version > /dev/null
compose config --quiet
docker info > /dev/null

case "$action" in
  check)
    printf 'Compose configuration and Docker daemon access passed. No containers were started.\n'
    exit 0
    ;;
  status) compose ps --all api worker web; exit 0 ;;
  logs) compose logs --follow --tail 100 api worker web; exit 0 ;;
  stop)
    phase=stopping
    compose stop api worker web
    printf 'Application stopped; existing PostgreSQL and data volumes were preserved.\n'
    exit 0
    ;;
esac

up_help=$(compose up --help)
[[ "$up_help" == *'--wait-timeout'* ]] || fail 'This deployment requires Docker Compose up --wait and --wait-timeout; update the Compose plugin before deploying.'
command -v tar > /dev/null || fail 'tar is required to validate the file backup.'

phase=build
printf 'Building the new image before stopping the running application...\n'
compose build setup api worker web

phase=preflight
compose run --rm --no-deps -T setup node --input-type=module - <<'NODE'
import { spawnSync } from 'node:child_process';
import { assertProductionSecrets, config } from '@aihot/backend/config';
import { DEPLOYMENT } from '@aihot/site';
import { sql, closeDb } from '@aihot/backend/db';

try {
  const connection = new URL(config.databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(connection.protocol) || !connection.hostname || !connection.pathname.slice(1)) {
    throw new Error('DATABASE_URL must identify the existing PostgreSQL host and database.');
  }
  if (connection.password || connection.searchParams.has('password') || connection.searchParams.has('user')) {
    throw new Error('Keep credentials out of DATABASE_URL query parameters and put the password in PGPASSWORD.');
  }
  if (!process.env.PGPASSWORD) throw new Error('PGPASSWORD is required.');
  const pool = Number(process.env.DATABASE_POOL_MAX);
  if (!Number.isInteger(pool) || pool < 2) throw new Error('DATABASE_POOL_MAX must be an integer of at least 2.');
  if (!config.adminPassword || config.adminPassword.length < 12) throw new Error('ADMIN_PASSWORD must contain at least 12 characters.');
  assertProductionSecrets([['auth', 'SESSION_SECRET'], ['auth', 'IMG_PROXY_SIGN_SECRET'], ...DEPLOYMENT.requiredSecrets]);
  for (const name of ['COLLECT_ENABLED', 'MODEL_CALLS_ENABLED', 'FEISHU_CONTENT_PUSH_ENABLED', 'FEISHU_INTERNAL_ENABLED', 'INDEXNOW_SUBMIT_ENABLED']) {
    if (process.env[name] !== 'false') throw new Error(`${name} must remain false for LAN debugging.`);
  }
  const origin = new URL(config.siteUrl);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('SITE_URL must be an HTTP(S) origin without credentials, path, query or fragment.');
  }
  console.log('Environment validation passed; external actions remain disabled.');
} catch (error) {
  // Validation errors above contain field names only, never their values.
  console.error(error.message);
  await closeDb();
  process.exit(1);
}
try {
  const [row] = await sql`SELECT current_setting('server_version_num')::int AS version`;
  const dump = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' });
  const clientMajor = Number(dump.stdout?.match(/\b(\d+)\./)?.[1]);
  if (dump.status !== 0 || !clientMajor || Math.floor(row.version / 10000) > clientMajor) {
    throw new Error('The image pg_dump version cannot back up this PostgreSQL server.');
  }
  console.log('Read-only database connection and pg_dump compatibility checks passed.');
} catch (error) {
  // Connection errors can include connection details; emit only a code.
  console.error(`Database preflight failed (${error.code ?? 'connection or pg_dump compatibility'}).`);
  process.exitCode = 1;
} finally { await closeDb(); }
NODE

phase=stopping
printf 'Stopping API, worker and Web gracefully; the existing PostgreSQL stays running...\n'
compose stop api worker web

phase=backup
mkdir -p "$root/.data/lan-backups"
chmod 700 "$root/.data/lan-backups"
backup_dir=$(mktemp -d "$root/.data/lan-backups/$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
printf 'Backing up the stopped application database and data volume to %s...\n' "$backup_dir"
compose run --rm --no-deps -T setup node --input-type=module - > "$backup_dir/database.dump.partial" <<'NODE'
import { spawnSync } from 'node:child_process';
// Preflight required a password-free URL. PGPASSWORD stays in the child's environment.
const connection = new URL(process.env.DATABASE_URL);
if (connection.password || connection.searchParams.has('password') || connection.searchParams.has('user')) process.exit(1);
const result = spawnSync('pg_dump', ['--format=custom', '--compress=6', '--no-owner', '--no-password', connection.href], {
  env: { ...process.env, PGCONNECT_TIMEOUT: '10' }, stdio: ['ignore', 'inherit', 'inherit'],
});
process.exit(result.status ?? 1);
NODE
[[ -s "$backup_dir/database.dump.partial" ]] || fail 'Database backup is empty; application remains stopped.'
# Read/decompress the complete archive without connecting to or changing any database.
compose run --rm --no-deps -T setup pg_restore --file=/dev/null < "$backup_dir/database.dump.partial"
mv "$backup_dir/database.dump.partial" "$backup_dir/database.dump"
compose run --rm --no-deps -T setup tar -czf - -C /data . > "$backup_dir/data.tar.gz.partial"
tar -tzf "$backup_dir/data.tar.gz.partial" > /dev/null
mv "$backup_dir/data.tar.gz.partial" "$backup_dir/data.tar.gz"
printf 'Archive read checks passed. Backups retained at %s\n' "$backup_dir"

phase=migration
compose run --rm --no-deps -T setup

phase=startup
compose up -d --no-deps --wait --wait-timeout 240 api worker web

phase=smoke
compose exec -T web node scripts/smoke.ts --base http://127.0.0.1:3000
compose ps --all api worker web
printf 'Deployment health and smoke checks passed (including MCP initialize). Verify the LAN website from your browser next.\n'
