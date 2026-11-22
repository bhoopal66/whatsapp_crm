#!/usr/bin/env bash
# Apply a range of supabase/migrations files to a database, in order.
#
#   DATABASE_URL='postgresql://postgres:<password>@<host>:5432/postgres' \
#     scripts/apply-migrations.sh 236 256
#
# - Runs each file in its own psql call (autocommit, like a hand apply:
#   CLAUDE.md "Database migrations"), with ON_ERROR_STOP, and stops at the
#   first failure. The files are re-runnable, so fix the cause and run the
#   script again from the number that failed.
# - Takes a pg_dump backup first (custom format, in ./backups/). Set
#   SKIP_BACKUP=1 to skip it, e.g. when the host already took a snapshot.
# - Checks the role first: several migrations refuse to apply unless the
#   role is a superuser or has BYPASSRLS.
# - Ends with NOTIFY pgrst so PostgREST reloads its schema cache.
#
# Apply the range BEFORE deploying the build that needs it: the changelog's
# "Migration required" notes say which files must precede the deploy.
set -euo pipefail

from="${1:?usage: apply-migrations.sh FROM TO (e.g. 236 256)}"
to="${2:?usage: apply-migrations.sh FROM TO (e.g. 236 256)}"
: "${DATABASE_URL:?set DATABASE_URL to the database connection string}"

cd "$(dirname "$0")/.."

files=()
for f in supabase/migrations/[0-9][0-9][0-9]_*.sql; do
  n=$((10#$(basename "$f" | cut -c1-3)))
  if (( n >= 10#$from && n <= 10#$to )); then files+=("$f"); fi
done
if (( ${#files[@]} == 0 )); then
  echo "No migration files between $from and $to." >&2
  exit 1
fi

role_ok=$(psql "$DATABASE_URL" -XAtqc \
  "select coalesce((select rolsuper or rolbypassrls from pg_roles where rolname = current_user), false)")
if [[ "$role_ok" != "t" ]]; then
  echo "The connecting role is neither a superuser nor BYPASSRLS; some of these" >&2
  echo "migrations refuse to apply. Connect as such a role and run again." >&2
  exit 1
fi

if [[ "${SKIP_BACKUP:-0}" != "1" ]]; then
  mkdir -p backups
  backup="backups/before-${from}-${to}-$(date +%Y%m%d-%H%M%S).dump"
  echo "Backing up to $backup ..."
  if ! pg_dump "$DATABASE_URL" -Fc -f "$backup"; then
    rm -f "$backup"
    echo >&2
    echo "Backup failed, so nothing was applied. If pg_dump is older than the" >&2
    echo "server (\"server version mismatch\"), install the matching client" >&2
    echo "(e.g. postgresql-client-17), or take a snapshot in your host's" >&2
    echo "dashboard and run again with SKIP_BACKUP=1." >&2
    exit 1
  fi
fi

echo "Applying ${#files[@]} migration(s):"
for f in "${files[@]}"; do
  echo "  $(basename "$f")"
  if ! psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f "$f"; then
    echo >&2
    echo "FAILED: $(basename "$f"). Nothing after it was applied." >&2
    echo "Fix the cause, then run again from $(basename "$f" | cut -c1-3)." >&2
    exit 1
  fi
done

psql "$DATABASE_URL" -X -q -c "NOTIFY pgrst, 'reload schema';"
echo "Done: ${#files[@]} migration(s) applied; PostgREST told to reload."
