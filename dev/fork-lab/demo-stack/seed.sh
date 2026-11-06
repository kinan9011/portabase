#!/usr/bin/env bash
# Deterministic synthetic data for the demo stack (W02). Lab only.
#   seed.sh                 seed everything, print the checksums
#   seed.sh --write-expected  seed + write expected.json (committed; the oracle for every restore diff)
#   seed.sh --verify        seed, then fail (exit 1) if any checksum differs from expected.json
# Same inputs -> same bytes: no randomness, no timestamps in hashed content.
set -euo pipefail
cd "$(dirname "$0")"
MODE="${1:-}"
PGIMG="postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b"
AGENTIMG="ghcr.io/portabase/agent:1.25.2@sha256:e8f2b52eb4e59ed652d63d853a6bf517c31e9d41e3556115a2534ecbdde9df9f"
DC=(docker compose -f compose.yml -f compose.override.yml)

# the lab proxy network is external; create it if the lab was not started through lab.sh
docker network inspect lab_proxy >/dev/null 2>&1 || docker network create lab_proxy >/dev/null

"${DC[@]}" up -d db web >/dev/null 2>&1
"${DC[@]}" exec -T db sh -c 'until pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; do sleep 1; done'

# 1. uploads/ (bind mount): 20 files, content derived from the index only
mkdir -p uploads
find uploads -type f ! -name .gitkeep -delete
for i in $(seq 1 20); do seq 1 $((i * 37)) | sed "s/^/upload-$i-/" > "uploads/file-$(printf '%02d' "$i").txt"; done

# 2. postgres rows
"${DC[@]}" exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null <<'SQL'
DROP TABLE IF EXISTS items;
CREATE TABLE items(id integer PRIMARY KEY, payload text NOT NULL);
INSERT INTO items SELECT g, md5(g::text) || md5((g*7)::text) FROM generate_series(1,500) g;
SQL

# 3. named volume appdata (10 files)
docker run --rm -v forklab-demo_appdata:/vol "$PGIMG" sh -c \
  'find /vol -mindepth 1 -delete; for i in $(seq 1 10); do seq 1 $((i * 50)) > /vol/file-$i.txt; done'

# 4. sqlite file inside named volume sqlitedata (WAL mode, 200 rows, writer NOT running)
docker run --rm -v forklab-demo_sqlitedata:/data --entrypoint sh "$AGENTIMG" -c '
  find /data -mindepth 1 -delete
  sqlite3 /data/app.db "PRAGMA journal_mode=WAL; CREATE TABLE ledger(id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
    WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<200)
    INSERT INTO ledger SELECT i, hex(zeroblob(32)) || i FROM c;" >/dev/null
  sqlite3 /data/app.db "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null'

# ---- checksums (the same functions are used by drills/restore-diff.sh) ----
dirsum() { (cd "$1" && find . -type f ! -name .gitkeep | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1); }
compose_sha=$(cat compose.yml compose.override.yml stack.env | sha256sum | cut -d' ' -f1)
uploads_sha=$(dirsum uploads)
db_sha=$("${DC[@]}" exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select string_agg(id||chr(58)||payload, chr(44) order by id) from items"' | sha256sum | cut -d' ' -f1)
vol_sha=$(docker run --rm -v forklab-demo_appdata:/vol "$PGIMG" sh -c 'cd /vol && find . -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d" " -f1')
sqlite_sha=$(docker run --rm -v forklab-demo_sqlitedata:/data --entrypoint sh "$AGENTIMG" -c \
  'out=$(sqlite3 /data/app.db "select group_concat(id||char(58)||payload, char(44)) from (select * from ledger order by id)") && [ -n "$out" ] && printf "%s\n" "$out" | sha256sum | cut -d" " -f1')
[ -n "$sqlite_sha" ] || { echo "sqlite checksum failed" >&2; exit 1; }

json=$(printf '{\n  "compose_dir": "%s",\n  "uploads": "%s",\n  "postgres_items": "%s",\n  "volume_appdata": "%s",\n  "sqlite_ledger": "%s"\n}\n' \
  "$compose_sha" "$uploads_sha" "$db_sha" "$vol_sha" "$sqlite_sha")

case "$MODE" in
  --write-expected) printf '%s\n' "$json" > expected.json; echo "expected.json written" ;;
  --verify)
    if diff <(printf '%s\n' "$json") expected.json >/dev/null; then echo "seed verify: OK (matches expected.json)"; else
      echo "seed verify: MISMATCH" >&2; diff <(printf '%s\n' "$json") expected.json >&2 || true; exit 1; fi ;;
  *) printf '%s\n' "$json" ;;
esac
