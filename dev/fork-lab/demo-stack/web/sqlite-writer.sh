#!/bin/sh
# Continuous WAL-mode writer. Oracle on any backup copy: `PRAGMA integrity_check` = ok AND count(*) = max(id)
# (rows are inserted two at a time inside one transaction, so a consistent copy has an EVEN count and no gaps).
DB=/data/app.db
sqlite3 "$DB" "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS ledger(id INTEGER PRIMARY KEY, payload TEXT NOT NULL);" >/dev/null
i=$(sqlite3 "$DB" "select coalesce(max(id),0) from ledger")
while true; do
  a=$((i + 1))
  b=$((i + 2))
  if sqlite3 "$DB" "PRAGMA busy_timeout=5000; BEGIN; INSERT INTO ledger(id,payload) VALUES($a,hex(randomblob(256))); INSERT INTO ledger(id,payload) VALUES($b,hex(randomblob(256))); COMMIT;" >/dev/null 2>&1; then
    i=$b
  fi
  sleep 0.02
done
