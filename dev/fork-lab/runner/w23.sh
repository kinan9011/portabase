#!/usr/bin/env bash
# ponytail: copy of w22b.sh (W23: unique names/subnets 172.31.251/252, container names w23-*); extract shared helpers if a fourth mirror lab appears.
# W22a-f1 mirror lab driver (Flow D). Same emulated runner VM as W21 (docker-in-docker box + nftables in the box's own netns) with UNIQUE names/subnets: only ever touches
# objects named w23-* / pbr-w23-*. Never `docker system prune`. The HOST firewall is never modified. Real-VM proof stays PENDING-HUMAN (#125).
# Differences to runner.sh: the runner agent runs in MIRROR mode (FORK_MIRROR_ROOT bind-mounted at the SAME path in the box, master key via EDGE_KEY: the realised residual R-W21-1,
# ADR-008 §12), the artifact host is on the allow-list, the demo image is loaded into the box (the box has no internet: it reaches only the dashboard and the artifact server).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOX=w23-runner; VOL=w23-runner-docker
LAB_NET=w23-lab-net; LAB_SUBNET=172.31.251.0/24; BOX_LAB_IP=172.31.251.10; GW=172.31.251.1
PROD_NET=w23-prod-net; PROD_SUBNET=172.31.252.0/24; BOX_PROD_IP=172.31.252.10
RUNNER_IMAGE="${W23_RUNNER_IMAGE:-pbr-w23-runner:lab}"
AGENT_IMAGE="${W23_AGENT_IMAGE:-portabase-agent-fork:w22a-lab}"
MIRROR_ROOT=/srv/portabase-mirrors
BB=busybox@sha256:a46257e06c82ad85242d0d38077d0a52d9896389ca60a1a59d3463db586e5fa4
PG=postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b
DEMO_IMAGE=postgres:17-alpine
DEMO_WEB_IMAGE=w23-demo-web:lab   # the same bytes under another name: the W20 compiler derives credential resets from the IMAGE NAME, a web tier named postgres would get a (bogus) reset
SINKS="w23-sink-smtp w23-sink-hook w23-sink-db w23-sink-dns"
inbox() { docker exec "$BOX" "$@"; }

nets() {
  docker network inspect "$LAB_NET" >/dev/null 2>&1 || docker network create --subnet "$LAB_SUBNET" "$LAB_NET" >/dev/null
  docker network inspect "$PROD_NET" >/dev/null 2>&1 || docker network create --internal --subnet "$PROD_SUBNET" "$PROD_NET" >/dev/null
}
sink_tcp() { # name ip port
  docker run -d --name "$1" --network "$PROD_NET" --ip "$2" "$BB" sh -c "while true; do nc -l -p $3 -e sh -c 'echo CONN $1 > /proc/1/fd/1; echo sink'; done" >/dev/null
}
sinks() {
  sink_tcp w23-sink-smtp 172.31.252.25 25
  sink_tcp w23-sink-hook 172.31.252.80 8080
  docker run -d --name w23-sink-db --network "$PROD_NET" --ip 172.31.252.54 -e POSTGRES_PASSWORD=sink "$PG" -c log_connections=on >/dev/null
  docker run -d --name w23-sink-dns --network "$PROD_NET" --ip 172.31.252.53 "$BB" sh -c "(while true; do nc -lu -p 53; done) & while true; do nc -l -p 53 -e sh -c 'echo CONN w23-sink-dns-tcp > /proc/1/fd/1; echo sink'; done" >/dev/null
}
# the W21 runner configs, re-addressed for this lab's subnets (the image bakes daemon.json's resolver and the nft include files)
image() {
  local ctx; ctx="$(mktemp -d)"
  for f in Dockerfile daemon.lab.json nftables.conf runner-dns.lab.nft runner-dns.vm.nft; do sed -e 's#172\.31\.244\.#172.31.252.#g' -e 's#172\.31\.245\.#172.31.251.#g' "$DIR/$f" > "$ctx/$f"; done
  docker build -q -t "$RUNNER_IMAGE" "$ctx" >/dev/null
  rm -rf "$ctx"
}
defs() { # DASH_PORT [ARTIFACT_PORT]
  local dp="${DASH_PORT:?DASH_PORT required}" ap="${ARTIFACT_PORT:-${DASH_PORT}}"
  inbox sh -c 'mkdir -p /etc/pbm /etc/nftables.d'
  sed -e "s/@DASH_PORT@/$dp/" -e "s/@ARTIFACT_PORT@/$ap/" -e 's#172\.31\.245\.1#172.31.251.1#g' "$DIR/runner-defs.lab.nft.tmpl" | docker exec -i "$BOX" sh -c 'cat > /etc/pbm/runner-defs.nft'
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
  docker tag "$DEMO_IMAGE" "$DEMO_WEB_IMAGE"
  docker save "$DEMO_IMAGE" "$DEMO_WEB_IMAGE" | docker exec -i "$BOX" docker load >/dev/null   # the demo stack's images (the box has no registry access, on purpose)
}
# Start the runner agent INSIDE the box in MIRROR mode. EDGE_KEY comes from the caller's environment (never argv); the bundle comes on stdin (0600 inside the box).
agent() {
  : "${EDGE_KEY:?EDGE_KEY required in the environment}"
  docker exec -i "$BOX" sh -c 'umask 077; mkdir -p /run/w23; cat > /run/w23/bundle'
  { cat "$DIR/agent.env"; echo "FORK_MIRROR_ROOT=$MIRROR_ROOT"; echo "FORK_ARTIFACT_HTTP_HOSTS=$GW"; } | docker exec -i "$BOX" sh -c 'cat > /run/w23/agent.env'
  docker exec -e EDGE_KEY "$BOX" docker run -d --name runner-agent --network pbr-agent --env-file /run/w23/agent.env -e EDGE_KEY \
    --add-host "forklab-dashboard.localhost:$GW" -e "PORTABASE_HELPER_IMAGE=$AGENT_IMAGE" \
    -v /run/w23/bundle:/run/fork/bundle:ro -v runner-agent-state:/config -v /var/run/docker.sock:/var/run/docker.sock -v "$MIRROR_ROOT:$MIRROR_ROOT" "$AGENT_IMAGE" >/dev/null
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
  docker rm -fv $BOX $SINKS w23-agent-prod >/dev/null 2>&1 || true
  docker rmi "$DEMO_WEB_IMAGE" >/dev/null 2>&1 || true
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
  status) docker ps -a --filter name=w23- --format '{{.Names}}\t{{.Status}}'; docker exec "$BOX" nft list table inet pbm_runner 2>&1 | head -40 || true ;;
  *) echo "usage: w23.sh up|agent|nets|sinks|box|defs|fw-on|fw-off|capture start|stop|show|down|status" >&2; exit 2 ;;
esac
