#!/usr/bin/env bash
# `tsc` job for the fork (W01, ARCH-18). Upstream has no typecheck gate and its base is NOT type-clean
# (baseline: see scripts/fork/tsc-baseline-count, measured on fork-base v1.35.2). Rules:
#   1. zero errors in fork-owned paths;
#   2. total error count must not exceed the baseline (ratchet: lower the baseline file when upstream fixes some).
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
BASE="$(tr -d '[:space:]' < scripts/fork/tsc-baseline-count)"
OUT="$(mktemp)"; trap 'rm -f "$OUT"' EXIT
npx tsc --noEmit -p tsconfig.json 2>&1 | grep 'error TS' > "$OUT" || true
TOTAL="$(wc -l < "$OUT" | tr -d ' ')"
FORK_ERRS="$(grep -E '^(src/fork/|scripts/fork/|app/api/fork/|app/\(customer\)/dashboard/\(admin\)/integrations/|vitest\.config\.ts|drizzle\.fork\.config\.ts)' "$OUT" || true)"
echo "tsc: $TOTAL errors (baseline $BASE)"
if [ -n "$FORK_ERRS" ]; then echo "tsc: errors in fork-owned paths:" >&2; echo "$FORK_ERRS" >&2; exit 1; fi
if [ "$TOTAL" -gt "$BASE" ]; then echo "tsc: $((TOTAL - BASE)) new error(s) vs baseline" >&2; cat "$OUT" >&2; exit 1; fi
[ "$TOTAL" -lt "$BASE" ] && echo "tsc: below baseline — lower scripts/fork/tsc-baseline-count to $TOTAL"
echo "tsc: OK"
