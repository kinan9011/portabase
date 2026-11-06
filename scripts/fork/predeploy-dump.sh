#!/usr/bin/env bash
# Deploy-time pg_dump (W01, ADR-003 rollback story). Take this BEFORE every deploy / upstream sync:
# upstream migrations run before the fork lane and cannot be dumped from inside the app.
# Rollback of a deploy = restore this dump (fork and upstream migrations are forward-only).
#   DATABASE_URL=postgres://... scripts/fork/predeploy-dump.sh [output-dir]
#   restore (app stopped): DROP the database and CREATE it empty, then  pg_restore --no-owner -d <db> <file>
#   NOT `pg_restore --clean` into the live DB: it only drops objects that exist in the dump, so tables a bad
#   deploy ADDED (e.g. new fork_* tables) would survive (verified in the W01 rollback drill).
# The password is passed to pg_dump through PGPASSWORD (never argv). The dump holds the whole dashboard
# database (incl. encrypted secrets): 0700 dir, 0600 file, keep it off shared storage.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
OUT="${1:-${PRIVATE_PATH:-./private}/backups/predeploy}"
umask 077
mkdir -p "$OUT"; chmod 700 "$OUT"
eval "$(node -e '
  const u = new URL(process.env.DATABASE_URL);
  const q = (v) => "\x27" + String(v).replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
  const out = [["PGHOST", u.hostname], ["PGPORT", u.port || "5432"], ["PGUSER", decodeURIComponent(u.username)],
               ["PGPASSWORD", decodeURIComponent(u.password)], ["PGDATABASE", decodeURIComponent(u.pathname.slice(1))]];
  const ssl = u.searchParams.get("sslmode"); if (ssl) out.push(["PGSSLMODE", ssl]);
  console.log(out.map(([k, v]) => "export " + k + "=" + q(v)).join("\n"));
')"
FILE="$OUT/portabase-predeploy-$(date -u +%Y%m%dT%H%M%SZ).dump"
"${FORK_PG_DUMP_BIN:-pg_dump}" --format=custom --no-password --file "$FILE"
chmod 600 "$FILE"
echo "predeploy dump written: $FILE"
