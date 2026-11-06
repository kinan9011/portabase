# Fork notes (stack-recovery)

This repository is a fork of Portabase (base v1.35.2). Fork code lives only in fork-only paths
(`src/fork/**`, `drizzle.fork.config.ts`, `scripts/fork/**`, `app/api/fork/**`, `.github/workflows/fork-*.yml`, ...).
Upstream files carry one-line hooks marked `FORK(stack-recovery): Pnn`, each listed in `scripts/fork/patch-registry.txt`.

Plan, ADRs, patch registry, runbooks: the project vault `~/Documents/Kinan-Obs/Developing/Projects/portabase/` (start at `00-Index.md`).

## Everyday commands
```sh
bash scripts/fork/check-patches.sh        # markers <-> registry
pnpm typecheck:fork                       # tsc: zero errors in fork paths, no new errors vs baseline
pnpm test:fork:unit                       # no services
FORK_TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5433/postgres pnpm test:fork:integration
pnpm build && FORK_TEST_DATABASE_URL=... pnpm test:fork:e2e
pnpm drizzle-kit generate --config drizzle.fork.config.ts --name <name>   # then append to src/fork/db/migration-ledger.ts
```

## Flags (all default off; only the literal `true` enables)
`FORK_STACKS_ENABLED`, `FORK_ARCANE_ENABLED`, `FORK_MIRRORS_ENABLED`. Pre-migration dump: `FORK_MIGRATE_DUMP=auto|required|off`.

## Single-tenant requirement (D21, ADR-011) and fork secrets (D23)
The fork refuses to configure itself unless the instance is single-tenant: exactly one organization, `AUTH_SIGNUP_ENABLED=false`, no agent/storage channel used by fork rows bound to another organization.
Set `AUTH_SIGNUP_ENABLED=false` (upstream default is `true`; with it `false` NO new account can be created, not even by an admin) and keep `MCP_ENABLED=false` (advisory).
On failure the fork *locks configuration only* (activated schedules, finalisation, drift job and notifications keep running): `/api/fork/status` carries the banner text; an audit event + one pending notification record are written per state change.

**Fork KEK:** `${PRIVATE_PATH}/keys/fork-kek/` (`<kid>.key` 0600 + `active`), generated on first use, separate from the master key. **Back it up together with the database** — fork secrets (Arcane API keys) are unreadable without it, and a DB dump alone does not contain it.
Audit retention: `FORK_AUDIT_RETENTION_DAYS` (default 400, floor 90).

## Rollback
Fork and upstream migrations are forward-only. Take a dump before every deploy / upstream sync
(`DATABASE_URL=... scripts/fork/predeploy-dump.sh`); rollback = stop the app, drop + recreate the database, `pg_restore --no-owner`.
Every PR on the forks needs `[skip-release]` in its title.

## Syncing upstream
Runbook (vault `03-Upstream-Sync-Runbook`): `git fetch upstream --tags` → branch `sync/upstream-YYYYMMDD` → `scripts/fork/predeploy-dump.sh` → `git merge upstream/main` →
`FORK_TEST_DATABASE_URL=... bash scripts/fork/sync-gate.sh` (check-patches, typecheck:fork, D31 contract tests, unit + migration-lane integration; prints one PASS/FAIL table) →
`pnpm build`, lint vs the ADR-000 baseline, docker image check. A red `upstream-contract.test.ts` means a surface the fork imports/reads moved: adapt the fork in the same sync PR.
