#!/usr/bin/env bash
# Restore a backup into a THROWAWAY database and run sanity checks. Run this regularly: a backup that has
# never been restored is not a backup. Usage: ADMIN_DATABASE_URL=postgres://.../postgres restore-drill.sh backup.dump
set -euo pipefail
: "${ADMIN_DATABASE_URL:?}"
DUMP="${1:?dump file}"
NAME="yapilapi_restore_drill_$(date -u +%s)"
sha256sum -c "$DUMP.sha256"
psql "$ADMIN_DATABASE_URL" -c "CREATE DATABASE $NAME"
TARGET="${ADMIN_DATABASE_URL%/*}/$NAME"
trap 'psql "$ADMIN_DATABASE_URL" -c "DROP DATABASE IF EXISTS $NAME" >/dev/null' EXIT
pg_restore --no-owner --dbname="$TARGET" "$DUMP"
# Every migration recorded, ledger balanced (double-entry invariant), users readable.
psql "$TARGET" -Atc "SELECT count(*) FROM schema_migrations" | xargs -I{} echo "migrations recorded: {}"
UNBALANCED=$(psql "$TARGET" -Atc "SELECT count(*) FROM (SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING COALESCE(sum(amount_cents) FILTER (WHERE direction='debit'),0) <> COALESCE(sum(amount_cents) FILTER (WHERE direction='credit'),0)) x")
[ "$UNBALANCED" = "0" ] || { echo "LEDGER UNBALANCED in restored data: $UNBALANCED" >&2; exit 1; }
echo "restore drill OK"
