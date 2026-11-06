#!/usr/bin/env bash
# W03 LAB ONLY: pair a second ("remote") Arcane environment with the lab manager so spike.sh can verify remote-environment
# behaviour. Uses the LAB admin session for the two writes Arcane needs (create environment, start the Arcane agent with the
# token Arcane returns) - lab setup, never a fork capability. The token goes only through the process environment of
# `docker compose`; it is never written to a file or printed. Re-run to re-pair. `lab.sh reset` removes everything.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; LAB="$HERE/.."
ARC="${ARCANE_URL:-http://127.0.0.1:13552}"; API="$ARC/api"
case "$ARC" in http://127.0.0.1:*|http://localhost:*|http://\[::1\]:*) ;; *) echo "refusing: loopback lab address only" >&2; exit 2 ;; esac
J=(-sS --max-time 20 -H 'Content-Type: application/json')
TOK=$(curl "${J[@]}" --data "$(jq -n --arg u "${LAB_ARCANE_ADMIN_USER:-arcane}" --arg p "${LAB_ARCANE_ADMIN_PASSWORD:-arcane-admin}" '{username:$u,password:$p}')" "$API/auth/login" | jq -r '.data.token // empty')
[ -n "$TOK" ] || { echo "lab admin login failed (login is rate limited: wait 60 s)" >&2; exit 1; }
A=(-H "Authorization: Bearer $TOK")
for id in $(curl "${J[@]}" "${A[@]}" "$API/environments?limit=100" | jq -r '.data[] | select(.name=="forklab-remote") | .id'); do
  curl "${J[@]}" "${A[@]}" -X DELETE "$API/environments/$id" >/dev/null
done
AGENT_KEY=$(curl "${J[@]}" "${A[@]}" --data '{"name":"forklab-remote","apiUrl":"http://forklab-arcane-agent:3553","enabled":true,"isEdge":false,"useApiKey":true}' "$API/environments" | jq -r '.data.apiKey // empty')
[ -n "$AGENT_KEY" ] || { echo "environment create did not return an agent token" >&2; exit 1; }
LAB_ARCANE_AGENT_TOKEN="$AGENT_KEY" docker compose --env-file "$LAB/.env.lab" -f "$LAB/compose.arcane.yml" --profile arcane-agent up -d --force-recreate arcane-agent >/dev/null
unset AGENT_KEY
for _ in $(seq 1 30); do
  st=$(curl "${J[@]}" "${A[@]}" "$API/environments?limit=100" | jq -r '.data[] | select(.name=="forklab-remote") | .status')
  [ "$st" = online ] && { echo "forklab-remote online"; exit 0; }
  sleep 2
done
echo "forklab-remote did not come online" >&2; exit 1
