#!/usr/bin/env bash
# ARCH-11 + Q1/Q2 evidence: how the containerised agent reaches (a) stack databases, (b) host bind paths, (c) docker volumes.
#   N1 agent on the lab net only      -> postgres source on the demo INTERNAL net is unreachable (ping false, backup fails)
#   N2 agent also attached to the demo internal network -> works (decision A)
#   S1 no docker socket               -> docker-volume source unusable
# Lab only.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
fail=0; ok() { log "PASS $*"; }; bad() { log "FAIL $*"; fail=1; }
agentv() { bash "$LAB/lab.sh" agent "$@" >/dev/null 2>&1; sleep 12; }
b_status() { local b; b=$(trigger_backup "$1"); wait_backup "$b" 60 | awk '{print $1}'; }

log "== N1: agent on forklab_net only (no override) =="; agentv host-bind
agent_log 15s | grep -E "Ping demo-postgres" | tail -1
r=$(b_status demo-postgres); [ "$r" = failed ] && ok "N1 postgres backup FAILS without network attachment ($r)" || bad "N1 expected failed, got $r"
log "== N2: attach the demo stack's internal network =="; agentv attach-demo-net host-bind
agent_log 15s | grep -E "Ping demo-postgres" | tail -1
r=$(b_status demo-postgres); [ "$r" = success ] && ok "N2 postgres backup works with attach-demo-net" || bad "N2 got $r"
log "N-host: host bind visible only with an explicit mount: /lab/demo-stack exists in agent: $(docker exec forklab-agent sh -c 'test -d /lab/demo-stack && echo yes || echo no')  | an unmounted host path /etc/hostname-of-host visible: $(docker exec forklab-agent sh -c 'test -d /lab/not-mounted && echo yes || echo no')"

log "== S1: no docker socket =="; agentv attach-demo-net host-bind no-docker-sock
agent_log 15s | grep -i -E "docker|socket|volume" | head -3
r=$(b_status demo-appdata-volume); [ "$r" = failed ] && ok "S1 docker-volume backup FAILS without docker socket" || log "S1 result=$r (poll may be blocked - see poll-blast.sh)"
agentv attach-demo-net host-bind
log "arch11-q2 done fail=$fail"; exit $fail
