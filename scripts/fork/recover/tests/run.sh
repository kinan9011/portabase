#!/usr/bin/env bash
# Shell tests for portabase-recover (W14b): plain bash asserts (bats is not a dependency of the bare-host tool).
# Builds REAL fixtures per case (restic repos on a local rclone remote, signed manifests, kit) with tests/mkstore.py and checks exit codes + messages.
# ALL keys are generated per run (TEST-ONLY). Docker-dependent cases are reported as SKIPPED (never as passed) when no docker daemon is reachable.
# Usage: bash scripts/fork/recover/tests/run.sh [filter-substring]
# shellcheck disable=SC2015  # ok()/bad() always succeed: `A && ok || bad` is an if/else here
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REC="$(dirname "$HERE")"
CLI="$REC/portabase-recover"; MK="$HERE/mkstore.py"
BASE="$(mktemp -d "${TMPDIR:-/tmp}/pbr-tests.XXXXXX")"
FILTER="${1:-}"; pass=0; fail=0; skip=0
docker_ok=0; docker info >/dev/null 2>&1 && docker image inspect busybox:latest >/dev/null 2>&1 && docker_ok=1
[ "$docker_ok" = 1 ] || { docker info >/dev/null 2>&1 && docker pull -q busybox:latest >/dev/null 2>&1 && docker_ok=1; }

# the tests' own docker project (pbrtest*) must never leak between runs
purge_docker() { [ "$docker_ok" = 1 ] || return 0; local p; for p in pbrtest pbrtest2; do docker compose -p "$p" down -v --remove-orphans >/dev/null 2>&1; docker volume rm -f "${p}_appdata" >/dev/null 2>&1; done; return 0; }
purge_docker; trap 'purge_docker; rm -rf "$BASE"' EXIT
ok()   { pass=$((pass + 1)); printf 'PASS  %s\n' "$1"; }
bad()  { fail=$((fail + 1)); printf 'FAIL  %s\n' "$1"; [ -z "${2:-}" ] || printf '      %s\n' "$2"; }
skipt(){ skip=$((skip + 1)); printf 'SKIP  %s (%s)\n' "$1" "$2"; }
want() { [ -z "$FILTER" ] || [[ $1 == *"$FILTER"* ]]; }

# new_case NAME [mkstore case] -> sets D (case dir), C (common args)
new_case() { D="$BASE/$1"; python3 -I "$MK" "$D" --case "${2:-ok}" || { bad "$1: fixture build" ; return 1; }; S="$(jq -r .store "$D/info.json")"; STACK="$(jq -r .stack "$D/info.json")"
  C=(--kit "$D/kit.pbkit" --passphrase-file "$D/pass.txt" --rclone-config "$D/rclone.conf" --storage-root "local:$S"); mkdir -p "$D/tmp"; }
run() { TMPDIR="$D/tmp" bash "$CLI" "$@" >"$D/out" 2>"$D/err"; RC=$?; ALL="$(cat "$D/out" "$D/err")"; }
expect() { # name rc regex
  local name=$1 rc=$2 re=$3
  if [ "$RC" = "$rc" ] && grep -Eq -- "$re" <<<"$ALL"; then ok "$name"; else bad "$name" "rc=$RC (want $rc); output: $(head -c 300 <<<"$ALL" | tr '\n' ' ')"; fi
}
no_secrets() { local name=$1 s; while read -r s; do [ -n "$s" ] || continue; if grep -qF -- "$s" <<<"$ALL"; then bad "$name: a secret appeared in the output"; return; fi; done <"$D/secrets.txt"; ok "$name: no key/passphrase in any output"; }
clean_tmp() { [ -z "$(find "$D/tmp" -mindepth 1 -print -quit)" ] && ok "$1: work folder removed" || bad "$1: work folder left behind"; }

t() { want "$1"; }

# ------------------------------------------------------------------ static
if t static; then
  ! grep -nE '(^|[;&|(] *)eval[ (]' "$CLI" >/dev/null && ok "static: no eval anywhere" || bad "static: eval found"
  ! grep -nE 'hexkey:|--key[ =]|--password[ =]' "$CLI" >/dev/null && ok "static: no secret option on any command line" || bad "static: secret on argv"
  grep -q 'set -Eeuo pipefail' "$CLI" && grep -q 'umask 077' "$CLI" && ok "static: strict mode + umask 077" || bad "static: strict mode"
  [ -x "$CLI" ] && [ -x "$REC/decrypt-archive" ] && [ -x "$REC/kit-tool" ] && ok "static: scripts are executable" || bad "static: scripts not executable"
  if command -v shellcheck >/dev/null 2>&1; then shellcheck -x -S style "$CLI" && ok "shellcheck (local binary)" || bad "shellcheck"
  elif docker image inspect koalaman/shellcheck:stable >/dev/null 2>&1 || docker pull -q koalaman/shellcheck:stable >/dev/null 2>&1; then docker run --rm -v "$REC:/mnt:ro" koalaman/shellcheck:stable -x -S style /mnt/portabase-recover && ok "shellcheck (docker image)" || bad "shellcheck"
  else skipt "shellcheck" "no shellcheck binary and no docker"; fi
fi

# ------------------------------------------------------------------ usage / prerequisites
if t usage; then
  D="$BASE/usage"; mkdir -p "$D/tmp"
  run help; expect "usage: help exits 0 and links the guide" 0 'my-server-died.md'
  run --help; expect "usage: --help exits 0" 0 'portabase-recover'
  run plan; expect "usage: no kit => exit 2" 2 'give the recovery kit'
  run restore --kit x; expect "usage: restore without --yes => exit 2" 2 'add --yes'
  run plan --kit a --paper-file b; expect "usage: kit and paper together => exit 2" 2 'not both'
  run plan --bogus; expect "usage: unknown option => exit 2" 2 'unknown option'
  mkdir -p "$D/shim"; printf '#!/bin/sh\necho "OpenSSL 1.1.1w  11 Sep 2023"\n' >"$D/shim/openssl"; chmod +x "$D/shim/openssl"
  PATH="$D/shim:$PATH" TMPDIR="$D/tmp" bash "$CLI" plan --kit x >"$D/out" 2>"$D/err"; RC=$?; ALL="$(cat "$D/out" "$D/err")"; expect "OpenSSL < 3 => refuse (exit 5)" 5 'OpenSSL 3.0 or newer'
fi

# ------------------------------------------------------------------ happy path (docker-free parts)
if t happy; then
  new_case happy ok
  run list "${C[@]}"; expect "list: finds the stack and recovery point (tags only)" 0 "$STACK.*"; grep -q 'not verified by list' <<<"$ALL" && ok "list: says it verified nothing" || bad "list: honesty line missing"
  run verify-kit "${C[@]}"; expect "verify-kit (digital): opens the repo, prints the code from the kit" 0 "$(jq -r .code "$D/info.json")"; no_secrets "verify-kit digital"; clean_tmp "verify-kit"
  run verify-kit --paper-file "$D/paper.txt" --rclone-config "$D/rclone.conf" --storage-root "local:$S"; expect "verify-kit (paper lines): same code" 0 "$(jq -r .code "$D/info.json")"; no_secrets "verify-kit paper"
  run verify-kit --paper-file "$D/paper.txt"; expect "verify-kit (paper, no storage access): refuses to print the code" 1 'no storage access'
  run verify-kit --paper-file "$D/paper.txt" --no-storage-check; expect "verify-kit --no-storage-check: prints code with a loud warning" 0 'NOT checked'
  run plan "${C[@]}"; expect "plan: signature valid + plan table, nothing changed" 0 'signature valid'; no_secrets "plan"; clean_tmp "plan"
  run plan --deep "${C[@]}"; expect "plan --deep: every archive verified (gzip, audit, hashes)" 0 'all archives verified'
  run plan "${C[@]}" --rp latest --min-sequence 1; expect "plan: --min-sequence 1 accepted" 0 'signature valid'
  printf 'wrong passphrase phrase!!\n' >"$D/badpass"; run plan --kit "$D/kit.pbkit" --passphrase-file "$D/badpass" --rclone-config "$D/rclone.conf" --storage-root "local:$S"; expect "wrong passphrase => exit 1, no code" 1 'could not open the digital kit'
  sed -i '0,/MASTER 2: *./s//MASTER 2:  Q/' "$D/paper.txt"; run plan --paper-file "$D/paper.txt" --rclone-config "$D/rclone.conf" --storage-root "local:$S"; expect "paper typo caught by the line check" 1 'MASTER line 2'
fi

# ------------------------------------------------------------------ mutation fixtures: hard stops (exit 3)
if t mutation; then
  for c in forged-sig:'NOT valid' flipped-manifest:'NOT valid' unknown-kid:'unknown signer' stack-mismatch:'different stack' bad-schema:'expected shape' \
           tampered-archive:'checksum mismatch' tampered-consistent:'failed verification' truncated-consistent:'failed verification' bad-plaintext-hash:'failed verification' dump-format-mismatch:'differs from the signed manifest' fd-poison:'inner -Fd archive failed verification'; do
    n="${c%%:*}"; re="${c#*:}"; new_case "m-$n" "$n" || continue
    run plan --deep "${C[@]}"; expect "hard stop: $n (exit 3, never overridable)" 3 "$re"
    run restore --yes --root "$D/restore" "${C[@]}"; expect "restore refuses too: $n" 3 "$re"
    [ ! -e "$D/restore" ] || [ -z "$(find "$D/restore" -mindepth 1 -print -quit)" ] && ok "$n: nothing written to the restore folder" || bad "$n: restore folder was touched"
    run restore --yes --allow-privileged=app --root "$D/restore2" "${C[@]}"; expect "no flag overrides a hard stop: $n" 3 "$re"
  done
  new_case m-rollback ok; run plan "${C[@]}" --min-sequence 2; expect "rolled-back manifest (sequence 1 < floor 2) => exit 3" 3 'rolled-back'
  run plan "${C[@]}" --rp 00000000-0000-4000-8000-000000000000; expect "unknown --rp => exit 1" 1 'not found'
fi

# ------------------------------------------------------------------ injection fixtures
if t injection; then
  for n in inject-dollar inject-backtick inject-semicolon inject-newline inject-dotdot inject-svc; do
    new_case "i-$n" "$n" || continue
    run plan --deep "${C[@]}"; expect "injection fixture $n rejected before use" 3 'expected shape'
    run restore --yes --root "$D/restore" "${C[@]}"; expect "restore: injection fixture $n rejected" 3 'expected shape'
    [ ! -e "$D/CANARY" ] && ok "$n: canary file never created (nothing executed)" || bad "$n: the injected command RAN"
  done
fi

# ------------------------------------------------------------------ restore guards + compose deny list (docker-free: refusal happens before any container or volume)
if t compose; then
  new_case c-root ok; mkdir -p "$D/full"; touch "$D/full/x"
  run restore --yes --root "$D/full" "${C[@]}"; expect "restore refuses a non-empty restore folder" 1 'not empty'
  run restore --yes --root / "${C[@]}"; expect "restore refuses '/' as root" 2 'too broad'
  mkdir -p "$D/kitdir"; cp "$D/kit.pbkit" "$D/kitdir/"; run restore --yes --root "$D/kitdir" --kit "$D/kitdir/kit.pbkit" --passphrase-file "$D/pass.txt" --rclone-config "$D/rclone.conf" --storage-root "local:$S"; expect "restore refuses a root that is not empty (kit inside)" 1 'not empty'
  for n in privileged host-net pid-host ipc-host devices cap-add docker-sock bind-outside; do
    new_case "c-$n" "$n" || continue
    run restore --yes --root "$D/restore" "${C[@]}"; expect "deny list: $n refused by default (exit 4)" 4 'RISK|risky|asks for powers'
    if [ "$docker_ok" = 1 ]; then docker volume inspect pbrtest_appdata >/dev/null 2>&1 && bad "$n: a volume was created before the policy check" || ok "$n: no docker volume created before the policy check"; fi
  done
  for n in env-file-outside include-outside extends-outside secret-file-outside dup-key env-file-var; do
    new_case "c-$n" "$n" || continue
    run restore --yes --root "$D/restore" "${C[@]}"; expect "read-scope: $n refused on the RAW yaml before rendering (exit 4)" 4 'before it is rendered'
  done
fi

# ------------------------------------------------------------------ full restore (needs a docker daemon)
if t full; then
  if [ "$docker_ok" != 1 ]; then skipt "full restore + override semantics" "no reachable docker daemon / busybox image"
  else
    PRJ="pbrtest"; cleanup_docker() { docker compose -p "$PRJ" down -v --remove-orphans >/dev/null 2>&1; docker volume rm -f "${PRJ}_appdata" >/dev/null 2>&1; }
    cleanup_docker
    new_case f-ok ok
    run restore --yes --root "$D/restore" "${C[@]}"; expect "full restore (files, volume, compose, up)" 0 'stack started'
    [ "$(cat "$D/restore/files/srv/pbr app/stack.env" 2>/dev/null)" = "A=1" ] && ok "full: compose dir restored at its original path under the root" || bad "full: stack.env missing"
    [ "$(cat "$D/restore/files/srv/pbr app/data/hello.txt" 2>/dev/null)" = "hello from the bind path" ] && ok "full: restic bind artifact restored (diff=0)" || bad "full: bind content wrong"
    [ "$(docker run --rm -v "${PRJ}_appdata:/v:ro" busybox cat /v/sub/file-2.txt 2>/dev/null)" = "two" ] && ok "full: volume restored (strip vol/)" || bad "full: volume content wrong"
    docker compose -p "$PRJ" ps --format json 2>/dev/null | grep -q running && ok "full: container running" || bad "full: container not running"
    no_secrets "full restore"; clean_tmp "full restore"
    cleanup_docker
    new_case f-manual manual-role
    run restore --yes --root "$D/restore" --project-name pbrtest2 "${C[@]}"; expect "compose folder backed up as a 'manual' folder source + --project-name rename" 0 'stack started'
    [ "$(docker run --rm -v pbrtest2_appdata:/v:ro busybox cat /v/file-1.txt 2>/dev/null)" = "volume data one" ] && ok "full: volume renamed with the project (pbrtest2_appdata)" || bad "full: renamed volume content wrong"
    docker compose -p pbrtest2 down -v --remove-orphans >/dev/null 2>&1
    for fmt in fc fd; do
      new_case "f-pg-$fmt" "pg-real-$fmt" || continue
      run restore --yes --root "$D/restore" "${C[@]}"; expect "REAL pg_dump -F$fmt: restored by pg_restore inside the stack's postgres container" 0 'database db restored \(pg_'
      got="$(docker exec pbrtest-db-1 psql -U app -d app -Atc "select string_agg(id||chr(58)||payload, chr(44) order by id) from items" 2>/dev/null | sha256sum | cut -d' ' -f1)"
      [ "$got" = "$(jq -r .rows_sha "$D/info.json")" ] && ok "full: -F$fmt restore diff=0 (500 rows hash equals the source)" || bad "full: -F$fmt rows differ"
      cleanup_docker
    done
    new_case f-sqlite sqlite-engine
    run restore --yes --root "$D/restore" "${C[@]}"; expect "sqlite engine archive: unpacked and reported honestly (original path not recorded)" 0 'does not record where the file lived'
    [ "$(sha256sum "$D/restore/databases/ledger/app.db" 2>/dev/null | cut -d' ' -f1)" = "$(jq -r .rows_sha "$D/info.json")" ] && ok "full: sqlite file diff=0 (byte-identical)" || bad "full: sqlite file differs"
    cleanup_docker
    new_case f-abs abs-bind
    run restore --yes --root "$D/restore" "${C[@]}"; expect "absolute bind into the ORIGINAL path is re-pointed into the restore root (override file), then policy passes" 0 're-pointed absolute bind mounts'
    src="$(docker inspect pbrtest-app-1 --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' 2>/dev/null)"
    [ "$src" = "$D/restore/files/srv/pbr app/data" ] && ok "full: container /data is mounted from inside the restore root" || bad "full: /data source is '$src'"
    cleanup_docker
    new_case f-allow allow-override-ok
    run restore --yes --root "$D/restore" "${C[@]}"; expect "privileged compose refused without override (exit 4)" 4 'privileged'
    run restore --yes --root "$D/restore2" --allow-privileged=other "${C[@]}"; expect "override for ANOTHER service does not help (exit 4)" 4 'privileged'
    run restore --yes --root "$D/restore3" --allow-privileged=app "${C[@]}"; expect "--allow-privileged=app lets that one service through" 0 'allowed by you'
    cleanup_docker
  fi
fi

printf '\n%d passed, %d failed, %d skipped\n' "$pass" "$fail" "$skip"
[ "$fail" = 0 ]
