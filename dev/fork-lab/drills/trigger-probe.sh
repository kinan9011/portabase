#!/usr/bin/env bash
# ARCH-21 / D14 / I1: does a dashboard-created source with NO cron (databases.backup_policy NULL, project policy NULL) get
# backed up when a `waiting` row appears on the EXACT upstream path? (The UI path = bulkBackupAction on the project page was
# driven once by hand in the browser: "Queued 8 backup(s)." -> all started within one poll. This script repeats it with the
# statement bulkBackupAction / POST /api/v1/databases/{id}/backup execute: insert backups(status='waiting').)
# Also answers I1: is there a dashboard-side scheduler that could issue that insert? Lab only.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
fail=0; ok() { log "PASS $*"; }; bad() { log "FAIL $*"; fail=1; }
REPO="$(cd "$LAB/../.." && pwd)"

n=$(pq -c "select count(*) from databases d left join projects p on p.id=d.project_id where d.deleted_at is null and (d.backup_policy is not null or p.backup_policy is not null)")
[ "$n" = 0 ] && ok "precondition: no source or project has a cron (backup_policy NULL everywhere)" || bad "$n sources have a cron"

bash "$LAB/lab.sh" agent attach-demo-net host-bind >/dev/null 2>&1; sleep 12
for s in demo-uploads demo-postgres demo-appdata-volume; do
  t0=$(date +%s.%N); b=$(trigger_backup "$s")
  seen=""; end=$((SECONDS+60))
  while [ $SECONDS -lt $end ]; do
    st=$(pq -c "select status from backups where id='$b'")
    [ -z "$seen" ] && [ "$st" != waiting ] && seen=$(echo "$(date +%s.%N) - $t0" | bc -l | cut -c1-4)
    case "$st" in success|failed) break;; esac; sleep 0.5
  done
  fin=$(echo "$(date +%s.%N) - $t0" | bc -l | cut -c1-4)
  [ "$st" = success ] && ok "$s: waiting -> ongoing after ${seen}s -> success after ${fin}s (cron NULL, upstream waiting-row path)" || bad "$s ended $st"
done

log "-- unseen-source edge: brand-new source + immediate waiting row (first poll has not returned it to the agent yet)"
pq -c "insert into databases(id,agent_database_id,name,dbms,agent_id,project_id,config,backup_engine)
  select gen_random_uuid(),gen_random_uuid(),'probe-new','files',agent_id,project_id,'{\"path\":\"/lab/uploads\",\"options\":{\"exclude\":[],\"one_file_system\":false}}'::jsonb,'archive' from databases where name='demo-uploads' limit 1"
t0=$(date +%s.%N); b=$(trigger_backup probe-new); r=$(wait_backup "$b" 60)
fin=$(echo "$(date +%s.%N) - $t0" | bc -l | cut -c1-4); [ "${r%% *}" = success ] && ok "probe-new picked up on a later poll, success after ${fin}s (no lost trigger)" || bad "probe-new: $r"
pq -c "update databases set deleted_at=now() where name='probe-new'"

log "-- I1: who inserts a waiting backup row upstream? (only user actions/API; the dashboard cron registers no backup trigger)"
grep -rn 'status: "waiting"' "$REPO/src" "$REPO/app" --include=*.ts | grep -v -i restor | sed "s|$REPO/||" | cut -c1-120
grep -n -E "setupCronJobs|startRetention|Cleaning|Healthcheck|Telemetry|Presence|Stale" "$REPO/src/utils/init/cron.ts" | sed "s|$REPO/||" | cut -c1-110 | head -8
agent_log 60s | grep -i -E "cron" | head -3
log "agent registers cron only when the poll response carries backup.cron; with NULL it schedules nothing"
log "trigger-probe done fail=$fail"; exit $fail
