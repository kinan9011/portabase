#!/usr/bin/env bash
# Structural diff of two Arcane OpenAPI documents (W03). Run on every Arcane bump:
#   scripts/fork/arcane-openapi-diff.sh dev/fork-lab/arcane/openapi.v<pinned>.json <new-spec.json>
# Compares operations (method + path: parameters, request body, responses, security) and component schemas.
# Prose (description / summary / examples) and info.version are ignored: they change on every release.
# Exit: 0 = no structural change, 1 = structural change (listing follows), 2 = usage / unreadable input.
# Needs jq only. Reads two local files; never touches the network.
set -euo pipefail
export LC_ALL=C
[ $# -eq 2 ] || { echo "usage: $0 <pinned-openapi.json> <new-openapi.json>" >&2; exit 2; }
for f in "$1" "$2"; do
  [ -r "$f" ] && jq -e '(.openapi|type=="string") and (.paths|type=="object")' "$f" >/dev/null 2>&1 \
    || { echo "not a readable OpenAPI document: $f" >&2; exit 2; }
done

# one line per operation / schema: "<key>\t<canonical JSON of the structure without prose>" (tojson escapes tabs/newlines)
sig() {
  jq -r '
    def strip: walk(if type=="object" then del(.description, .summary, .example, .examples, .title) else . end);
    ( .paths | to_entries[] | .key as $p | .value | to_entries[]
      | select(.key | IN("get","put","post","delete","patch","head","options"))
      | "op \(.key|ascii_upcase) \($p)\t\(.value | {parameters, requestBody, responses, security} | strip | tojson)" ),
    ( (.components.schemas // {}) | to_entries[] | "schema \(.key)\t\(.value | strip | tojson)" )
  ' "$1" | sort
}

OLD="$(mktemp)"; NEW="$(mktemp)"; trap 'rm -f "$OLD" "$NEW"' EXIT
sig "$1" >"$OLD"; sig "$2" >"$NEW"

ov=$(jq -r '.info.version // "?"' "$1"); nv=$(jq -r '.info.version // "?"' "$2")
echo "pinned $ov  ->  new $nv"
status=0
report() { # label lines
  [ -n "$2" ] || return 0
  status=1; echo "== $1 ($(printf '%s\n' "$2" | wc -l))"; printf '%s\n' "$2" | sed 's/^/  /'
}
report "removed (breaking)" "$(comm -23 <(cut -f1 "$OLD") <(cut -f1 "$NEW"))"
report "added" "$(comm -13 <(cut -f1 "$OLD") <(cut -f1 "$NEW"))"
changed=$(join -t $'\t' <(sort "$OLD") <(sort "$NEW") | awk -F'\t' '$2 != $3 {print $1}')
report "changed structure" "$changed"
[ "$status" -eq 0 ] && echo "no structural change"
exit "$status"
