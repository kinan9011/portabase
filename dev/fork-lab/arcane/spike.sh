#!/usr/bin/env bash
# W03 Arcane API spike. DISPOSABLE LAB ONLY: talks to the lab Arcane on loopback, synthetic data, read-only capability calls.
#
#   spike.sh [outdir]      default outdir = this directory
#
# What it does (all observed, nothing assumed):
#   1. fetches /api/openapi.json (+ version) and pins it as openapi.<version>.json (+ .sha256)
#   2. logs in as the LAB admin ONLY to mint/delete scoped API keys and to read the permission catalogue
#      (admin_call). Every capability call afterwards uses a scoped key via api_get (X-API-Key, GET only).
#   3. mints a minimum-permission key ("tier1") and a "deep" key (tier1 + projects:read), runs every capability
#      with them and records status/pagination/shape in spike-results.json
#   4. single-permission matrix: which permission each GET endpoint needs (permission-matrix.json)
#   5. exposure probes (does a read-class permission return secret bytes?) -> booleans only, never the values
#   6. 401 / 403 / 429 probes
#   7. writes scrubbed fixtures (forklab-* resources only) to fixtures/
#   8. deletes every key it created
# Needs: bash, curl, jq, sha256sum. Lab secrets are never printed; response bodies never leave this script except the
# scrubbed fixtures.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$HERE}"
ARC="${ARCANE_URL:-http://127.0.0.1:13552}"
API="$ARC/api"
ADM_USER="${LAB_ARCANE_ADMIN_USER:-arcane}"     # Arcane's documented first-run default; lab only
ADM_PASS="${LAB_ARCANE_ADMIN_PASSWORD:-arcane-admin}"
ENV_ID="${ARCANE_ENV_ID:-0}"                    # environment 0 = the manager's local Docker
STACKENV="$HERE/../demo-stack/stack.env"        # synthetic lab secrets: used only to test "does the API return this value?"

# ---- lab guard: loopback only, no bypass -------------------------------------------------------------------------
case "$ARC" in
  http://127.0.0.1:*|http://localhost:*|http://\[::1\]:*) ;;
  *) echo "refusing: ARCANE_URL must be a loopback lab address (got a non-loopback host)" >&2; exit 2 ;;
esac

TMP="$(mktemp -d)"; umask 077
ADMIN_TOKEN=""; CREATED_KEYS=()
cleanup() {
  for id in "${CREATED_KEYS[@]:-}"; do [ -n "$id" ] && admin_call DELETE "/api-keys/$id" >/dev/null 2>&1 || true; done
  rm -rf "$TMP"
}
trap cleanup EXIT

# ---- the only two functions that touch the network ----------------------------------------------------------------
# admin_call: LAB ADMIN bearer. Allowed uses: key mint/delete, permission catalogue. Never for a capability.
admin_call() { # method path [json-body] -> body on stdout, status in $TMP/status
  local m="$1" p="$2" b="${3:-}"
  local args=(-sS --max-time 20 -o "$TMP/body" -w '%{http_code}' -X "$m" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json')
  [ -n "$b" ] && args+=(--data "$b")
  curl "${args[@]}" "$API$p" >"$TMP/status"; cat "$TMP/body"
}
# api_get: scoped API key, GET ONLY. Sets $STATUS and writes the body to $TMP/body.
api_get() { # key path [extra curl args]
  local key="$1" p="$2"
  STATUS=$(curl -sS --max-time 20 -o "$TMP/body" -w '%{http_code}' -H "X-API-Key: $key" "$API$p" 2>/dev/null || echo 000)
}
login() { # Arcane rate-limits /auth/login (observed: 429 + Retry-After 60 after ~5 attempts/min, successes count): wait once
  local r try
  for try in 1 2; do
    r=$(curl -sS --max-time 20 -D "$TMP/hdr" -H 'Content-Type: application/json' --data "$(jq -n --arg u "$ADM_USER" --arg p "$ADM_PASS" '{username:$u,password:$p}')" "$API/auth/login")
    ADMIN_TOKEN=$(jq -r '.data.token // empty' <<<"$r" 2>/dev/null || true)
    [ -n "$ADMIN_TOKEN" ] && return 0
    if grep -qi '^HTTP/[0-9.]* 429' "$TMP/hdr"; then
      local ra; ra=$(awk 'tolower($1)=="retry-after:"{print $2}' "$TMP/hdr" | tr -d '\r'); echo "login rate-limited, waiting ${ra:-60}s" >&2; sleep "${ra:-60}"
    else break; fi
  done
  echo "lab admin login failed (is the lab Arcane up and still on the default admin?)" >&2; exit 1
}
mint_key() { # name perms-json -> sets MINTED (the key) and MINTED_ID; never call inside $(...) (id list must survive)
  local out; out=$(admin_call POST /api-keys "$(jq -n --arg n "$1" --argjson p "$2" '{name:$n,description:"W03 spike, lab only",permissions:$p}')")
  [ "$(cat "$TMP/status")" = 200 ] || { echo "key mint failed ($(cat "$TMP/status"))" >&2; exit 1; }
  MINTED_ID=$(jq -r '.data.id' <<<"$out"); MINTED=$(jq -r '.data.key' <<<"$out")
  CREATED_KEYS+=("$MINTED_ID")
}
del_old_keys() { # remove leftovers from an aborted run
  local ids; ids=$(admin_call GET "/api-keys?limit=200" | jq -r '.data[]? | select(.name|startswith("forklab-w03-")) | .id')
  for id in $ids; do admin_call DELETE "/api-keys/$id" >/dev/null || true; done
}

G() { jq -n --arg p "$1" '{permission:$p}'; }                               # global grant
E() { jq -n --arg p "$1" --arg e "$ENV_ID" '{permission:$p,environmentId:$e}'; } # environment-scoped grant

RESULTS="$TMP/results.ndjson"; : >"$RESULTS"
rec() { # capability key-tier method path status ok note
  jq -cn --arg c "$1" --arg t "$2" --arg m "$3" --arg p "$4" --argjson s "$5" --argjson ok "$6" --arg n "${7:-}" \
    '{capability:$c,key:$t,method:$m,path:$p,status:$s,ok:$ok,note:$n}' >>"$RESULTS"
}
need_body() { jq -e . "$TMP/body" >/dev/null 2>&1; }

mkdir -p "$OUT/fixtures"
login
del_old_keys

# ---- 1. pin the spec ----------------------------------------------------------------------------------------------
curl -sS --max-time 60 "$API/openapi.json" -o "$TMP/openapi.raw"
VERSION=$(jq -r '.info.version' "$TMP/openapi.raw")
[ -n "$VERSION" ] || { echo "no version in spec" >&2; exit 1; }
SPEC="$OUT/openapi.v$VERSION.json"
jq -S -c . "$TMP/openapi.raw" >"$SPEC"
( cd "$OUT" && sha256sum "openapi.v$VERSION.json" >"openapi.v$VERSION.json.sha256" )
echo "pinned $(basename "$SPEC") $(cut -d' ' -f1 "$SPEC.sha256")"

# ---- 2. permission catalogue (admin, metadata only) ----------------------------------------------------------------
admin_call GET /roles/available-permissions \
  | jq -S '[.data.resources[] | {resource:.key, scope, permissions:[.actions[].permission]}]' >"$OUT/permission-catalogue.json"

# ---- 3. keys ------------------------------------------------------------------------------------------------------
# tier1 = the minimum that still gives discovery (see ADR-002): lists only, environment-scoped, no *:read, no write
TIER1=$(jq -sc '.' <(G environments:list) <(E projects:list) <(E containers:list) <(E volumes:list) <(E networks:list) <(E images:list))
mint_key forklab-w03-tier1 "$TIER1"; KEY1=$MINTED
mint_key forklab-w03-deep "$(jq -c '. + [{permission:"projects:read",environmentId:"'"$ENV_ID"'"}]' <<<"$TIER1")"; KEY2=$MINTED

# ---- 4. capability runs (read-only) --------------------------------------------------------------------------------
cap() { # id tier key path [fixture-name]
  local id="$1" tier="$2" key="$3" p="$4"
  api_get "$key" "$p"
  local ok=false; [ "$STATUS" = 200 ] && need_body && ok=true
  rec "$id" "$tier" GET "$p" "$STATUS" "$ok" "${5:-}"
}
cap environments.list tier1 "$KEY1" "/environments?limit=100"
jq -c '.data[] | {id,status,enabled,isEdge}' "$TMP/body" >"$TMP/env.min" 2>/dev/null || true
cp "$TMP/body" "$TMP/env.list.json"
cap projects.list tier1 "$KEY1" "/environments/$ENV_ID/projects?limit=100"; cp "$TMP/body" "$TMP/projects.list.json"
cap containers.list tier1 "$KEY1" "/environments/$ENV_ID/containers?limit=100"; cp "$TMP/body" "$TMP/containers.list.json"
cap volumes.list tier1 "$KEY1" "/environments/$ENV_ID/volumes?limit=100"; cp "$TMP/body" "$TMP/volumes.list.json"
cap networks.list tier1 "$KEY1" "/environments/$ENV_ID/networks?limit=100"; cp "$TMP/body" "$TMP/networks.list.json"
cap images.list tier1 "$KEY1" "/environments/$ENV_ID/images?limit=100"; cp "$TMP/body" "$TMP/images.list.json"

PID=$(jq -r '[.data[]? | select(.name|startswith("forklab"))][0].id // empty' "$TMP/projects.list.json")
if [ -n "$PID" ]; then
  cap projects.get deep "$KEY2" "/environments/$ENV_ID/projects/$PID"
  cap projects.compose deep "$KEY2" "/environments/$ENV_ID/projects/$PID/compose"; cp "$TMP/body" "$TMP/project.compose.json"
  cap projects.runtime deep "$KEY2" "/environments/$ENV_ID/projects/$PID/runtime"; cp "$TMP/body" "$TMP/project.runtime.json"
  cap projects.workspace deep "$KEY2" "/environments/$ENV_ID/projects/$PID/workspace"; cp "$TMP/body" "$TMP/project.workspace.json"
else
  rec projects.get deep GET "(no forklab project discovered)" 0 false "lab demo project missing: mount demo-stack under /app/data/projects (compose.arcane.yml)"
fi

# pagination: limit / offset ("start") semantics
api_get "$KEY1" "/environments/$ENV_ID/containers?limit=2"; P1=$(jq -c '.pagination' "$TMP/body")
api_get "$KEY1" "/environments/$ENV_ID/containers?limit=2&start=2"; P2=$(jq -c '.pagination' "$TMP/body")
api_get "$KEY1" "/environments/$ENV_ID/containers?start=999999"; P3=$(jq -c '{n:(.data|length),p:.pagination}' "$TMP/body")
rec pagination tier1 GET "/environments/$ENV_ID/containers?limit=2[&start=2]" 200 true "limit=2: $P1 | limit=2,start=2: $P2 | start=999999: $P3"

# ---- 5. single-permission matrix ----------------------------------------------------------------------------------
CID=$(jq -r '[.data[]? | select(.names|any(test("^/?forklab-demo")))][0].id // empty' "$TMP/containers.list.json")
NID=$(jq -r '[.data[]? | select(.name|startswith("forklab-demo"))][0].id // empty' "$TMP/networks.list.json")
IID=$(jq -r '.data[0].id // empty' "$TMP/images.list.json")
VOL=$(jq -r '[.data[]? | select(.name|startswith("forklab-demo"))][0].name // empty' "$TMP/volumes.list.json")
declare -A EP=(
  [env.list]="/environments" [env.get]="/environments/$ENV_ID"
  [proj.list]="/environments/$ENV_ID/projects" [proj.get]="/environments/$ENV_ID/projects/$PID"
  [proj.compose]="/environments/$ENV_ID/projects/$PID/compose" [proj.runtime]="/environments/$ENV_ID/projects/$PID/runtime"
  [proj.workspace]="/environments/$ENV_ID/projects/$PID/workspace"
  [proj.workspace.file]="/environments/$ENV_ID/projects/$PID/workspace/file?relativePath=stack.env"
  [cont.list]="/environments/$ENV_ID/containers" [cont.get]="/environments/$ENV_ID/containers/$CID"
  [cont.edit-config]="/environments/$ENV_ID/containers/$CID/edit-config"
  [vol.list]="/environments/$ENV_ID/volumes" [vol.sizes]="/environments/$ENV_ID/volumes/sizes"
  [vol.get]="/environments/$ENV_ID/volumes/$VOL" [vol.usage]="/environments/$ENV_ID/volumes/$VOL/usage"
  [vol.workspace]="/environments/$ENV_ID/volumes/$VOL/workspace"
  [vol.workspace.file]="/environments/$ENV_ID/volumes/$VOL/workspace/file?relativePath=file-1.txt"
  [net.list]="/environments/$ENV_ID/networks" [net.get]="/environments/$ENV_ID/networks/$NID" [net.topology]="/environments/$ENV_ID/networks/topology"
  [img.list]="/environments/$ENV_ID/images" [img.get]="/environments/$ENV_ID/images/$IID"
)
PERMS=(environments:list environments:read projects:list projects:read projects:logs projects:update
       containers:list containers:read containers:logs containers:edit volumes:list volumes:read volumes:backup
       networks:list networks:read images:list images:read dashboard:read system:read)
MATRIX="$TMP/matrix.ndjson"; : >"$MATRIX"
for perm in "${PERMS[@]}"; do
  case "$perm" in environments:*) grant=$(G "$perm");; *) grant=$(E "$perm");; esac
  mint_key forklab-w03-matrix "[$grant]"; k=$MINTED
  for name in "${!EP[@]}"; do
    api_get "$k" "${EP[$name]}"
    jq -cn --arg perm "$perm" --arg ep "$name" --argjson s "$STATUS" '{permission:$perm,endpoint:$ep,status:$s}' >>"$MATRIX"
  done
  admin_call DELETE "/api-keys/$MINTED_ID" >/dev/null
done
jq -s 'group_by(.permission) | map({permission:.[0].permission, allows:([.[]|select(.status==200)|.endpoint]|sort)})' "$MATRIX" >"$OUT/permission-matrix.json"

# ---- 6. exposure probes: booleans only ----------------------------------------------------------------------------
SECRET=$(grep -E '^POSTGRES_PASSWORD=' "$STACKENV" | head -1 | cut -d= -f2-)
[ -n "$SECRET" ] || { echo "lab secret marker missing in stack.env" >&2; exit 1; }
leak() { grep -qF -- "$SECRET" "$TMP/body" && echo true || echo false; }
mint_key forklab-w03-probe-volumes "[$(E volumes:read)]"; KEYV=$MINTED
mint_key forklab-w03-probe-containers "[$(E containers:read)]"; KEYC=$MINTED
api_get "$KEY2" "/environments/$ENV_ID/projects/$PID/compose"; X_COMPOSE_SERVICES=$(jq -r --arg s "$SECRET" '[.data.services[]? | tostring | contains($s)] | any' "$TMP/body")
api_get "$KEY2" "/environments/$ENV_ID/projects/$PID/workspace/file?relativePath=stack.env"; X_ENVFILE_STATUS=$STATUS; X_ENVFILE=$(leak)
api_get "$KEY2" "/environments/$ENV_ID/projects/$PID/workspace/file?relativePath=..%2F..%2Fetc%2Fpasswd"; X_TRAVERSAL=$STATUS
api_get "$KEYC" "/environments/$ENV_ID/containers/$CID"; X_INSPECT=$(leak)
api_get "$KEYC" "/environments/$ENV_ID/containers/$CID/edit-config"; X_EDITCFG=$(leak)
api_get "$KEYV" "/environments/$ENV_ID/volumes/$VOL/workspace/file?relativePath=file-1.txt"; X_VOLFILE_STATUS=$STATUS; X_VOLFILE_BYTES=$(jq -r '(.data.content // "") | length > 0' "$TMP/body" 2>/dev/null || echo false)
api_get "$KEY1" "/environments/$ENV_ID/containers"; X_TIER1_CONT_ENV=$(leak)
api_get "$KEY1" "/environments/$ENV_ID/projects/$PID/workspace"; X_TIER1_WS=$STATUS
api_get "$KEY1" "/environments/$ENV_ID/volumes/$VOL"; X_TIER1_VOLGET=$STATUS
jq -n --argjson a "$X_COMPOSE_SERVICES" --argjson b "$X_ENVFILE" --argjson c "$X_ENVFILE_STATUS" --argjson d "$X_TRAVERSAL" \
  --argjson e "$X_INSPECT" --argjson f "$X_EDITCFG" --argjson g "$X_VOLFILE_STATUS" --argjson h "$X_VOLFILE_BYTES" \
  --argjson i "$X_TIER1_CONT_ENV" --argjson j "$X_TIER1_WS" --argjson k "$X_TIER1_VOLGET" '
  {note:"booleans/status only; the lab secret value is never written",
   projects_read_compose_services_contain_env_value:$a,
   projects_read_workspace_file_status_env_file:$c, projects_read_workspace_file_returns_env_value:$b,
   projects_read_workspace_file_path_traversal_status:$d,
   containers_read_inspect_returns_env_value:$e, containers_read_edit_config_returns_env_value:$f,
   volumes_read_workspace_file_status:$g, volumes_read_workspace_file_returns_bytes:$h,
   tier1_container_list_contains_env_value:$i, tier1_project_workspace_status:$j, tier1_volume_get_status:$k}' >"$TMP/exposure.json"

# ---- 7. 401 / 403 / 429 probes ------------------------------------------------------------------------------------
api_get "" "/environments"; S401A=$STATUS
api_get "arc_invalid_key" "/environments"; S401B=$STATUS
api_get "$KEY1" "/environments/$ENV_ID/projects/$PID"; S403A=$STATUS; D403A=$(jq -r '.detail // ""' "$TMP/body")
api_get "$KEY1" "/environments/$ENV_ID/volumes/$VOL/workspace/file?relativePath=file-1.txt"; S403B=$STATUS
# one denied negative: a POST with the read-only key (admin_call is NOT used; plain curl with the scoped key)
S403W=$(curl -sS --max-time 20 -o "$TMP/body" -w '%{http_code}' -X POST -H "X-API-Key: $KEY1" "$API/environments/$ENV_ID/test")
# unscoped (global) grant of an env-scoped permission reaches every environment
mint_key forklab-w03-probe-global "[$(G containers:list)]"; KEYG=$MINTED; api_get "$KEYG" "/environments/$ENV_ID/containers"; SGLOBAL=$STATUS
# burst: 300 sequential GETs with the tier1 key (rate limit?), 150 bad keys
B_OK=0; B_429=0
for _ in $(seq 1 300); do api_get "$KEY1" "/environments/$ENV_ID/containers?limit=1"; [ "$STATUS" = 200 ] && B_OK=$((B_OK+1)); [ "$STATUS" = 429 ] && B_429=$((B_429+1)); done
BK_401=0; BK_429=0
for i in $(seq 1 150); do api_get "arc_bad_$i" "/environments"; [ "$STATUS" = 401 ] && BK_401=$((BK_401+1)); [ "$STATUS" = 429 ] && BK_429=$((BK_429+1)); done
L401=0; L429=0; RA=""
for i in $(seq 1 10); do
  c=$(curl -sS --max-time 20 -D "$TMP/hdr" -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' --data '{"username":"nobody","password":"wrong"}' "$API/auth/login")
  [ "$c" = 401 ] && L401=$((L401+1)); [ "$c" = 429 ] && { L429=$((L429+1)); RA=$(awk 'tolower($1)=="retry-after:"{print $2}' "$TMP/hdr" | tr -d '\r'); break; }
done
jq -n --argjson a "$S401A" --argjson b "$S401B" --argjson c "$S403A" --arg d "$D403A" --argjson e "$S403B" --argjson f "$S403W" --argjson g "$SGLOBAL" \
  --argjson ba "$B_OK" --argjson bb "$B_429" --argjson ca "$BK_401" --argjson cb "$BK_429" --argjson la "$L401" --argjson lb "$L429" --arg ra "$RA" '
  {no_key:$a, invalid_key:$b, forbidden_project_get_with_tier1:{status:$c,detail:$d}, forbidden_volume_file_with_tier1:$e,
   read_only_key_POST_environment_test:$f, unscoped_env_permission_reaches_env:$g,
   burst_300_gets:{ok:$ba,status_429:$bb}, bad_key_burst_150:{status_401:$ca,status_429:$cb},
   bad_login_burst:{status_401:$la,status_429:$lb,retry_after_seconds:$ra}}' >"$TMP/probes.json"

# ---- 8. scrubbed fixtures (forklab-* resources only; counts for the rest) ------------------------------------------
SCRUB='def scrub: walk(if type=="string" then
    gsub("/home/[^/\"]+/[^\"]*/dev/fork-lab";"/srv/fork-lab") | gsub("/home/[^/\"]+";"/srv/lab") | gsub("[0-9]{1,3}(\\.[0-9]{1,3}){3}";"192.0.2.1")
    | gsub("([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}";"00:00:5e:00:53:00")
    | gsub("\\b(?<!sha256:)(?<x>[0-9a-f]{12})[0-9a-f]{28,}";"\(.x)") else . end) | del(..|."$schema"?);'
fx() { jq -S "$SCRUB $2 | scrub" "$TMP/$1" >"$OUT/fixtures/$3"; }
fx env.list.json   '.data |= map({id,name:("lab-env-"+.id),apiUrl:"http://lab-arcane.invalid",status,enabled,isEdge,lastSeen:"2026-01-01T00:00:00Z"})' environments.list.json
fx containers.list.json '.data |= map(select(.names|any(test("^/?forklab-demo")))) | .counts={note:"host-wide counts dropped",kept:(.data|length)} | .pagination|=del(.grandTotalItems)' containers.list.json
fx volumes.list.json  '.data |= map(select(.name|startswith("forklab-demo"))) | .counts={kept:(.data|length)}' volumes.list.json
fx networks.list.json '.data |= map(select(.name|startswith("forklab"))) | .counts={kept:(.data|length)}' networks.list.json
KEPT_IMG=$(jq -c '[.data[].imageId]' "$OUT/fixtures/containers.list.json")
jq -S --argjson K "$KEPT_IMG" "$SCRUB .data |= map(select(.id as \$i | \$K | index(\$i))) | scrub" "$TMP/images.list.json" >"$OUT/fixtures/images.list.json"
fx projects.list.json '.data |= map(select(.name|startswith("forklab")))' projects.list.json
if [ -f "$TMP/project.compose.json" ]; then
  fx project.compose.json '.data.services |= map(del(.environment))' project.compose.json
  fx project.workspace.json '.data.files |= map(select(.isDirectory or (.name|test("^(compose|expected|seed)"))) | {name,relativePath,isDirectory,isSymlink,size,editable})' project.workspace.json
fi

# ---- 9. assemble ---------------------------------------------------------------------------------------------------
jq -s --arg v "$VERSION" --arg h "sha256:$(cut -d' ' -f1 "$SPEC.sha256")" --arg at "$(date -u +%FT%TZ)" \
  --slurpfile ex "$TMP/exposure.json" --slurpfile pr "$TMP/probes.json" \
  '{arcane_version:$v, openapi_sha256:$h, run_at:$at, capabilities:., exposure:$ex[0], probes:$pr[0]}' "$RESULTS" >"$OUT/spike-results.json"
echo "done: $(jq '.capabilities|length' "$OUT/spike-results.json") capability rows, matrix $(jq length "$OUT/permission-matrix.json") permissions"
