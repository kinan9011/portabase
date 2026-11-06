#!/bin/sh
# Tiny status server (HTTP/1.0 over busybox nc): DB row count + uploads count + volume marker count.
export PGPASSWORD="$POSTGRES_PASSWORD"
while true; do
  {
    printf 'HTTP/1.0 200 OK\r\nContent-Type: text/plain\r\n\r\n'
    echo "greeting=$APP_GREETING"
    echo "rows=$(psql -h demo-db -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc 'select count(*) from items' 2>&1)"
    echo "uploads=$(ls /uploads 2>/dev/null | wc -l)"
    echo "appdata=$(ls /appdata 2>/dev/null | wc -l)"
  } | nc -l -p 8080 >/dev/null 2>&1
done
