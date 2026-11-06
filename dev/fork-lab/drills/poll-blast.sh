#!/usr/bin/env bash
# CH-22c: ONE source whose ping returns Err stops the whole agent poll (`try_join_all`, agent:services/status.rs:78-93),
# so a perfectly healthy source never gets its `waiting` backup started. Reproduced with a docker-volume source and a
# docker socket that is unavailable (any non-404 Docker error behaves the same). Lab only.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
fail=0; ok() { log "PASS $*"; }; bad() { log "FAIL $*"; fail=1; }
agentv() { bash "$LAB/lab.sh" agent "$@" >/dev/null 2>&1; sleep 12; }

agentv attach-demo-net host-bind
b=$(trigger_backup demo-uploads); r=$(wait_backup "$b" 60); log "baseline: files source backup -> $r"
case "$r" in success*) ok "baseline backup works";; *) bad "baseline failed";; esac

log "== break ONE source: docker socket gone, docker-volume sources present =="; agentv attach-demo-net host-bind no-docker-sock
t0=$(date -u +%FT%T)
b=$(trigger_backup demo-uploads); log "inserted waiting backup for the HEALTHY files source: $b"
sleep 40
st=$(pq -c "select status from backups where id='$b'"); lc=$(pq -c "select max(last_contact) from databases where name like 'demo-%'")
log "after 40 s: backup status=$st ; newest source last_contact=$lc (now=$(date -u +'%F %T'))"
agent_log 40s | grep -i -E "error|fail|docker" | sort | uniq -c | sort -rn | head -4
[ "$st" = waiting ] && ok "healthy source's backup stuck in 'waiting': one bad source blocks every backup on the agent (CH-22c reproduced)" || bad "backup was not blocked (status=$st)"

log "== recovery: restore the socket =="; agentv attach-demo-net host-bind
r=$(wait_backup "$b" 60); [ "${r%% *}" = success ] && ok "backup proceeds after the bad source is fixed ($r)" || bad "no recovery: $r"
log "poll-blast done fail=$fail"; exit $fail
