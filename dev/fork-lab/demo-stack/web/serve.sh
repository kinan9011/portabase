#!/bin/sh
# Tiny status server (busybox nc -e): every request runs handle.sh, so DB rows / uploads / volume are read per request.
while true; do nc -l -p 8080 -e /bin/sh /app/handle.sh >/dev/null 2>&1; done
