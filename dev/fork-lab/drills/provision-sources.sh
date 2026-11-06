#!/usr/bin/env bash
# W02 spike: register the matrix sources in the lab dashboard.
# DEVIATION (recorded in ADR-001): the dashboard has no create-source API (API v1 `databases` is GET only) and the UI
# modal needs ~6 browser calls per source. `demo-postgres` (the only source with a secret) was created through the real UI
# modal (upsertDatabaseConfigAction). The other sources carry no secret, so this script inserts the SAME row shape that
# action writes (dbms, config without `method`, backup_engine from the method). Everything after creation - polling,
# `waiting` rows, backup, restore - runs the unchanged upstream code.
# Usage: provision-sources.sh [name ...]   (no args = all matrix sources). Lab only; idempotent by name.
set -euo pipefail
P="docker exec -i forklab-portabase-db-1 psql -U portabase -d portabase -v ON_ERROR_STOP=1 -q -At"

AGENT_ID=$($P -c "select id from agents where name='lab-agent'")
PROJECT_ID=$($P -c "select id from projects where name='demo-stack'")
CHANNEL_ID=$($P -c "select id from storage_channel where name='lab-minio'")

add() { # name dbms engine config-json
  local name="$1" dbms="$2" engine="$3" cfg="$4"
  if [ "$($P -c "select count(*) from databases where name='$name' and deleted_at is null")" = "0" ]; then
    $P -c "insert into databases(id,agent_database_id,name,dbms,agent_id,project_id,config,backup_engine)
           values(gen_random_uuid(),gen_random_uuid(),'$name','$dbms','$AGENT_ID','$PROJECT_ID','$cfg'::jsonb,'$engine')"
    echo "added $name ($dbms/$engine)"
  else echo "exists $name"; fi
}

# project-level storage policy -> lab MinIO (what the project page UI writes); idempotent
$P -c "insert into storage_policy(storage_channel_id,project_id) select '$CHANNEL_ID','$PROJECT_ID'
       where not exists (select 1 from storage_policy where project_id='$PROJECT_ID')"
# the UI-created postgres source joins the project (project page "move database")
$P -c "update databases set project_id='$PROJECT_ID' where name='demo-postgres' and project_id is null"

W="${*:-all}"
want() { [ "$W" = "all" ] || [[ " $W " == *" $1 "* ]]; }
want demo-compose-dir      && add demo-compose-dir      files archive '{"path":"/lab/demo-stack","options":{"exclude":[],"one_file_system":false}}'
want demo-compose-snapshot && add demo-compose-snapshot files restic  '{"path":"/lab/demo-stack","options":{"exclude":[],"one_file_system":false}}'
want demo-uploads          && add demo-uploads          files archive '{"path":"/lab/uploads","options":{"exclude":[],"one_file_system":false}}'
want demo-appdata-volume   && add demo-appdata-volume   docker-volume archive '{"volume_name":"forklab-demo_appdata"}'
want demo-sqlite-mount     && add demo-sqlite-mount     sqlite archive '{"path":"/lab/sqlite/app.db"}'
want demo-sqlite-volpath   && add demo-sqlite-volpath   sqlite archive '{"path":"/var/lib/docker/volumes/forklab-demo_sqlitedata/_data/app.db"}'
want demo-sqlite-voltar    && add demo-sqlite-voltar    docker-volume archive '{"volume_name":"forklab-demo_sqlitedata"}'
$P -c "select name,dbms,backup_engine,backup_policy is null as no_cron from databases where deleted_at is null order by name"
