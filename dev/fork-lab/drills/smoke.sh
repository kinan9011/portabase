#!/usr/bin/env bash
# Fork lab smoke test: everything up, healthy, localhost-only, seed deterministic, compose config renders without starting
# anything. Exit 0 only if every check passes. Lab only.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
fail=0; ok() { log "PASS $*"; }; bad() { log "FAIL $*"; fail=1; }
http() { curl -s -o /dev/null -w '%{http_code}' "$1"; }

[ "$(http http://forklab-dashboard.localhost:18887/api/health)" = 200 ] && ok "dashboard health 200" || bad "dashboard"
[ "$(http http://127.0.0.1:13552/api/health)" = 200 ] && ok "arcane health 200 (UI reachable)" || bad "arcane"
[ "$(http http://127.0.0.1:19000/minio/health/live)" = 200 ] && ok "minio live" || bad "minio"
body=$(curl -s -m 5 http://127.0.0.1:18080/ || true); echo "$body" | grep -q "rows=500" && ok "demo web serves 500 DB rows ($(echo "$body" | tr '\n' ' '))" || bad "demo web: $body"
bash "$LAB/demo-stack/seed.sh" --verify >/dev/null 2>&1 && ok "seed deterministic (matches expected.json)" || bad "seed mismatch"
n=$(agent_log 20s | grep -c "Ping demo-") ; [ "$n" -gt 0 ] && ok "agent polling the dashboard ($n pings in 20 s)" || bad "agent silent"

# localhost only: every lab-published port is bound to 127.0.0.1
bad_ports=$(docker ps --filter name=forklab --format '{{.Names}} {{.Ports}}' | grep -E '(^|, | )(0\.0\.0\.0|\[::\]):[0-9]+->' || true)
[ -z "$bad_ports" ] && ok "no lab port bound beyond 127.0.0.1" || bad "exposed: $bad_ports"

# E5: docker compose config renders the demo stack without starting a container
DEMO="docker compose -f $LAB/demo-stack/compose.yml -f $LAB/demo-stack/compose.override.yml"
before=$(docker ps -aq | sort | md5sum)
$DEMO config -q && $DEMO config --services | tr '\n' ' ' | sed 's/^/services rendered: /'; echo
$DEMO --profile sqlite --profile failing-webhook config -q && ok "docker compose config renders (all profiles)" || bad "compose config failed"
after=$(docker ps -aq | sort | md5sum); [ "$before" = "$after" ] && ok "docker ps -a identical before/after config (no container created or started)" || bad "containers changed"
log "smoke done fail=$fail"; exit $fail
