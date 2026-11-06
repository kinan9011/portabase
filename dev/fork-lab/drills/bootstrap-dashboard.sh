#!/usr/bin/env bash
# Reproducible lab bootstrap of the dashboard, so a clean checkout reaches "agent enrolled + sources registered" with no
# browser step: org default (created by the dashboard at boot) -> S3 storage channel -> project -> agent -> edge key ->
# postgres source (password AES-256-GCM encrypted exactly like credential-crypto.ts) -> matrix sources.
# DEVIATION (ADR-001): the first lab was onboarded by hand through the real UI (welcome wizard, storage modal, agent step,
# add-database modal); this script writes the SAME rows those UI actions wrote, because the dashboard has no create API and a
# browser cannot run in a clean-checkout timing test. Everything after registration is upstream code. Lab only; idempotent.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
DASH=forklab-portabase-dashboard-1
ORG=$(pq -c "select id from organization where slug='default'")
[ -n "$ORG" ] || { echo "default organization missing: is the dashboard up?" >&2; exit 1; }
URL="http://forklab-dashboard.localhost:18887"

pq -c "insert into storage_channel(provider,name,config,enabled)
  select 's3','lab-minio','{\"ssl\":false,\"port\":9000,\"region\":\"us-east-1\",\"accessKey\":\"$LAB_S3_AGENT_KEY\",\"secretKey\":\"$LAB_S3_AGENT_SECRET\",\"bucketName\":\"lab-primary\",\"endPointUrl\":\"forklab-minio\"}'::jsonb,true
  where not exists (select 1 from storage_channel where name='lab-minio')"
pq -c "insert into projects(slug,name,organization_id) select 'demo-stack','demo-stack','$ORG' where not exists (select 1 from projects where slug='demo-stack')"
pq -c "insert into agents(slug,name,description,organization_id) select 'lab-agent','lab-agent','','$ORG' where not exists (select 1 from agents where slug='lab-agent')"
AGENT_ID=$(pq -c "select id from agents where slug='lab-agent'")

# node inside the dashboard container (has the master key, root-only file): edge key + encrypted postgres password
OUT=$(docker exec -u 0 -i "$DASH" node -e '
const fs=require("fs"),c=require("crypto");
const mk=fs.readFileSync("/data/private/keys/master_key.bin");
const edge=Buffer.from(JSON.stringify({serverUrl:process.argv[1],agentId:process.argv[2],masterKeyB64:mk.toString("base64")})).toString("base64");
const iv=c.randomBytes(12),ci=c.createCipheriv("aes-256-gcm",mk,iv);
const ct=Buffer.concat([ci.update(process.argv[3],"utf8"),ci.final()]);
console.log(JSON.stringify({edge,secret:{__encrypted:true,version:1,kid:"credentials-v1",iv:iv.toString("base64"),ciphertext:ct.toString("base64"),tag:ci.getAuthTag().toString("base64")}}));
' "$URL" "$AGENT_ID" "demo-synthetic-not-a-secret")
EDGE=$(printf '%s' "$OUT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["edge"])')
SECRET=$(printf '%s' "$OUT" | python3 -c 'import json,sys;print(json.dumps(json.load(sys.stdin)["secret"]))')
bash "$LAB/lab.sh" edge-key "$EDGE"

pq -c "insert into databases(id,agent_database_id,name,dbms,agent_id,project_id,config,backup_engine)
  select gen_random_uuid(),gen_random_uuid(),'demo-postgres','postgresql','$AGENT_ID',p.id,
  jsonb_build_object('host','demo-db','port',5432,'database','demo','username','demo','password','$SECRET'::jsonb),'archive'
  from projects p where p.slug='demo-stack' and not exists (select 1 from databases where name='demo-postgres' and deleted_at is null)"
bash "$LAB/drills/provision-sources.sh" >/dev/null
echo "bootstrap: agent $AGENT_ID enrolled (edge key stored in .env.lab), $(pq -c "select count(*) from databases where deleted_at is null") sources registered"
