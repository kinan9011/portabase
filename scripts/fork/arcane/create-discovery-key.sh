#!/usr/bin/env bash
# Creates the Portabase fork's Arcane DISCOVERY key: list permissions only, scoped to ONE environment.
# Why a script: Arcane's UI cannot scope grants to one environment; its API (POST /api-keys) can.
# Contains no secrets. You type the admin credential when asked (hidden); nothing is written to disk or shell history.
#
# Needs: bash, curl, jq.  Run it in YOUR OWN terminal:   bash scripts/fork/arcane/create-discovery-key.sh
# Docs: scripts/fork/arcane/README.md · ADR-002 (A2, A7) · permission names mirror src/fork/arcane/endpoints.ts (pinned by a unit test).
set -euo pipefail

BASE="${ARCANE_API:-http://192.168.8.171:3552/api}"          # Arcane manager API (override: ARCANE_API=... bash ...)
KEYNAME="${KEYNAME:-portabase-fork-discovery}"
CURL=(curl -sS -m 20)
[ "${INSECURE:-0}" = "1" ] && CURL+=(-k)                    # only if your Arcane uses a self-signed https certificate

for t in curl jq; do command -v "$t" >/dev/null || { echo "missing tool: $t"; exit 1; }; done

echo "Arcane API: $BASE"
echo "Paste a TEMPORARY ADMIN API key (create one in Arcane UI -> Settings -> API Keys with full access;"
echo "you will delete it at the end). Input is hidden."
read -rsp "Admin API key: " ADMIN_KEY; echo
[ -n "$ADMIN_KEY" ] || { echo "empty key"; exit 1; }
H=(-H "X-API-Key: $ADMIN_KEY")

echo; echo "Environments Arcane lists:"
ENVS=$("${CURL[@]}" "${H[@]}" "$BASE/environments?limit=100") || { echo "cannot reach Arcane"; exit 1; }
echo "$ENVS" | jq -r '(.data // [])[] | "  id=\(.id)   name=\(.name)   \(.apiUrl // "")"' || { echo "unexpected response:"; echo "$ENVS" | head -c 300; exit 1; }

read -rp "Type the environment id of the PILOT host (192.168.8.32): " ENV_ID
echo "$ENVS" | jq -e --arg id "$ENV_ID" '(.data // []) | any(.id == $id)' >/dev/null || { echo "id not in the list above"; exit 1; }

BODY=$(jq -n --arg name "$KEYNAME" --arg env "$ENV_ID" '{
  name: $name,
  description: "Portabase fork discovery key: list permissions only, one environment",
  permissions: (
    [{permission: "environments:list"}] +
    ( ["projects:list","containers:list","volumes:list","networks:list","images:list"]
      | map({permission: ., environmentId: $env}) )
  )}')

echo; echo "Creating key with these grants:"; echo "$BODY" | jq -c '.permissions[]'
read -rp "Create it? [y/N] " OK; [ "$OK" = "y" ] || { echo "aborted"; exit 1; }

RESP=$("${CURL[@]}" "${H[@]}" -H 'Content-Type: application/json' -X POST "$BASE/api-keys" -d "$BODY")
KEY=$(echo "$RESP" | jq -r '.data.key // empty')
if [ -z "$KEY" ]; then echo "FAILED. Arcane said:"; echo "$RESP" | jq -c '{success, error: (.error // .detail // .message // .)}' 2>/dev/null || echo "$RESP" | head -c 400; exit 1; fi

echo; echo "================= NEW DISCOVERY KEY (shown once) ================="
echo "$KEY"
echo "=================================================================="
echo "1) Copy it now. Dashboard -> Integrations -> Arcane -> rotate key -> paste."
echo "2) Then delete the TEMPORARY ADMIN key in Arcane (Settings -> API Keys)."
unset ADMIN_KEY KEY RESP BODY
