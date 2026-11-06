#!/usr/bin/env bash
# Shared helpers for the W02 drills. Source it; never run directly. Lab only.
LAB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RES="$LAB/results"; mkdir -p "$RES"
# shellcheck disable=SC1091
. "$LAB/.env.lab"
PGIMG="postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b"
AGENTIMG="ghcr.io/portabase/agent:1.25.2@sha256:e8f2b52eb4e59ed652d63d853a6bf517c31e9d41e3556115a2534ecbdde9df9f"
pq() { docker exec -i forklab-portabase-db-1 psql -U portabase -d portabase -v ON_ERROR_STOP=1 -q -At -F' ' "$@"; }
log() { printf '[%s] %s\n' "$(date -u +%T)" "$*"; }
dbid() { pq -c "select id from databases where name='$1' and deleted_at is null"; }

# EXACT upstream statement of bulkBackupAction / POST /api/v1/databases/{id}/backup: insert backups(status='waiting').
trigger_backup() { pq -c "insert into backups(database_id,status) values('$(dbid "$1")','waiting') returning id" | head -1; }

# wait until backup row reaches success|failed; prints "<status> <seconds-from-waiting-to-final>"
wait_backup() { # backup_id [timeout]
  local id="$1" t="${2:-120}" end=$((SECONDS + ${2:-120})) s
  while [ $SECONDS -lt $end ]; do
    s=$(pq -c "select status from backups where id='$id'")
    case "$s" in success|failed) pq -c "select status, round(extract(epoch from (updated_at-created_at))::numeric,1) from backups where id='$id'"; return 0;; esac
    sleep 2
  done
  echo "timeout $t"; return 1
}

# EXACT upstream statement of createRestorationBackupAction
trigger_restore() { # source-name backup_id
  local did bs; did=$(dbid "$1")
  bs=$(pq -c "select id from backup_storage where backup_id='$2' and status='success' limit 1")
  pq -c "insert into restorations(database_id,backup_id,backup_storage_id,status) values('$did','$2','$bs','waiting') returning id" | head -1
}
wait_restore() {
  local id="$1" end=$((SECONDS + ${2:-120})) s
  while [ $SECONDS -lt $end ]; do
    s=$(pq -c "select status from restorations where id='$id'")
    case "$s" in success|failed) echo "$s"; return 0;; esac
    sleep 2
  done
  echo timeout; return 1
}
agent_log() { docker logs forklab-agent --since "${1:-30s}" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | cut -c1-240; }
mc_lab() { docker exec forklab-portabase-minio-1 sh -c "mc alias set lab http://127.0.0.1:9000 $LAB_MINIO_ROOT_USER $LAB_MINIO_ROOT_PASSWORD >/dev/null; $*"; }
