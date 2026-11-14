#!/usr/bin/env bash
# W21 runner lab driver (ADR-008 §Lab). Only ever touches objects named w21-* / pbr-*. Never `docker system prune`. The HOST firewall is never modified:
# the nftables rules live in the runner box's own network namespace.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOX=w21-runner; VOL=w21-runner-docker
LAB_NET=w21-lab-net; LAB_SUBNET=172.31.245.0/24; BOX_LAB_IP=172.31.245.10
PROD_NET=w21-prod-net; PROD_SUBNET=172.31.244.0/24; BOX_PROD_IP=172.31.244.10
RUNNER_IMAGE="${W21_RUNNER_IMAGE:-pbr-w21-runner:lab}"
AGENT_IMAGE="${W21_AGENT_IMAGE:-portabase-agent-fork:w21-lab}"
BB=busybox@sha256:a46257e06c82ad85242d0d38077d0a52d9896389ca60a1a59d3463db586e5fa4
PG=postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b
SINKS="w21-sink-smtp w21-sink-hook w21-sink-db w21-sink-dns"
inbox() { docker exec "$BOX" "$@"; }

nets() {
  docker network inspect "$LAB_NET" >/dev/null 2>&1 || docker network create --subnet "$LAB_SUBNET" "$LAB_NET" >/dev/null
  docker network inspect "$PROD_NET" >/dev/null 2>&1 || docker network create --internal --subnet "$PROD_SUBNET" "$PROD_NET" >/dev/null
}
# TCP sink: every connection attempt is one line in `docker logs <name>` (the -e program writes to the container's stdout, not to the socket)
sink_tcp() { # name ip port
  docker run -d --name "$1" --network "$PROD_NET" --ip "$2" "$BB" sh -c "while true; do nc -l -p $3 -e sh -c 'echo CONN $1 > /proc/1/fd/1; echo sink'; done" >/dev/null
}
sinks() {
  sink_tcp w21-sink-smtp 172.31.244.25 25
  sink_tcp w21-sink-hook 172.31.244.80 8080
  docker run -d --name w21-sink-db --network "$PROD_NET" --ip 172.31.244.54 -e POSTGRES_PASSWORD=sink "$PG" -c log_connections=on >/dev/null
  # DNS sink: UDP datagrams (the query name travels in clear as length-prefixed labels) are written to the log by plain nc; TCP/53 connections log one line
  docker run -d --name w21-sink-dns --network "$PROD_NET" --ip 172.31.244.53 "$BB" sh -c "(while true; do nc -lu -p 53; done) & while true; do nc -l -p 53 -e sh -c 'echo CONN w21-sink-dns-tcp > /proc/1/fd/1; echo sink'; done" >/dev/null
}
defs() { # DASH_PORT [ARTIFACT_PORT]
  local dp="${DASH_PORT:?DASH_PORT required}" ap="${ARTIFACT_PORT:-${DASH_PORT}}"
  inbox sh -c 'mkdir -p /etc/pbm /etc/nftables.d'
  sed -e "s/@DASH_PORT@/$dp/" -e "s/@ARTIFACT_PORT@/$ap/" "$DIR/runner-defs.lab.nft.tmpl" | docker exec -i "$BOX" sh -c 'cat > /etc/pbm/runner-defs.nft'
  inbox sh -c 'cp /etc/pbm-template/runner-dns.lab.nft /etc/pbm/runner-dns.nft && cp /etc/pbm-template/nftables.conf /etc/nftables.d/pbm-runner.nft'
}
fw_on() { inbox nft -f /etc/nftables.d/pbm-runner.nft; }
fw_off() { inbox nft delete table inet pbm_runner 2>/dev/null || true; }
box() {
  docker build -q -t "$RUNNER_IMAGE" "$DIR" >/dev/null
  docker volume create "$VOL" >/dev/null
  docker run -d --privileged --name "$BOX" --network "$LAB_NET" --ip "$BOX_LAB_IP" -v "$VOL:/var/lib/docker" "$RUNNER_IMAGE" >/dev/null
  docker network connect --ip "$BOX_PROD_IP" "$PROD_NET" "$BOX"
  for _ in $(seq 1 90); do inbox docker info >/dev/null 2>&1 && break; sleep 1; done
  inbox docker info >/dev/null 2>&1 || { echo "runner box: inner docker did not start" >&2; docker logs "$BOX" 2>&1 | tail -20 >&2; exit 1; }
  defs; fw_on
  inbox docker network create --subnet 10.212.0.0/24 pbr-agent >/dev/null
  docker save "$AGENT_IMAGE" | docker exec -i "$BOX" docker load >/dev/null
}
# Start the runner agent INSIDE the box. EDGE_KEY comes from the caller's environment (never argv); the bundle comes on stdin (0600 inside the box).
agent() {
  : "${EDGE_KEY:?EDGE_KEY required in the environment}"
  docker exec -i "$BOX" sh -c 'umask 077; mkdir -p /run/w21; cat > /run/w21/bundle'
  docker exec -i "$BOX" sh -c 'cat > /run/w21/agent.env' < "$DIR/agent.env"
  docker exec -e EDGE_KEY "$BOX" docker run -d --name runner-agent --network pbr-agent --env-file /run/w21/agent.env -e EDGE_KEY \
    --add-host forklab-dashboard.localhost:172.31.245.1 -e "PORTABASE_HELPER_IMAGE=$AGENT_IMAGE" \
    -v /run/w21/bundle:/run/fork/bundle:ro -v runner-agent-state:/config -v /var/run/docker.sock:/var/run/docker.sock "$AGENT_IMAGE" >/dev/null
}
# Wire-level ground truth for DNS egress: a capture on the box's uplink interfaces (eth0 lab, eth1 prod). A query that left the VM is in the file, in clear (qname labels).
capture() { # start|stop|show
  case "$1" in
    start) inbox sh -c ': > /tmp/dns.cap; for i in eth0 eth1; do (tcpdump -i $i -nn -A -l "port 53" >>/tmp/dns.cap 2>&1 &); done; sleep 1' ;;
    stop) inbox sh -c 'pkill tcpdump || true' ;;
    show) inbox sh -c 'cat /tmp/dns.cap' ;;
  esac
}
down() {
  # own objects only, idempotent
  docker rm -fv $BOX $SINKS w21-agent-prod >/dev/null 2>&1 || true
  docker volume rm -f $VOL >/dev/null 2>&1 || true
  docker network rm $LAB_NET $PROD_NET >/dev/null 2>&1 || true
}
case "${1:-}" in
  up) down; nets; sinks; box ;;
  agent) agent ;;
  nets) nets ;;
  sinks) sinks ;;
  box) box ;;
  defs) defs ;;
  fw-on) fw_on ;;
  fw-off) fw_off ;;
  capture) capture "${2:?start|stop|show}" ;;
  down) down ;;
  status) docker ps -a --filter name=w21- --format '{{.Names}}\t{{.Status}}'; docker exec "$BOX" nft list table inet pbm_runner 2>&1 | head -40 || true ;;
  *) echo "usage: runner.sh up|agent|nets|sinks|box|defs|fw-on|fw-off|capture start|stop|show|down|status" >&2; exit 2 ;;
esac
