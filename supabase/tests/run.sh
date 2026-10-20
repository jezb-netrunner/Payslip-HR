#!/usr/bin/env bash
# Replays every migration in supabase/migrations onto a scratch database with
# a minimal Supabase stub (00_supabase_stub.sql), then runs each
# 1*_tests.sql file. Needs a local Postgres (15+) reachable as a superuser
# through the usual libpq variables, e.g.
#   PGHOST=/tmp PGPORT=54329 PGUSER=postgres supabase/tests/run.sh
# Extra migration files given as arguments are applied after the repo's.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DB="${PGTEST_DB:-phr_test}"
P="psql -X -q -v ON_ERROR_STOP=1"
# Mirrors the live project: the owner's account predates the multi-client
# migrations (its 'admin' role must become 'company_admin').
OWNER="00000000-0000-0000-0000-0000000000c1"

$P -d postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null || exit 1
$P -d "$DB" -f "$HERE/00_supabase_stub.sql" >/dev/null || exit 1

owner_added=0
for f in "$REPO"/supabase/migrations/*.sql "$@"; do
  [ -f "$f" ] || continue
  case "$f" in
    *multi_client*)
      if [ $owner_added = 0 ]; then
        $P -d "$DB" -c "insert into auth.users (id, email) values ('$OWNER', 'owner@example.test')" >/dev/null || exit 1
        owner_added=1
      fi ;;
  esac
  out="$($P -d "$DB" -f "$f" 2>&1)" || { echo "FAILED applying $(basename "$f")"; echo "$out"; exit 1; }
done
echo "migrations applied"

status=0
for t in "$HERE"/1*_tests.sql; do
  echo "== $(basename "$t")"
  out="$($P -d "$DB" -f "$t" 2>&1)" || status=1
  echo "$out" | grep -E "^---|ERROR|CONTEXT|PASSED|CHECK FAILED"
done
exit $status
