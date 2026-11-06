#!/usr/bin/env bash
# W02 spike matrix, part 1: back up every source type through the upstream `waiting`-row path, then prove each artifact
# restores to a NEW location (artifact extracted by hand into results/extract/, never over the live data) with 0 diff vs
# demo-stack/expected.json. Part 2 (restore in place through the dashboard) = restore-diff.sh. Lab only.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
X="$RES/extract"; mkdir -p "$X"
fail=0
ok() { log "PASS $*"; }
bad() { log "FAIL $*"; fail=1; }
exp() { python3 -c "import json,sys;print(json.load(open('$LAB/demo-stack/expected.json'))['$1'])"; }
dirsum() { (cd "$1" && find . -type f ! -name .gitkeep | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1); }

# fresh state first: the seed is the oracle
bash "$LAB/demo-stack/seed.sh" --verify >/dev/null || { bad "seed does not match expected.json"; exit 1; }

declare -A BID
for s in demo-compose-dir demo-uploads demo-appdata-volume demo-postgres demo-sqlite-voltar demo-compose-snapshot; do
  BID[$s]=$(trigger_backup "$s"); log "waiting row for $s -> ${BID[$s]}"
done
for s in "${!BID[@]}"; do r=$(wait_backup "${BID[$s]}"); log "$s: $r"; done

artifact() { # name -> prints host path of the extracted tar.gz
  local p; p=$(pq -c "select bs.path from backup_storage bs where bs.backup_id='${BID[$1]}' and bs.status='success'")
  mc_lab "mc cat lab/lab-primary/$p" > "$X/$1.tar.gz" && echo "$X/$1.tar.gz"
}
unpack() { local d="$X/$1"; mkdir -p "$d"; find "$d" -mindepth 1 -delete; tar -xzf "$(artifact "$1")" -C "$d" && echo "$d"; }

# --- uploads (files/archive) ---
d=$(unpack demo-uploads); log "uploads artifact tree: $(cd "$d" && find . -type f | head -2 | tr '\n' ' ')..."
# files/archive tars hold the directory CONTENTS at the tar root (no top directory)
[ "$(dirsum "$d")" = "$(exp uploads)" ] && ok "uploads restore-to-new-path diff=0" || bad "uploads differ"

# --- compose dir + .env (files/archive) ---
d=$(unpack demo-compose-dir); top="$d"
if diff -q "$top/compose.yml" "$LAB/demo-stack/compose.yml" && diff -q "$top/stack.env" "$LAB/demo-stack/stack.env" && diff -q "$top/compose.override.yml" "$LAB/demo-stack/compose.override.yml"; then ok "compose dir + env file restore-to-new-path diff=0"; else bad "compose dir differs"; fi

# --- docker-volume appdata ---
d=$(unpack demo-appdata-volume); vol=$(find "$d" -type d -name vol | head -1); vol=${vol:-$d}
[ "$(dirsum "$vol")" = "$(exp volume_appdata)" ] && ok "docker-volume restore-to-new-path diff=0" || { bad "docker-volume differs"; (cd "$d" && find . | head -5); }

# --- postgres: restore the dump into a NEW database in the demo postgres, compare row checksum ---
d=$(unpack demo-postgres); dump=$(find "$d" -type f | head -1); log "postgres artifact file: $(basename "$dump") ($(stat -c %s "$dump") B)"
DEMO="docker compose -f $LAB/demo-stack/compose.yml -f $LAB/demo-stack/compose.override.yml"
$DEMO exec -T db sh -c 'psql -U "$POSTGRES_USER" -d postgres -qc "drop database if exists demo_restore" -c "create database demo_restore"'
$DEMO exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d demo_restore --no-owner' < "$dump" && log "pg_restore into demo_restore ok"
got=$($DEMO exec -T db sh -c 'psql -U "$POSTGRES_USER" -d demo_restore -Atc "select string_agg(id||chr(58)||payload, chr(44) order by id) from items"' | sha256sum | cut -d' ' -f1)
[ "$got" = "$(exp postgres_items)" ] && ok "postgresql restore-to-new-database diff=0" || bad "postgres rows differ"
$DEMO exec -T db sh -c 'psql -U "$POSTGRES_USER" -d postgres -qc "drop database demo_restore"'

# --- sqlite-in-volume via docker-volume tar (quiescent writer): consistent? ---
d=$(unpack demo-sqlite-voltar); db=$(find "$d" -name app.db | head -1)
got=$(docker run --rm -v "$(dirname "$db"):/x:ro" --entrypoint sh "$AGENTIMG" -c 'cp -r /x /y && sqlite3 /y/app.db "select group_concat(id||char(58)||payload, char(44)) from (select * from ledger order by id)" | sha256sum | cut -d" " -f1')
[ "$got" = "$(exp sqlite_ledger)" ] && ok "sqlite (docker-volume tar, writer stopped) restore-to-new-path diff=0" || bad "sqlite differs"

# --- snapshot (restic) artifact exists in the bucket ---
n=$(mc_lab "mc ls -r lab/lab-primary/backups/restic/ | wc -l"); [ "$n" -gt 3 ] && ok "snapshot repository present in storage ($n objects); restore of restic = dashboard path (restore-diff.sh)" || bad "no restic repo"

log "matrix done fail=$fail"; exit $fail
