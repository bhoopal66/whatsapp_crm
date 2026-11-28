#!/usr/bin/env bash
# Apply a range of supabase/migrations files to a database, in order.
#
#   DATABASE_URL='postgresql://postgres:<password>@<host>:5432/postgres' \
#     scripts/apply-migrations.sh 236 256
#
#   scripts/apply-migrations.sh --status 236 256   # read only
#
# - Runs each file in its own psql call (autocommit, like a hand apply:
#   CLAUDE.md "Database migrations"), with ON_ERROR_STOP, and stops at the
#   first failure. The files are re-runnable, so fix the cause and run the
#   script again from the number that failed.
# - Takes a pg_dump backup first (custom format, in ./backups/). Set
#   SKIP_BACKUP=1 to skip it, e.g. when the host already took a snapshot.
# - Checks the role first: several migrations refuse to apply unless the
#   role is a superuser or has BYPASSRLS.
# - Holds a session advisory lock (key 338001) on a separate connection for
#   the whole run, so a second run against the same database exits at once.
#   Use a session connection (direct, or Supabase's "Session pooler"), not a
#   transaction pooler: those cannot hold a session lock.
# - Records each applied file in public.migration_ledger (migration 338):
#   its name and the sha256 of its bytes. Before applying, a file whose
#   recorded sha256 differs from the file now (it was edited after it was
#   applied) stops the run, nothing applied, unless ALLOW_DRIFT=1; an
#   unchanged file is simply applied again. Until 338 is applied the ledger
#   is skipped with a note, so this script can apply 338 itself.
# - --status FROM TO lists each file as applied / changed / not recorded
#   and applies nothing (no lock, no backup).
# - Ends with NOTIFY pgrst so PostgREST reloads its schema cache.
#
# DATABASE_URL is read from the environment only; the script never prints
# it. Apply the range BEFORE deploying the build that needs it: the
# changelog's "Migration required" notes say which files must precede the
# deploy.
set -euo pipefail

usage='usage: apply-migrations.sh [--status] FROM TO (e.g. 236 256)'
status_only=0
if [[ "${1:-}" == "--status" ]]; then
  status_only=1
  shift
fi
from="${1:?$usage}"
to="${2:?$usage}"
if [[ ! "$from" =~ ^[0-9]{1,3}$ || ! "$to" =~ ^[0-9]{1,3}$ ]]; then
  echo "$usage" >&2
  exit 1
fi
: "${DATABASE_URL:?set DATABASE_URL to the database connection string}"

LOCK_KEY=338001

cd "$(dirname "$0")/.."

q() { psql "$DATABASE_URL" -X -A -t -q -v ON_ERROR_STOP=1 "$@"; }

file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

files=()
for f in supabase/migrations/[0-9][0-9][0-9]_*.sql; do
  n=$((10#$(basename "$f" | cut -c1-3)))
  if (( n >= 10#$from && n <= 10#$to )); then files+=("$f"); fi
done
if (( ${#files[@]} == 0 )); then
  echo "No migration files between $from and $to." >&2
  exit 1
fi

role_ok=$(q -c "select coalesce((select rolsuper or rolbypassrls from pg_roles where rolname = current_user), false)")
if [[ "$role_ok" != "t" ]]; then
  echo "The connecting role is neither a superuser nor BYPASSRLS; some of these" >&2
  echo "migrations refuse to apply. Connect as such a role and run again." >&2
  exit 1
fi

# --- Ledger helpers -------------------------------------------------------
ledger=0
ledger_rows=''
ledger_check() {
  local present
  present=$(q -c "select to_regclass('public.migration_ledger') is not null")
  if [[ "$present" == "t" ]]; then ledger=1; fi
}
ledger_load() {
  ledger_rows=$(q -F $'\t' -c "select file_name, sha256, to_char(applied_at, 'YYYY-MM-DD HH24:MI TZ'), applied_by from public.migration_ledger")
}
# Prints "sha256<TAB>applied_at<TAB>applied_by" for a file name, or nothing.
ledger_lookup() {
  awk -F'\t' -v n="$1" '$1 == n { print $2 "\t" $3 "\t" $4; exit }' <<<"$ledger_rows"
}
ledger_record() {
  q -v name="$1" -v sha="$2" <<'SQL'
INSERT INTO public.migration_ledger (file_name, sha256) VALUES (:'name', :'sha')
ON CONFLICT (file_name) DO UPDATE
  SET sha256 = EXCLUDED.sha256, applied_at = now(), applied_by = current_user;
SQL
}

ledger_check
if (( ledger )); then ledger_load; fi

# --- --status: report and stop --------------------------------------------
if (( status_only )); then
  if (( ! ledger )); then
    echo "No migration ledger yet (338 not applied): nothing is recorded."
  fi
  applied=0 changed=0 unrecorded=0
  for f in "${files[@]}"; do
    name=$(basename "$f")
    rec=$(ledger_lookup "$name")
    if [[ -z "$rec" ]]; then
      printf '  %-52s not recorded\n' "$name"
      unrecorded=$((unrecorded + 1))
      continue
    fi
    IFS=$'\t' read -r rsha rat rby <<<"$rec"
    sha=$(file_sha256 "$f")
    if [[ "$rsha" == "$sha" ]]; then
      printf '  %-52s applied       %s by %s\n' "$name" "$rat" "$rby"
      applied=$((applied + 1))
    else
      printf '  %-52s changed       %s by %s (recorded %s, file now %s)\n' \
        "$name" "$rat" "$rby" "${rsha:0:12}" "${sha:0:12}"
      changed=$((changed + 1))
    fi
  done
  echo "${#files[@]} file(s): $applied applied, $changed changed since applied, $unrecorded not recorded."
  exit 0
fi

# --- Lock: one run at a time ----------------------------------------------
# A second psql session holds pg_advisory_lock for as long as this script
# runs: its stdin is a FIFO this script keeps open, so it ends (and the
# lock is released) when the script exits, however it exits.
workdir=$(mktemp -d "${TMPDIR:-/tmp}/apply-migrations.XXXXXX")
lock_pid=''
cleanup() {
  exec 3>&- 2>/dev/null || true
  if [[ -n "$lock_pid" ]]; then wait "$lock_pid" 2>/dev/null || true; fi
  rm -rf "$workdir"
}
trap cleanup EXIT
mkfifo "$workdir/lock.in"
psql "$DATABASE_URL" -X -A -t -q -v ON_ERROR_STOP=1 \
  <"$workdir/lock.in" >/dev/null 2>"$workdir/lock.err" &
lock_pid=$!
exec 3>"$workdir/lock.in"
( trap '' PIPE
  printf "select pg_try_advisory_lock(%s) \\\\g '%s'\n" "$LOCK_KEY" "$workdir/lock.got" >&3
) 2>/dev/null || true
got=''
for _ in $(seq 1 300); do
  if [[ -s "$workdir/lock.got" ]]; then
    got=$(tr -d '[:space:]' <"$workdir/lock.got")
    break
  fi
  kill -0 "$lock_pid" 2>/dev/null || break
  sleep 0.1
done
if [[ "$got" == "f" ]]; then
  echo "Another apply-migrations run holds the lock on this database" >&2
  echo "(advisory lock $LOCK_KEY). Nothing was applied; wait for it to finish." >&2
  exit 1
elif [[ "$got" != "t" ]]; then
  echo "Could not take the migration lock; nothing was applied." >&2
  cat "$workdir/lock.err" >&2
  exit 1
fi
lock_alive() { kill -0 "$lock_pid" 2>/dev/null; }

# --- Drift check ----------------------------------------------------------
# Re-read under the lock: a run that finished a moment ago may have
# recorded more files.
ledger_check
if (( ledger )); then
  ledger_load
  drift=()
  for f in "${files[@]}"; do
    name=$(basename "$f")
    rec=$(ledger_lookup "$name")
    [[ -n "$rec" ]] || continue
    IFS=$'\t' read -r rsha rat rby <<<"$rec"
    sha=$(file_sha256 "$f")
    if [[ "$rsha" != "$sha" ]]; then
      drift+=("$name (applied $rat by $rby as ${rsha:0:12}, file now ${sha:0:12})")
    fi
  done
  if (( ${#drift[@]} > 0 )); then
    echo "These files changed after they were applied to this database:" >&2
    printf '  %s\n' "${drift[@]}" >&2
    if [[ "${ALLOW_DRIFT:-0}" == "1" ]]; then
      echo "ALLOW_DRIFT=1: applying them anyway; the ledger records the new hashes." >&2
    else
      echo "Nothing was applied. Ship a change to an applied file as a new migration," >&2
      echo "or, if re-applying the edited file is intended, run again with ALLOW_DRIFT=1." >&2
      exit 1
    fi
  fi
else
  echo "Note: no migration ledger yet (338 not applied); not checking or recording until it exists."
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
unrecorded=()
for f in "${files[@]}"; do
  name=$(basename "$f")
  if ! lock_alive; then
    echo >&2
    echo "The lock session ended (connection lost?); stopping before $name." >&2
    echo "Run again from $(echo "$name" | cut -c1-3)." >&2
    exit 1
  fi
  # Hash the bytes that are about to be applied.
  sha=$(file_sha256 "$f")
  echo "  $name"
  if ! psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f "$f"; then
    echo >&2
    echo "FAILED: $name. Nothing after it was applied." >&2
    echo "Fix the cause, then run again from $(echo "$name" | cut -c1-3)." >&2
    exit 1
  fi
  unrecorded+=("$name $sha")
  if (( ! ledger )); then
    ledger_check
    if (( ledger )); then echo "  (ledger created; recording this run's files)"; fi
  fi
  if (( ledger )); then
    for entry in "${unrecorded[@]}"; do
      ledger_record "${entry% *}" "${entry##* }"
    done
    unrecorded=()
  fi
done

psql "$DATABASE_URL" -X -q -c "NOTIFY pgrst, 'reload schema';"
echo "Done: ${#files[@]} migration(s) applied; PostgREST told to reload."
