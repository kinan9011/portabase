#!/usr/bin/env bash
# W02b: reproduce the agent's restic repository password OFFLINE and open a REAL lab restic repo with it (A2, D24, D26).
#   password = hex( HKDF-SHA256(ikm = master key, salt = "", info = "portabase/restic/v1/<generatedId>", L = 32) )
#   (agent:src/domain/files/restic/password.rs:4-7 + utils/edge_key.rs:52-68; dash:src/lib/restic/repo.ts:22-27)
# Steps: stock agent writes a restic snapshot (demo-compose-snapshot) -> password via `openssl kdf ... HKDF` -> `restic cat config`
# + `snapshots` + `restore` through the READ-ONLY pull identity (the DR-host situation) -> restored files == source; a wrong
# password and a wrong generatedId must fail; the openssl value must equal an independent RFC 5869 implementation (python hmac).
# Lab only. The master key stays in a 0600 file / process env; the password goes to restic through RESTIC_PASSWORD (not argv).
# NOTE (recorded in the ADR note): `openssl kdf` takes the key as an argv option (-kdfopt hexkey:...), visible in the process
# list for the duration of the call. Acceptable on a DR host used by one operator; W14b may prefer the python path below.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
X="$RES/restic-hkdf"; rm -rf "$X"; mkdir -p "$X"; chmod 700 "$X"
fail=0
ok()  { log "PASS $*"; }
bad() { log "FAIL $*"; fail=1; }
command -v restic >/dev/null && command -v openssl >/dev/null || { echo "restic and openssl >= 3 are required" >&2; exit 1; }
[ "$(openssl version | awk '{print $2}' | cut -d. -f1)" -ge 3 ] || { echo "openssl >= 3 required" >&2; exit 1; }

( umask 077; docker exec -u 0 forklab-portabase-dashboard-1 cat /data/private/keys/master_key.bin | xxd -p -c64 > "$X/master.hex" )
trap 'rm -rf "$X/master.hex"' EXIT

b=$(trigger_backup demo-compose-snapshot); r=$(wait_backup "$b" 120); log "demo-compose-snapshot: $r"
case "$r" in success*) ;; *) bad "restic backup did not succeed"; exit 1;; esac
GID=$(pq -c "select agent_database_id from databases where name='demo-compose-snapshot' and deleted_at is null")
REPO="s3:http://127.0.0.1:19000/lab-primary/backups/restic/$GID"

derive_openssl() { # generatedId -> hex password
  openssl kdf -keylen 32 -kdfopt digest:SHA256 -kdfopt "hexkey:$(cat "$X/master.hex")" -kdfopt "info:portabase/restic/v1/$1" -binary HKDF | xxd -p -c64
}
derive_python() { # independent RFC 5869 (salt omitted => HashLen zeros), expand one block
  python3 -I - "$X/master.hex" "portabase/restic/v1/$1" <<'PY'
import hmac, hashlib, sys
ikm = bytes.fromhex(open(sys.argv[1]).read().strip())
prk = hmac.new(b"\x00" * 32, ikm, hashlib.sha256).digest()
print(hmac.new(prk, sys.argv[2].encode() + b"\x01", hashlib.sha256).hexdigest())
PY
}
PW=$(derive_openssl "$GID"); PWPY=$(derive_python "$GID")
[ ${#PW} = 64 ] && [ "$PW" = "$PWPY" ] && ok "openssl kdf HKDF == independent RFC 5869 implementation (64 hex chars)" || bad "openssl kdf result differs from the reference"

# read-only pull identity (what a DR host with storage credentials only would hold)
export AWS_ACCESS_KEY_ID="$LAB_S3_PULL_KEY" AWS_SECRET_ACCESS_KEY="$LAB_S3_PULL_SECRET" RESTIC_CACHE_DIR="$X/cache"
rs() { RESTIC_PASSWORD="$1" restic -r "$REPO" --no-lock "${@:2}"; }  # --no-lock: the pull identity is read-only, restic would otherwise try to write a lock object

rs "$PW" cat config >"$X/config.json" 2>"$X/cat.err" && grep -q '"version"' "$X/config.json" && ok "restic cat config opens the real repo with the openssl-derived password" || { bad "restic could not open the repo"; head -3 "$X/cat.err"; }
n=$(rs "$PW" snapshots --json 2>/dev/null | python3 -I -c 'import json,sys;print(len(json.load(sys.stdin)))'); [ "${n:-0}" -ge 1 ] && ok "snapshots listed ($n)" || bad "no snapshots listed"
rs "$PW" restore latest --target "$X/restored" >/dev/null 2>&1 && ok "restic restore latest OK with read-only credentials" || bad "restic restore failed"
f=$(find "$X/restored" -name compose.yml | head -1)
[ -n "$f" ] && cmp -s "$f" "$LAB/demo-stack/compose.yml" && ok "restored compose.yml == source (diff=0)" || bad "restored compose.yml differs from the source"

# negatives: fail closed, and for the RIGHT reason (restic exit 12 = "wrong password or no key found", not a network/permission error)
rs "$PW" cat config >/dev/null 2>&1 || bad "control: right password must still work"
neg() { # label password
  rs "$2" cat config >/dev/null 2>"$X/neg.err"; local c=$?
  [ "$c" = 12 ] && ok "$1 rejected (restic exit 12: wrong password)" || bad "$1: expected restic exit 12, got $c ($(head -c 120 "$X/neg.err"))"
}
neg "wrong password" "$(printf '%064d' 0)"
neg "password derived for a different generatedId (info string binds the repo)" "$(derive_openssl 00000000-0000-0000-0000-000000000000)"
neg "raw master key (HKDF step is required)" "$(cat "$X/master.hex")"

log "restic-hkdf done fail=$fail"; exit $fail
