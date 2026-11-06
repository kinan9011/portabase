#!/usr/bin/env bash
# W02b: archive round-trip. The STOCK agent (1.25.2, encryption ON) backs up one DB (demo-postgres) and one docker volume
# (demo-appdata-volume); each `.tar.gz.enc` object is fetched from MinIO, decrypted with scripts/fork/recover/decrypt-archive
# using the lab master key, then: `gzip -t`, tar listing, plaintext checked against the lab oracle (volume: directory checksum;
# postgres: pg_restore into a NEW database + row checksum), truncated copy must be rejected.
#   archive-roundtrip.sh                  verify only (writes nothing into the git tree)
#   archive-roundtrip.sh --write-fixtures also copy both archives + fixtures.json into scripts/fork/recover/fixtures/
# Lab only. The lab master key is random per lab; with --write-fixtures it is committed as an explicit TEST-ONLY key - reset the
# lab afterwards (lab.sh reset). The key is never printed; it only moves through a 0600 temp file in results/ (git-ignored).
set -uo pipefail
. "$(dirname "$0")/lib.sh"
WRITE=0; [ "${1:-}" = "--write-fixtures" ] && WRITE=1
REPO="$(cd "$LAB/../.." && pwd)"
HELPER="$REPO/scripts/fork/recover/decrypt-archive"
FIXDIR="$REPO/scripts/fork/recover/fixtures"
X="$RES/roundtrip"; rm -rf "$X"; mkdir -p "$X"; chmod 700 "$X"
KEYF="$X/master.key"
fail=0
ok()  { log "PASS $*"; }
bad() { log "FAIL $*"; fail=1; }
exp() { python3 -c "import json;print(json.load(open('$LAB/demo-stack/expected.json'))['$1'])"; }
dirsum() { (cd "$1" && find . -type f ! -name .gitkeep | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1); }
sha() { sha256sum "$1" | cut -d' ' -f1; }

# lab master key -> 0600 file (never echoed). Same file the upstream dashboard uses for credential-crypto.
( umask 077; docker exec -u 0 forklab-portabase-dashboard-1 cat /data/private/keys/master_key.bin | base64 -w0 > "$KEYF" )
[ "$(base64 -d "$KEYF" | wc -c)" = 32 ] || { bad "lab master key is not 32 bytes"; exit 1; }

# encryption ON: the same column the settings UI toggle writes; restored on exit
PREV=$(pq -c "select coalesce(encryption,false) from settings limit 1")
pq -c "update settings set encryption=true" >/dev/null
cleanup() { pq -c "update settings set encryption=$([ "$PREV" = t ] && echo true || echo false)" >/dev/null; rm -f "$KEYF"; }
trap cleanup EXIT
log "encryption setting: was=$PREV now=$(pq -c 'select encryption from settings limit 1')"

bash "$LAB/demo-stack/seed.sh" --verify >/dev/null || { bad "seed does not match expected.json"; exit 1; }

declare -A BID PATHS
for s in demo-postgres demo-appdata-volume; do
  BID[$s]=$(trigger_backup "$s"); log "waiting row for $s -> ${BID[$s]}"
done
for s in demo-postgres demo-appdata-volume; do
  r=$(wait_backup "${BID[$s]}"); log "$s: $r"
  case "$r" in success*) ;; *) bad "$s backup did not succeed"; exit 1;; esac
  PATHS[$s]=$(pq -c "select bs.path from backup_storage bs where bs.backup_id='${BID[$s]}' and bs.status='success'")
  mc_lab "mc cat lab/lab-primary/${PATHS[$s]}" > "$X/$s.tar.gz.enc"
  log "$s object: $(basename "${PATHS[$s]}") $(stat -c %s "$X/$s.tar.gz.enc") B"
  # encrypted by the stock agent: header line must be the documented JSON, and the object must NOT be a plain gzip
  head -c 80 "$X/$s.tar.gz.enc" | head -1 | grep -q '^{"version":1,"cipher":"AES-256-GCM","chunk_size":' && ok "$s: documented header present" || bad "$s: no documented header (encryption off?)"
  gzip -t "$X/$s.tar.gz.enc" 2>/dev/null && bad "$s: object is a plain gzip (not encrypted)" || ok "$s: not a plain gzip (encrypted)"
done

dec() { python3 -I "$HELPER" --key-file "$KEYF" "$@"; }
for s in demo-postgres demo-appdata-volume; do
  out=$(dec "$X/$s.tar.gz.enc" "$X/$s.tar.gz") || { bad "$s: decrypt-archive failed"; continue; }
  PSHA=$(sha "$X/$s.tar.gz"); PSIZE=$(stat -c %s "$X/$s.tar.gz")
  [ "$out" = "sha256=$PSHA size=$PSIZE" ] && ok "$s: decrypt-archive $out" || bad "$s: helper output '$out' != independent sha256sum/stat $PSHA/$PSIZE"
  gzip -t "$X/$s.tar.gz" && ok "$s: gzip -t OK" || bad "$s: gzip -t failed"
  tar -tzf "$X/$s.tar.gz" >/dev/null && ok "$s: tar listing OK" || bad "$s: tar listing failed"
  # fail closed on the real artifact: truncated copy, wrong key, wrong expected hash
  head -c -7 "$X/$s.tar.gz.enc" > "$X/$s.trunc"
  dec "$X/$s.trunc" "$X/$s.trunc.out" 2>/dev/null && bad "$s: truncated archive accepted" || { [ ! -e "$X/$s.trunc.out" ] && ok "$s: truncated archive rejected, no output left"; }
  dec --expect-sha256 "$(printf 0%.0s $(seq 64))" "$X/$s.tar.gz.enc" "$X/$s.badhash" 2>/dev/null && bad "$s: wrong expected hash accepted" || { [ ! -e "$X/$s.badhash" ] && ok "$s: wrong expected hash rejected"; }
  ( umask 077; head -c 32 /dev/urandom | base64 -w0 > "$X/other.key" )
  python3 -I "$HELPER" --key-file "$X/other.key" "$X/$s.tar.gz.enc" "$X/$s.wrongkey" 2>/dev/null && bad "$s: wrong key accepted" || ok "$s: wrong key rejected"
done

# oracle 1: docker-volume plaintext == seeded volume
d="$X/x-volume"; mkdir -p "$d"; tar -xzf "$X/demo-appdata-volume.tar.gz" -C "$d"
vol=$(find "$d" -type d -name vol | head -1); vol=${vol:-$d}
[ "$(dirsum "$vol")" = "$(exp volume_appdata)" ] && ok "volume archive plaintext == seeded volume (diff=0)" || bad "volume plaintext differs from the seed oracle"

# oracle 2: postgres dump restores into a NEW database with the seeded rows
d="$X/x-pg"; mkdir -p "$d"; tar -xzf "$X/demo-postgres.tar.gz" -C "$d"; dump=$(find "$d" -type f | head -1)
DEMO="docker compose -f $LAB/demo-stack/compose.yml -f $LAB/demo-stack/compose.override.yml"
$DEMO exec -T db sh -c 'psql -U "$POSTGRES_USER" -d postgres -qc "drop database if exists demo_roundtrip" -c "create database demo_roundtrip"' >/dev/null
$DEMO exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d demo_roundtrip --no-owner' < "$dump" && log "pg_restore ok ($(basename "$dump"))"
got=$($DEMO exec -T db sh -c 'psql -U "$POSTGRES_USER" -d demo_roundtrip -Atc "select string_agg(id||chr(58)||payload, chr(44) order by id) from items"' | sha256sum | cut -d' ' -f1)
[ "$got" = "$(exp postgres_items)" ] && ok "postgres dump plaintext restores into a new DB, rows == seed (diff=0)" || bad "postgres rows differ from the seed oracle"
$DEMO exec -T db sh -c 'psql -U "$POSTGRES_USER" -d postgres -qc "drop database demo_roundtrip"' >/dev/null

if [ "$WRITE" = 1 ] && [ "$fail" = 0 ]; then
  mkdir -p "$FIXDIR"
  cp "$X/demo-postgres.tar.gz.enc"      "$FIXDIR/lab-postgres.tar.gz.enc"
  cp "$X/demo-appdata-volume.tar.gz.enc" "$FIXDIR/lab-volume.tar.gz.enc"
  python3 - "$X" "$FIXDIR" "$KEYF" "$AGENTIMG" <<'PY'
import hashlib, json, os, sys
x, fix, keyf, img = sys.argv[1:5]
sha = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
def entry(name, src, kind, dumpdesc):
    enc, pt = f"{x}/{src}.tar.gz.enc", f"{x}/{src}.tar.gz"
    return {"name": name, "file": f"{name}.tar.gz.enc", "source": kind,
            "ciphertext_sha256": sha(enc), "ciphertext_size": os.path.getsize(enc),
            "plaintext_sha256": sha(pt), "plaintext_size": os.path.getsize(pt), "plaintext_is": dumpdesc}
doc = {
    "test_only": True,
    "warning": "master_key_b64 is a throw-away TEST-ONLY lab key (generated by dev/fork-lab, lab reset afterwards). It protects nothing; never reuse it, never put a real key in this directory.",
    "produced_by": {"agent_image": img, "agent_version": "1.25.2", "encryption": "setting.encryption=true", "script": "dev/fork-lab/drills/archive-roundtrip.sh --write-fixtures"},
    "master_key_b64": open(keyf).read().strip(),
    "fixtures": [
        entry("lab-postgres", "demo-postgres", "demo-postgres (postgresql, synthetic 500-row items table)", "tar.gz of the agent's pg_dump output"),
        entry("lab-volume", "demo-appdata-volume", "demo-appdata-volume (docker-volume, synthetic files)", "tar.gz of the volume contents under vol/"),
    ],
}
json.dump(doc, open(f"{fix}/fixtures.json", "w"), indent=2); open(f"{fix}/fixtures.json", "a").write("\n")
print("fixtures written:", [f["name"] for f in doc["fixtures"]])
PY
fi
log "archive-roundtrip done fail=$fail"; exit $fail
