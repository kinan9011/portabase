#!/usr/bin/env bash
# F4 lab gate (plan v2.2 §4.5 / §5.1.5a): "delete with VPS-agent credentials -> data still recoverable".
#   1. home-side pull copy (read-only creds, rclone copy) of the primary bucket
#   2. the pull identity cannot delete/overwrite the primary (negative test)
#   3. attacker with the AGENT credentials (what a compromised VPS holds) deletes every object in the primary
#   4. pull copy still intact -> an archive from it restores a database with 0 diff vs expected.json
#   5. variant a2: MinIO object-lock bucket - the agent identity cannot remove a locked object version
# Leaves lab-primary EMPTY (that is the point): run `lab.sh reset` or re-run matrix.sh to repopulate. Lab only.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
fail=0; ok() { log "PASS $*"; }; bad() { log "FAIL $*"; fail=1; }
exp() { python3 -c "import json;print(json.load(open('$LAB/demo-stack/expected.json'))['$1'])"; }
RC() { docker run --rm --network forklab_net -e RCLONE_CONFIG_L_TYPE=s3 -e RCLONE_CONFIG_L_PROVIDER=Minio -e RCLONE_CONFIG_L_ENDPOINT=http://forklab-minio:9000 \
        -e RCLONE_CONFIG_L_ACCESS_KEY_ID="$1" -e RCLONE_CONFIG_L_SECRET_ACCESS_KEY="$2" -v forklab-f4_pullcopy:/pull \
        rclone/rclone:latest@sha256:7cbeec24a44f206067597c0368be4de90ae19a64d5113c7d1938bd737a81e466 "${@:3}"; }
AGENT_RC() { RC "$LAB_S3_AGENT_KEY" "$LAB_S3_AGENT_SECRET" "$@"; }
PULL_RC()  { RC "$LAB_S3_PULL_KEY" "$LAB_S3_PULL_SECRET" "$@"; }

# clean slate for the copy so the gate proves THIS run (the pull copy is otherwise cumulative by design)
docker volume rm -f forklab-f4_pullcopy >/dev/null 2>&1; docker volume create forklab-f4_pullcopy >/dev/null
# make sure a fresh, known-good postgres artifact exists
b=$(trigger_backup demo-postgres); wait_backup "$b" >/dev/null
before=$(AGENT_RC lsf -R --files-only L:lab-primary | wc -l); log "objects in primary before: $before"

log "1. pull copy (read-only identity, rclone copy)"
docker compose --env-file "$LAB/.env.lab" -f "$LAB/f4/compose.f4.yml" --profile run run --rm pull 2>&1 | tail -2
pulled=$(PULL_RC lsf -R --files-only /pull | wc -l); log "objects in pull copy: $pulled"
[ "$pulled" -ge "$before" ] && ok "pull copy holds all $pulled primary objects" || bad "pull copy incomplete ($pulled < $before)"

log "2. negative: pull identity cannot delete or overwrite the primary"
o=$(PULL_RC delete L:lab-primary --include "backups/2*/**" 2>&1 | tail -2); n=$(AGENT_RC lsf -R --files-only L:lab-primary | wc -l)
[ "$n" -eq "$before" ] && ok "pull identity delete had no effect ($n objects remain)" || bad "pull identity deleted something ($n)"
echo "$o" | head -2
first=$(PULL_RC lsf -R --files-only /pull | head -1)
PULL_RC copyto "/pull/$first" L:lab-primary/forged.bin >/dev/null 2>&1
AGENT_RC lsf L:lab-primary | grep -q forged.bin && bad "pull identity could WRITE to the primary" || ok "pull identity cannot write to the primary (AccessDenied)"

log "3. attacker with AGENT credentials deletes everything (credentials permit delete today, §13 A6)"
AGENT_RC delete L:lab-primary --rmdirs >/dev/null 2>&1
left=$(AGENT_RC lsf -R --files-only L:lab-primary | wc -l); [ "$left" -eq 0 ] && ok "primary bucket wiped with agent credentials (0 objects) - risk demonstrated" || bad "agent creds could not wipe ($left left)"

log "4. recover from the pull copy only"
still=$(PULL_RC lsf -R --files-only /pull | wc -l); [ "$still" -ge "$before" ] && ok "pull copy intact ($still objects)" || bad "pull copy lost objects"
art=$(PULL_RC lsf -R --files-only /pull | grep -E "^backups/.*\.tar\.gz$" | while read -r f; do echo "$f"; done | head -50)
D="$RES/f4"; mkdir -p "$D"; find "$D" -mindepth 1 -delete
found=0
for f in $art; do
  PULL_RC cat "/pull/$f" > "$D/a.tgz" 2>/dev/null; mkdir -p "$D/x"; find "$D/x" -mindepth 1 -delete; tar -xzf "$D/a.tgz" -C "$D/x" 2>/dev/null
  d=$(find "$D/x" -name '*.dump' | head -1); [ -n "$d" ] && { found=1; break; }
done
if [ "$found" = 1 ]; then
  DEMO="docker compose -f $LAB/demo-stack/compose.yml -f $LAB/demo-stack/compose.override.yml"
  $DEMO exec -T db sh -c 'psql -U "$POSTGRES_USER" -d postgres -qc "drop database if exists f4_restore" -c "create database f4_restore"' >/dev/null 2>&1
  $DEMO exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d f4_restore --no-owner' < "$d" >/dev/null 2>&1
  got=$($DEMO exec -T db sh -c 'psql -U "$POSTGRES_USER" -d f4_restore -Atc "select string_agg(id||chr(58)||payload, chr(44) order by id) from items"' | sha256sum | cut -d' ' -f1)
  $DEMO exec -T db sh -c 'psql -U "$POSTGRES_USER" -d postgres -qc "drop database f4_restore"' >/dev/null 2>&1
  [ "$got" = "$(exp postgres_items)" ] && ok "database restored from the PULL COPY alone, diff=0 (primary was empty)" || bad "restore from pull copy differs"
else bad "no postgres dump found in pull copy"; fi

log "5. variant a2: MinIO object lock - agent identity vs locked object"
mc_lab "mc admin user svcacct ls lab >/dev/null 2>&1; true"
mc_lab "mc alias set agent http://127.0.0.1:9000 $LAB_S3_AGENT_KEY $LAB_S3_AGENT_SECRET >/dev/null; echo locked-payload > /tmp/locked.txt; mc cp /tmp/locked.txt agent/lab-protected/locked.txt >/dev/null 2>&1; mc rm --versions --force --recursive agent/lab-protected 2>&1 | tail -2; echo '--- still there:'; mc ls --versions lab/lab-protected | tail -2" 2>&1 | tail -6
v=$(mc_lab "mc ls --versions lab/lab-protected | wc -l"); [ "$v" -ge 1 ] && ok "locked object version survives a delete with agent credentials" || bad "object-lock variant not effective (see output above)"
log "f4-gate done fail=$fail"; exit $fail
