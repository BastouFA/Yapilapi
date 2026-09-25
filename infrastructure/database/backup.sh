#!/usr/bin/env bash
# Logical backup of the YAPILAPI database (custom format, compressed). Prefer PITR/WAL archiving from your
# managed Postgres for production; this is the portable fallback and the restore-drill tool.
# Usage: DATABASE_URL=postgres://... infrastructure/database/backup.sh /path/to/backups
set -euo pipefail
: "${DATABASE_URL:?}"
OUT="${1:?backup directory}"
mkdir -p "$OUT"
FILE="$OUT/yapilapi-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --format=custom --no-owner --file="$FILE" "$DATABASE_URL"
sha256sum "$FILE" > "$FILE.sha256"
echo "$FILE"
