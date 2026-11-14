#!/usr/bin/env bash
# W25 failure-injection drill (lab only, docker-in-docker runner emulation; real-VM proof PENDING-HUMAN #125). Exit code = verdict.
# Name = scenario: refresh-<bad-dump|concurrent|disk|isolation|all>.sh (identical scripts, the file name selects W25_DRILL). Never touches a real host; objects named w24-* only; no `docker system prune`.
set -uo pipefail
NAME="${0##*/refresh-}"; NAME="${NAME%.sh}"            # bad-dump|concurrent|disk|isolation|all
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
: "${FORK_TEST_DATABASE_URL:?FORK_TEST_DATABASE_URL required (throwaway Postgres 17)}"
[ -f "$ROOT/.next/BUILD_ID" ] || { echo "DRILL $NAME FAIL: run pnpm build first" >&2; exit 2; }
for i in "${W25_AGENT_IMAGE:-portabase-agent-fork:w24-lab}" pbr-w24-runner:lab; do docker image inspect "$i" >/dev/null 2>&1 || { echo "DRILL $NAME FAIL: image $i missing" >&2; exit 2; }; done
EV="${LAB_EVIDENCE_DIR:?LAB_EVIDENCE_DIR required (outside the repo, e.g. the vault evidence-W25 dir)}"
cd "$ROOT" && FORK_LAB=1 W25_DRILL="$NAME" LAB_EVIDENCE_DIR="$EV" pnpm test:fork:e2e w25-refresh-drills-lab; rc=$?
[ "$rc" -eq 0 ] && echo "DRILL $NAME PASS (evidence $EV)" || echo "DRILL $NAME FAIL rc=$rc (evidence $EV)"
exit "$rc"
