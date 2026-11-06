#!/usr/bin/env bash
# Upstream-sync compat gate (W-SYNC#1; runbook: "Compat gate"). Runs the automatable items, prints one PASS/FAIL table.
# Not covered here (manual / other tools): pnpm build + lint vs ADR-000 baseline, docker image check, lab drill, agent repo, release notes.
#   FORK_TEST_DATABASE_URL=postgres://postgres:pw@localhost:5432/postgres [FORK_PG_DUMP_BIN=...] bash scripts/fork/sync-gate.sh
# Without FORK_TEST_DATABASE_URL the DB tiers are reported as FAIL (never skipped silently).
set -uo pipefail
cd "$(dirname "$0")/../.."
fail=0; rows=()
LOGDIR="$(mktemp -d)"
run() { # name, command...
  local name="$1"; shift; local log="$LOGDIR/$((${#rows[@]})).log"
  if "$@" >"$log" 2>&1; then rows+=("PASS  $name"); else rows+=("FAIL  $name  (log: $log)"); fail=1; fi
}
run "check-patches (markers <-> registry)"             bash scripts/fork/check-patches.sh
run "typecheck:fork (tsc <= baseline)"                 pnpm typecheck:fork
run "contract tests (D31 upstream surfaces)"           pnpm vitest run --project unit src/fork/__tests__/unit/upstream-contract.test.ts
run "unit tier (incl. ledger test)"                    pnpm test:fork:unit
run "integration tier (migration lane vs REAL upstream journal)" pnpm test:fork:integration
printf '%s\n' "${rows[@]}"
[ "$fail" -eq 0 ] && echo "sync-gate: ALL PASS" || echo "sync-gate: FAILED"
exit "$fail"
