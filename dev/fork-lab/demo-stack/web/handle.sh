#!/bin/sh
# One HTTP/1.0 response, computed when the connection arrives (so it reflects the data at request time).
export PGPASSWORD="$POSTGRES_PASSWORD"
printf 'HTTP/1.0 200 OK\r\nContent-Type: text/plain\r\n\r\n'
echo "greeting=$APP_GREETING"
echo "rows=$(psql -h demo-db -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc 'select count(*) from items' 2>&1)"
echo "uploads=$(ls /uploads 2>/dev/null | wc -l)"
echo "appdata=$(ls /appdata 2>/dev/null | wc -l)"
