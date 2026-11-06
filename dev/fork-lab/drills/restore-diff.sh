#!/usr/bin/env bash
# W02 spike matrix, part 2: restore IN PLACE through the upstream restoration path (restorations row `waiting`, same insert as
# createRestorationBackupAction) and prove 0 differences vs expected.json for every source type.
# Upstream only restores a backup into the SAME source ("Only a backup of this database can be restored into it"), so
# "restore to a new path/DB" is proven by matrix.sh (manual extraction); this script proves the dashboard path.
# Also proves Q1: a read-only host bind makes `files` restore fail; a writable bind makes it pass. Lab only.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
W="$LAB/data/work"; fail=0
ok() { log "PASS $*"; }; bad() { log "FAIL $*"; fail=1; }
exp() { python3 -c "import json;print(json.load(open('$LAB/demo-stack/expected.json'))['$1'])"; }
dirsum() { (cd "$1" && find . -type f ! -name .gitkeep | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1); }
DEMO="docker compose -f $LAB/demo-stack/compose.yml -f $LAB/demo-stack/compose.override.yml"
agent() { bash "$LAB/lab.sh" agent "$@" >/dev/null 2>&1; sleep 12; }   # (re)create agent with variants, give it time to poll
backup_ok() { local b; b=$(trigger_backup "$1"); r=$(wait_backup "$b"); case "$r" in success*) echo "$b";; *) log "backup $1: $r" >&2; return 1;; esac; }
restore_ok() { local r; r=$(trigger_restore "$1" "$2"); wait_restore "$r"; }

bash "$LAB/demo-stack/seed.sh" --verify >/dev/null || { bad "seed != expected"; exit 1; }
mkdir -p "$W"
# data/work is created root-owned by the agent's bind mount: populate it through a helper container
populate() { docker run --rm -v "$W:/w" -v "$LAB/demo-stack/uploads:/src:ro" "$PGIMG" sh -c 'find /w -mindepth 1 -delete; mkdir -p /w/uploads; cp /src/file-*.txt /w/uploads/' >/dev/null; }
populate
bash "$LAB/drills/provision-sources.sh" work-uploads >/dev/null 2>&1 || true
pq -c "insert into databases(id,agent_database_id,name,dbms,agent_id,project_id,config,backup_engine)
  select gen_random_uuid(),gen_random_uuid(),'work-uploads','files',agent_id,project_id,'{\"path\":\"/lab/work/uploads\",\"options\":{\"exclude\":[],\"one_file_system\":false}}'::jsonb,'archive'
  from databases where name='demo-postgres' and not exists (select 1 from databases where name='work-uploads')"
pq -c "insert into databases(id,agent_database_id,name,dbms,agent_id,project_id,config,backup_engine)
  select gen_random_uuid(),gen_random_uuid(),'work-snapshot','files',agent_id,project_id,'{\"path\":\"/lab/work/uploads\",\"options\":{\"exclude\":[],\"one_file_system\":false}}'::jsonb,'restic'
  from databases where name='demo-postgres' and not exists (select 1 from databases where name='work-snapshot')"

# files written by the agent container are root-owned: do mutations through a helper container
mutate_uploads() { docker run --rm -v "$W:/w" "$PGIMG" sh -c 'rm -f /w/uploads/file-0[1-5].txt; echo tampered >> /w/uploads/file-10.txt'; }

# ---- Q1: read-only host bind -> backup ok, restore fails ----
log "== Q1 read-only bind =="; agent attach-demo-net host-bind-ro
b=$(backup_ok work-uploads) && ok "backup with read-only bind works"
mutate_uploads
r=$(restore_ok work-uploads "$b"); [ "$r" = failed ] && ok "restore in place with READ-ONLY bind FAILS as expected ($r)" || bad "ro restore result=$r"
agent_log 60s | grep -i -E "read-only|denied|permission|Failed" | head -3

# ---- writable bind: restore passes ----
log "== writable bind =="; agent attach-demo-net host-bind
populate   # the failed read-only restore left the tampered state behind: start from the pristine copy
b=$(backup_ok work-uploads); mutate_uploads
r=$(restore_ok work-uploads "$b"); [ "$r" = success ] && [ "$(dirsum "$W/uploads")" = "$(exp uploads)" ] && ok "files/archive restore in place diff=0" || bad "files/archive restore result=$r sum=$(dirsum "$W/uploads")"

populate; b=$(backup_ok work-snapshot); mutate_uploads
r=$(restore_ok work-snapshot "$b"); [ "$r" = success ] && [ "$(dirsum "$W/uploads")" = "$(exp uploads)" ] && ok "files/snapshot (restic) restore in place diff=0" || bad "snapshot restore result=$r sum=$(dirsum "$W/uploads")"

# ---- docker-volume ----
b=$(backup_ok demo-appdata-volume); docker run --rm -v forklab-demo_appdata:/vol "$PGIMG" sh -c 'rm -f /vol/file-1.txt /vol/file-2.txt; echo x > /vol/junk'
r=$(restore_ok demo-appdata-volume "$b"); sum=$(docker run --rm -v forklab-demo_appdata:/vol "$PGIMG" sh -c 'cd /vol && find . -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d" " -f1')
[ "$r" = success ] && [ "$sum" = "$(exp volume_appdata)" ] && ok "docker-volume restore in place diff=0" || bad "volume restore result=$r"

# ---- postgres ----
b=$(backup_ok demo-postgres); $DEMO exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qc "drop table items"'
r=$(restore_ok demo-postgres "$b"); sum=$($DEMO exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select string_agg(id||chr(58)||payload, chr(44) order by id) from items"' | sha256sum | cut -d' ' -f1)
[ "$r" = success ] && [ "$sum" = "$(exp postgres_items)" ] && ok "postgresql restore in place diff=0" || { bad "postgres restore result=$r"; agent_log 60s | grep -i -E "error|fail" | head -3; }

# ---- sqlite via docker-volume tar ----
b=$(backup_ok demo-sqlite-voltar); docker run --rm -v forklab-demo_sqlitedata:/data --entrypoint sh "$AGENTIMG" -c 'sqlite3 /data/app.db "delete from ledger where id>100"'
r=$(restore_ok demo-sqlite-voltar "$b")
sum=$(docker run --rm -v forklab-demo_sqlitedata:/data --entrypoint sh "$AGENTIMG" -c 'sqlite3 /data/app.db "select group_concat(id||char(58)||payload, char(44)) from (select * from ledger order by id)" | sha256sum | cut -d" " -f1')
[ "$r" = success ] && [ "$sum" = "$(exp sqlite_ledger)" ] && ok "sqlite-in-volume (docker-volume) restore in place diff=0" || bad "sqlite restore result=$r"

log "restore-diff done fail=$fail"; exit $fail
