#!/usr/bin/env bash
# Create the lab primary bucket + two S3 identities (F4, plan v2.2 §4.5):
#   agent  = what the VPS-side agent uses: read/write/DELETE on lab-primary (upstream behaviour today, §13 A6)
#   pull   = home-side pull job: READ ONLY on lab-primary (cannot delete or overwrite anything)
# Runs `mc` inside the minio container (the image ships /bin/mc). Idempotent. Lab only.
set -euo pipefail
LAB="$(cd "$(dirname "$0")/.." && pwd)"
. "$LAB/.env.lab"
C=forklab-portabase-minio-1
mc() { docker exec -i "$C" mc "$@"; }

mc alias set lab http://127.0.0.1:9000 "$LAB_MINIO_ROOT_USER" "$LAB_MINIO_ROOT_PASSWORD" >/dev/null
mc mb --ignore-existing lab/lab-primary >/dev/null
mc mb --ignore-existing lab/lab-protected >/dev/null   # object-lock variant bucket (see f4-gate.sh)

docker exec -i "$C" sh -c 'cat > /tmp/agent-rw.json' <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:*"],"Resource":["arn:aws:s3:::lab-primary","arn:aws:s3:::lab-primary/*"]}]}
EOF
docker exec -i "$C" sh -c 'cat > /tmp/pull-ro.json' <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject","s3:ListBucket","s3:GetBucketLocation"],"Resource":["arn:aws:s3:::lab-primary","arn:aws:s3:::lab-primary/*"]}]}
EOF
mc admin policy create lab agent-rw /tmp/agent-rw.json >/dev/null 2>&1 || mc admin policy create lab agent-rw /tmp/agent-rw.json >/dev/null || true
mc admin policy create lab pull-ro /tmp/pull-ro.json >/dev/null 2>&1 || true
mc admin user add lab "$LAB_S3_AGENT_KEY" "$LAB_S3_AGENT_SECRET" >/dev/null 2>&1 || true
mc admin user add lab "$LAB_S3_PULL_KEY" "$LAB_S3_PULL_SECRET" >/dev/null 2>&1 || true
mc admin policy attach lab agent-rw --user "$LAB_S3_AGENT_KEY" >/dev/null 2>&1 || true
mc admin policy attach lab pull-ro --user "$LAB_S3_PULL_KEY" >/dev/null 2>&1 || true
echo "minio-init: buckets lab-primary, lab-protected; users agent (rw+delete), pull (read-only)"
mc ls lab
