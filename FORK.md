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

## Rollback
Fork and upstream migrations are forward-only. Take a dump before every deploy / upstream sync
(`DATABASE_URL=... scripts/fork/predeploy-dump.sh`); rollback = stop the app, drop + recreate the database, `pg_restore --no-owner`.
Every PR on the forks needs `[skip-release]` in its title.
