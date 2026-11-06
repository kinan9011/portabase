#!/usr/bin/env bash
# D29 / ARCH-11 spike: is a sqlite file inside a Docker volume dumped CONSISTENTLY while a WAL-mode writer is running?
# Three ways to reach the file, each backed up N times against a live writer (2 rows per transaction, no gaps possible in a
# consistent copy): oracle on every artifact = integrity_check ok AND count(*)=max(id) AND count even.
#   mount   : `sqlite` source, volume mounted into the agent at /lab/sqlite   (override.volume-mount, ro and rw tried)
#   volpath : `sqlite` source on /var/lib/docker/volumes/<vol>/_data/app.db   (override.volumes-path, ro)
#   voltar  : `docker-volume` source (tar of the volume; the upstream way)     (no mount needed, docker socket only)
set -uo pipefail
. "$(dirname "$0")/lib.sh"
N="${N:-6}"; X="$RES/sqlite"; mkdir -p "$X"
DEMO="docker compose -f $LAB/demo-stack/compose.yml -f $LAB/demo-stack/compose.override.yml"

check() { # extracted-dir -> echo "ok|BAD:<why>"
  docker run --rm -v "$1:/in:ro" --entrypoint sh "$AGENTIMG" -c '
    cp -r /in /w && f=$(find /w -type f ! -name "*-wal" ! -name "*-shm" | head -1)
    [ -n "$f" ] || { echo "BAD:no-db-file($(ls /w | tr "\n" " "))"; exit 0; }
    i=$(sqlite3 "$f" "pragma integrity_check" 2>&1 | head -1); [ "$i" = ok ] || { echo "BAD:integrity:$i"; exit 0; }
    r=$(sqlite3 "$f" "select count(*)||\" \"||max(id) from ledger" 2>&1); c=${r% *}; m=${r#* }
    [ "$c" = "$m" ] && [ $((c % 2)) -eq 0 ] && echo "ok:$c" || echo "BAD:rows=$r"'
}
run_variant() { # source-name label
  local s="$1" okc=0 bad=0 res i b p d
  for i in $(seq 1 "$N"); do
    b=$(trigger_backup "$s"); r=$(wait_backup "$b" 90)
    case "$r" in success*) ;; *) bad=$((bad+1)); echo "  [$2 #$i] backup $r"; continue;; esac
    p=$(pq -c "select path from backup_storage where backup_id='$b' and status='success'")
    d="$X/$s-$i"; mkdir -p "$d"; mc_lab "mc cat lab/lab-primary/$p" | tar -xzf - -C "$d" 2>/dev/null
    res=$(check "$d"); case "$res" in ok*) okc=$((okc+1));; *) bad=$((bad+1)); echo "  [$2 #$i] $res";; esac
  done
  echo "RESULT $2: consistent $okc / $N, inconsistent-or-failed $bad"
}

$DEMO --profile sqlite up -d sqlite-writer >/dev/null 2>&1; sleep 3
docker exec forklab-demo-sqlite-writer-1 sh -c 'sqlite3 /data/app.db "select count(*) from ledger"' 2>/dev/null | sed 's/^/writer rows at start: /'

agentv() { bash "$LAB/lab.sh" agent attach-demo-net host-bind "$@" >/dev/null 2>&1; sleep 12; }
log "variant D-ro: one named volume mounted READ-ONLY into the agent"; agentv volume-mount
run_variant demo-sqlite-mount "sqlite source, volume mount ro"
log "variant D-rw: the same volume mounted read-write"; agentv volume-mount-rw
run_variant demo-sqlite-mount "sqlite source, volume mount rw"
log "variant C-ro: /var/lib/docker/volumes mounted read-only"; agentv volumes-path
run_variant demo-sqlite-volpath "sqlite source, /var/lib/docker/volumes ro"
log "variant C-rw: /var/lib/docker/volumes mounted read-write (rejected option, measured for the record)"; agentv volumes-path-rw
run_variant demo-sqlite-volpath "sqlite source, /var/lib/docker/volumes rw"
log "variant docker-volume tar (no mount, docker socket only)"; agentv
run_variant demo-sqlite-voltar "docker-volume tar of live volume"
agent_log 5m | grep -i -E "sqlite|readonly|read-only|locked|unable" | sort | uniq -c | sort -rn | head -5
$DEMO --profile sqlite stop sqlite-writer >/dev/null 2>&1
