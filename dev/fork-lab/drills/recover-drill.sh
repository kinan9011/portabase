#!/usr/bin/env bash
# W14b live drill (FORK_LAB=1, lab only): restore the demo stack with `portabase-recover` from STORAGE + KIT alone after the dashboard DB, the agent
# and the original stack are gone, onto a SECOND project (own network, own volumes) on the same docker daemon, and compare with the W02 oracle
# (demo-stack/expected.json). Precondition: `w14-lab` live test (case 5) left results/w14b/ (kit.pbkit, passphrase.txt [TEST-ONLY], paper-lines.txt,
# rclone.conf, info.json) and a verified recovery point in MinIO. Same-host second project is the W14b scope; the real clean-host drill is W14P.
# Records exact timings. Never prints keys: the CLI keeps them in a 0600 work dir.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
[ "${FORK_LAB:-}" = 1 ] || { echo "set FORK_LAB=1 (lab only)" >&2; exit 2; }
CLI="$(cd "$LAB/../.." && pwd)/scripts/fork/recover/portabase-recover"
OUT="$RES/w14b"; ROOT="$OUT/restore-root"; REP="$OUT/recover-drill.txt"
PROJ="forklab-recover"; fail=0
ok()  { log "PASS $*" | tee -a "$REP"; }
bad() { log "FAIL $*" | tee -a "$REP"; fail=1; }
tm()  { date +%s.%N; }
el()  { python3 -c "import sys;print(f'{float(sys.argv[2])-float(sys.argv[1]):.1f}s')" "$1" "$2"; }
exp() { python3 -c "import json;print(json.load(open('$LAB/demo-stack/expected.json'))['$1'])"; }
dirsum() { (cd "$1" && find . -type f ! -name .gitkeep | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1); }
: >"$REP"
[ -f "$OUT/info.json" ] || { echo "results/w14b missing: run the w14-lab live test first" >&2; exit 2; }
STACK="$(jq -r .stackId "$OUT/info.json")"; SR="$(jq -r .storageRoot "$OUT/info.json")"
K=(--rclone-config "$OUT/rclone.conf" --storage-root "$SR" --stack "$STACK")
KD=(--kit "$OUT/kit.pbkit" --passphrase-file "$OUT/passphrase.txt" "${K[@]}")
KP=(--paper-file "$OUT/paper-lines.txt" "${K[@]}")
rc() { rclone --config "$OUT/rclone.conf" "$@"; }

if [ "${DRILL_ONLY:-}" != tamper ]; then
  log "== oracle intact before the disaster ==" | tee -a "$REP"
  bash "$LAB/demo-stack/seed.sh" --verify >/dev/null 2>&1 && ok "source stack == expected.json before the drill" || { bad "source stack differs from the oracle before the drill"; exit 1; }
fi

log "== read-only: list, plan --deep, verify-kit (timed) ==" | tee -a "$REP"
t=$(tm); bash "$CLI" list "${KD[@]}" >"$OUT/list.txt" 2>&1; log "list: $(el "$t" "$(tm)") exit=$?" | tee -a "$REP"
t=$(tm); bash "$CLI" plan --deep "${KD[@]}" >"$OUT/plan.txt" 2>&1; prc=$?; log "plan --deep: $(el "$t" "$(tm)") exit=$prc" | tee -a "$REP"
[ "$prc" = 0 ] && ok "plan --deep on the live signed recovery point: signature + every archive verified, nothing changed" || { bad "plan --deep failed"; tail -5 "$OUT/plan.txt"; }
sed -n '/Recovery plan/,/consistency/p' "$OUT/plan.txt" | tee -a "$REP"
t=$(tm); bash "$CLI" verify-kit "${KP[@]}" >"$OUT/vk.txt" 2>&1; vrc=$?; log "verify-kit (paper): $(el "$t" "$(tm)") exit=$vrc" | tee -a "$REP"
[ "$vrc" = 0 ] && grep -q "Verification code" "$OUT/vk.txt" && ok "verify-kit (paper) opens the live repo and prints the code" || bad "verify-kit paper failed"

log "== live negative drills (hard stops, no override) ==" | tee -a "$REP"
# (a) unknown signer: a paper kit whose signing key is not the one that signed (typed fingerprint changed consistently)
fp="$(printf 'ab%.0s' $(seq 1 32))"; sed -E "s/^[0-9a-f]{12} \(current\).*/${fp:0:12} (current) — SHA-256 ${fp}/" "$OUT/paper-lines.txt" >"$OUT/paper-wrongsigner.txt"
bash "$CLI" plan --paper-file "$OUT/paper-wrongsigner.txt" "${K[@]}" >"$OUT/neg-signer.txt" 2>&1; r=$?
[ "$r" = 3 ] && grep -q "not in your recovery kit" "$OUT/neg-signer.txt" && ok "unknown signer ⇒ exit 3 (hard stop)" || bad "unknown signer: exit $r"
# (b) rolled-back manifest
bash "$CLI" plan "${KD[@]}" --min-sequence 999 >"$OUT/neg-rollback.txt" 2>&1; r=$?
[ "$r" = 3 ] && grep -q "rolled-back" "$OUT/neg-rollback.txt" && ok "rolled-back recovery point (floor above sequence) ⇒ exit 3" || bad "rollback: exit $r"
# (c) forged manifest: a snapshot with a flipped byte and a HIGHER sequence tag lands in the manifest repo (what an attacker with storage write + the repo password could do)
W="$(mktemp -d "$OUT/forge.XXXX")"; chmod 700 "$W"
python3 -I "$LAB/../../scripts/fork/recover/kit-tool" unwrap --kit "$OUT/kit.pbkit" --passphrase-file "$OUT/passphrase.txt" --out "$W/kit.json" >/dev/null
python3 -I "$LAB/../../scripts/fork/recover/kit-tool" derive --kit-json "$W/kit.json" --info "portabase-fork/manifest/v1/$STACK" --out "$W/pw" >/dev/null
RP_ROOT="rclone:$SR/backups/fork-manifest/$STACK"; rs() { RESTIC_PASSWORD_FILE="$W/pw" RCLONE_CONFIG="$OUT/rclone.conf" RESTIC_CACHE_DIR="$W/cache" restic -r "$RP_ROOT" "$@"; }
snap=$(rs snapshots --json --tag fork-manifest 2>/dev/null | jq -r 'sort_by(.time) | last | .id'); rpid=$(rs snapshots --json 2>/dev/null | jq -r --arg s "$snap" '.[] | select(.id==$s) | .tags[] | select(startswith("rp:")) | .[3:]')
rs restore "$snap" --target "$W/m" >/dev/null 2>&1; mj=$(find "$W/m" -name manifest.json); sed -i 's/"stack_name":"\([^"]*\)"/"stack_name":"\1x"/' "$mj"
( cd "$(dirname "$mj")" && rs backup --host portabase-fork --tag fork-manifest --tag "rp:$rpid" --tag seq:9999 . >/dev/null 2>&1 )
bash "$CLI" plan "${KD[@]}" >"$OUT/neg-forged.txt" 2>&1; r=$?
[ "$r" = 3 ] && grep -q "NOT valid" "$OUT/neg-forged.txt" && ok "forged manifest (byte flipped, newest sequence) ⇒ exit 3: signature NOT valid" || bad "forged manifest: exit $r ($(tail -2 "$OUT/neg-forged.txt" | tr '\n' ' '))"
forged=$(rs snapshots --json 2>/dev/null | jq -r '.[] | select(.tags | index("seq:9999")) | .id'); [ -n "$forged" ] && rs forget "$forged" >/dev/null 2>&1; rm -rf "$W"
bash "$CLI" plan "${KD[@]}" >/dev/null 2>&1 && ok "forged snapshot removed again: plan passes" || bad "plan still failing after removing the forged snapshot"
# (d) wrong checksum: EVERY stored archive object gets one byte altered in MinIO (originals saved and put back afterwards)
mkdir -p "$OUT/orig"; mapfile -t objs < <(rc lsf -R --files-only "$SR/backups" 2>/dev/null | grep -E '\.tar\.gz\.enc$')
if [ "${#objs[@]}" -gt 0 ]; then
  i=0; for o in "${objs[@]}"; do i=$((i+1)); rc copyto "$SR/backups/$o" "$OUT/orig/$i" >/dev/null 2>&1; cp "$OUT/orig/$i" "$OUT/flip"; printf '\x55' | dd of="$OUT/flip" bs=1 seek=60 conv=notrunc 2>/dev/null; rc copyto "$OUT/flip" "$SR/backups/$o" >/dev/null 2>&1; done
  bash "$CLI" plan --deep "${KD[@]}" >"$OUT/neg-sum.txt" 2>&1; r=$?
  [ "$r" = 3 ] && grep -qE "checksum mismatch|failed verification" "$OUT/neg-sum.txt" && ok "altered stored archives (${#objs[@]} objects) ⇒ exit 3 ($(grep -oE 'checksum mismatch|failed verification' "$OUT/neg-sum.txt" | head -1))" || bad "altered archives: exit $r"
  i=0; for o in "${objs[@]}"; do i=$((i+1)); rc copyto "$OUT/orig/$i" "$SR/backups/$o" >/dev/null 2>&1; done; rm -rf "$OUT/orig" "$OUT/flip"
  bash "$CLI" plan --deep "${KD[@]}" >/dev/null 2>&1 && ok "objects restored: plan --deep passes again" || bad "plan --deep fails after restoring the objects"
else bad "no stored archive found to alter"; fi
[ "${DRILL_ONLY:-}" = tamper ] && { log "tamper-only run: fail=$fail" | tee -a "$REP"; exit $fail; }

log "== DISASTER: dashboard DB wiped, agent + Arcane + original stack gone (storage kept) ==" | tee -a "$REP"
t=$(tm)
docker compose --profile sqlite --profile failing-webhook -f "$LAB/demo-stack/compose.yml" -f "$LAB/demo-stack/compose.override.yml" down -v >/dev/null 2>&1
docker ps -a --format '{{.Names}}' | grep -E '^forklab-(agent|portabase-agent|arcane)' | xargs -r docker rm -f >/dev/null 2>&1
DBVOL=$(docker inspect forklab-portabase-db-1 --format '{{range .Mounts}}{{.Name}} {{end}}' 2>/dev/null)
docker rm -f forklab-portabase-dashboard-1 forklab-portabase-db-1 >/dev/null 2>&1
for v in $DBVOL; do docker volume rm -f "$v" >/dev/null 2>&1; done
log "disaster staged in $(el "$t" "$(tm)"); dashboard DB volume(s) removed: ${DBVOL:-none found}" | tee -a "$REP"
docker ps --format '{{.Names}}' | grep -qE 'forklab-(portabase-(dashboard|db)|demo)' && bad "dashboard / demo containers still present" || ok "dashboard, its database and the original stack are gone"
docker volume inspect forklab-demo_appdata >/dev/null 2>&1 && bad "original volume still exists" || ok "original demo volumes removed"

log "== RESTORE (timed): bare script, kit + storage only, second project ($PROJ) ==" | tee -a "$REP"
rm -rf "$ROOT"
t=$(tm); bash "$CLI" restore --yes "${KD[@]}" --root "$ROOT" --project-name "$PROJ" >"$OUT/restore.txt" 2>&1; rrc=$?; T_RESTORE=$(el "$t" "$(tm)")
log "restore --yes: exit=$rrc in $T_RESTORE" | tee -a "$REP"
grep -E "^== |artifact [0-9]+ ok|restored |WARNING|RISK|stack started|STOP|portabase-recover:" "$OUT/restore.txt" | sed 's/^/   /' | tee -a "$REP"
[ "$rrc" = 0 ] && ok "restore --yes exit 0 ($T_RESTORE)" || { bad "restore failed"; tail -15 "$OUT/restore.txt"; }

log "== oracle: diff against expected.json ==" | tee -a "$REP"
WD=$(ls -d "$ROOT"/files"$LAB"/demo-stack 2>/dev/null | head -1)
[ -n "$WD" ] || WD="$ROOT/files$LAB/demo-stack"
up=$(dirsum "$WD/uploads" 2>/dev/null); [ "$up" = "$(exp uploads)" ] && ok "uploads (bind/files) diff=0" || bad "uploads differ ($up)"
cs=$(cd "$WD" && cat compose.yml compose.override.yml stack.env | sha256sum | cut -d' ' -f1); [ "$cs" = "$(exp compose_dir)" ] && ok "compose dir + env + override diff=0" || bad "compose dir differs"
vs=$(docker run --rm -v "${PROJ}_appdata:/vol" "$PGIMG" sh -c 'cd /vol && find . -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d" " -f1' 2>/dev/null); [ "$vs" = "$(exp volume_appdata)" ] && ok "docker volume appdata diff=0" || bad "volume appdata differs ($vs)"
DC=(docker compose -p "$PROJ" --project-directory "$WD" -f "$WD/compose.yml" -f "$WD/compose.override.yml")
ps=$("${DC[@]}" exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select string_agg(id||chr(58)||payload, chr(44) order by id) from items"' 2>/dev/null | sha256sum | cut -d' ' -f1); [ "$ps" = "$(exp postgres_items)" ] && ok "postgres rows (pg_restore) diff=0" || bad "postgres rows differ ($ps)"
if docker volume inspect "${PROJ}_sqlitedata" >/dev/null 2>&1; then
  ss=$(docker run --rm -v "${PROJ}_sqlitedata:/data" --entrypoint sh "$AGENTIMG" -c 'out=$(sqlite3 /data/app.db "select group_concat(id||char(58)||payload, char(44)) from (select * from ledger order by id)") && printf "%s\n" "$out" | sha256sum | cut -d" " -f1' 2>/dev/null)
  [ "$ss" = "$(exp sqlite_ledger)" ] && ok "sqlite ledger (docker-volume) diff=0" || bad "sqlite ledger differs"
else log "NOTE sqlite volume was not part of this recovery point (not claimed)" | tee -a "$REP"; fi
code=$(curl -fsS --max-time 10 http://127.0.0.1:18080/ 2>/dev/null | head -c 200); [ -n "$code" ] && ok "restored web service answers on :18080" || log "NOTE web service not answering yet on :18080" | tee -a "$REP"

log "== summary: restore ${T_RESTORE:-?}; fail=$fail ==" | tee -a "$REP"
"${DC[@]}" down -v --remove-orphans >/dev/null 2>&1
docker volume ls -q | grep "^${PROJ}_" | xargs -r docker volume rm -f >/dev/null 2>&1
chmod -R u+rwX "$ROOT" 2>/dev/null; docker run --rm -v "$OUT:/o" "$PGIMG" rm -rf /o/restore-root >/dev/null 2>&1
exit $fail
