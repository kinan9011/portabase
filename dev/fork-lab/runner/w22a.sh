#!/usr/bin/env bash
# W22a-f1 mirror lab driver (Flow D). Same emulated runner VM as W21 (docker-in-docker box + nftables in the box's own netns) with UNIQUE names/subnets: only ever touches
# objects named w22a-* / pbr-w22a-*. Never `docker system prune`. The HOST firewall is never modified. Real-VM proof stays PENDING-HUMAN (#125).
# Differences to runner.sh: the runner agent runs in MIRROR mode (FORK_MIRROR_ROOT bind-mounted at the SAME path in the box, master key via EDGE_KEY: the realised residual R-W21-1,
# ADR-008 §12), the artifact host is on the allow-list, the demo image is loaded into the box (the box has no internet: it reaches only the dashboard and the artifact server).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOX=w22a-runner; VOL=w22a-runner-docker
LAB_NET=w22a-lab-net; LAB_SUBNET=172.31.247.0/24; BOX_LAB_IP=172.31.247.10; GW=172.31.247.1
PROD_NET=w22a-prod-net; PROD_SUBNET=172.31.248.0/24; BOX_PROD_IP=172.31.248.10
RUNNER_IMAGE="${W22A_RUNNER_IMAGE:-pbr-w22a-runner:lab}"
AGENT_IMAGE="${W22A_AGENT_IMAGE:-portabase-agent-fork:w22a-lab}"
MIRROR_ROOT=/srv/portabase-mirrors
BB=busybox@sha256:a46257e06c82ad85242d0d38077d0a52d9896389ca60a1a59d3463db586e5fa4
PG=postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b
DEMO_IMAGE=postgres:17-alpine
SINKS="w22a-sink-smtp w22a-sink-hook w22a-sink-db w22a-sink-dns"
inbox() { docker exec "$BOX" "$@"; }

nets() {
  docker network inspect "$LAB_NET" >/dev/null 2>&1 || docker network create --subnet "$LAB_SUBNET" "$LAB_NET" >/dev/null
  docker network inspect "$PROD_NET" >/dev/null 2>&1 || docker network create --internal --subnet "$PROD_SUBNET" "$PROD_NET" >/dev/null
}
sink_tcp() { # name ip port
  docker run -d --name "$1" --network "$PROD_NET" --ip "$2" "$BB" sh -c "while true; do nc -l -p $3 -e sh -c 'echo CONN $1 > /proc/1/fd/1; echo sink'; done" >/dev/null
}
sinks() {
  sink_tcp w22a-sink-smtp 172.31.248.25 25
  sink_tcp w22a-sink-hook 172.31.248.80 8080
  docker run -d --name w22a-sink-db --network "$PROD_NET" --ip 172.31.248.54 -e POSTGRES_PASSWORD=sink "$PG" -c log_connections=on >/dev/null
  docker run -d --name w22a-sink-dns --network "$PROD_NET" --ip 172.31.248.53 "$BB" sh -c "(while true; do nc -lu -p 53; done) & while true; do nc -l -p 53 -e sh -c 'echo CONN w22a-sink-dns-tcp > /proc/1/fd/1; echo sink'; done" >/dev/null
}
# the W21 runner configs, re-addressed for this lab's subnets (the image bakes daemon.json's resolver and the nft include files)
image() {
  local ctx; ctx="$(mktemp -d)"
  for f in Dockerfile daemon.lab.json nftables.conf runner-dns.lab.nft runner-dns.vm.nft; do sed -e 's#172\.31\.244\.#172.31.248.#g' -e 's#172\.31\.245\.#172.31.247.#g' "$DIR/$f" > "$ctx/$f"; done
  docker build -q -t "$RUNNER_IMAGE" "$ctx" >/dev/null
  rm -rf "$ctx"
}
defs() { # DASH_PORT [ARTIFACT_PORT]
  local dp="${DASH_PORT:?DASH_PORT required}" ap="${ARTIFACT_PORT:-${DASH_PORT}}"
  inbox sh -c 'mkdir -p /etc/pbm /etc/nftables.d'
  sed -e "s/@DASH_PORT@/$dp/" -e "s/@ARTIFACT_PORT@/$ap/" -e 's#172\.31\.245\.1#172.31.247.1#g' "$DIR/runner-defs.lab.nft.tmpl" | docker exec -i "$BOX" sh -c 'cat > /etc/pbm/runner-defs.nft'
  inbox sh -c 'cp /etc/pbm-template/runner-dns.lab.nft /etc/pbm/runner-dns.nft && cp /etc/pbm-template/nftables.conf /etc/nftables.d/pbm-runner.nft'
}
fw_on() { inbox nft -f /etc/nftables.d/pbm-runner.nft; }
fw_off() { inbox nft delete table inet pbm_runner 2>/dev/null || true; }
box() {
  image
  docker volume create "$VOL" >/dev/null
  docker run -d --privileged --name "$BOX" --network "$LAB_NET" --ip "$BOX_LAB_IP" -v "$VOL:/var/lib/docker" "$RUNNER_IMAGE" >/dev/null
  docker network connect --ip "$BOX_PROD_IP" "$PROD_NET" "$BOX"
  for _ in $(seq 1 90); do inbox docker info >/dev/null 2>&1 && break; sleep 1; done
  inbox docker info >/dev/null 2>&1 || { echo "runner box: inner docker did not start" >&2; docker logs "$BOX" 2>&1 | tail -20 >&2; exit 1; }
  defs; fw_on
  inbox sh -c "mkdir -p $MIRROR_ROOT"
  inbox docker network create --subnet 10.212.0.0/24 pbr-agent >/dev/null
  docker save "$AGENT_IMAGE" | docker exec -i "$BOX" docker load >/dev/null
  docker save "$DEMO_IMAGE" | docker exec -i "$BOX" docker load >/dev/null   # the demo stack's only image (the box has no registry access, on purpose)
}
# Start the runner agent INSIDE the box in MIRROR mode. EDGE_KEY comes from the caller's environment (never argv); the bundle comes on stdin (0600 inside the box).
agent() {
  : "${EDGE_KEY:?EDGE_KEY required in the environment}"
  docker exec -i "$BOX" sh -c 'umask 077; mkdir -p /run/w22a; cat > /run/w22a/bundle'
  { cat "$DIR/agent.env"; echo "FORK_MIRROR_ROOT=$MIRROR_ROOT"; echo "FORK_ARTIFACT_HTTP_HOSTS=$GW"; } | docker exec -i "$BOX" sh -c 'cat > /run/w22a/agent.env'
  docker exec -e EDGE_KEY "$BOX" docker run -d --name runner-agent --network pbr-agent --env-file /run/w22a/agent.env -e EDGE_KEY \
    --add-host "forklab-dashboard.localhost:$GW" -e "PORTABASE_HELPER_IMAGE=$AGENT_IMAGE" \
    -v /run/w22a/bundle:/run/fork/bundle:ro -v runner-agent-state:/config -v /var/run/docker.sock:/var/run/docker.sock -v "$MIRROR_ROOT:$MIRROR_ROOT" "$AGENT_IMAGE" >/dev/null
}
capture() { # start|stop|show — wire-level ground truth for DNS egress on the box uplinks
  case "$1" in
    start) inbox sh -c ': > /tmp/dns.cap; for i in eth0 eth1; do (tcpdump -i $i -nn -A -l "port 53" >>/tmp/dns.cap 2>&1 &); done; sleep 1' ;;
    stop) inbox sh -c 'pkill tcpdump || true' ;;
    show) inbox sh -c 'cat /tmp/dns.cap' ;;
  esac
}
down() {
  # own objects only, idempotent
  docker rm -fv $BOX $SINKS w22a-agent-prod >/dev/null 2>&1 || true
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
  status) docker ps -a --filter name=w22a- --format '{{.Names}}\t{{.Status}}'; docker exec "$BOX" nft list table inet pbm_runner 2>&1 | head -40 || true ;;
  *) echo "usage: w22a.sh up|agent|nets|sinks|box|defs|fw-on|fw-off|capture start|stop|show|down|status" >&2; exit 2 ;;
esac
