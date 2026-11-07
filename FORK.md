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
`FORK_STACKS_ENABLED`, `FORK_ARCANE_ENABLED`, `FORK_MIRRORS_ENABLED`. Pre-migration dump: `FORK_MIGRATE_DUMP=auto|required|off`. Arcane URL allow-list: `FORK_ARCANE_NET_ALLOWLIST` (default empty = deny, see below). Discovery interval: `FORK_DISCOVERY_INTERVAL_MINUTES` (default 15, 5–1440, ±20 % jitter, operator-only).

## Single-tenant requirement (D21, ADR-011) and fork secrets (D23)
The fork refuses to configure itself unless the instance is single-tenant: exactly one organization, `AUTH_SIGNUP_ENABLED=false`, no agent/storage channel used by fork rows bound to another organization.
Set `AUTH_SIGNUP_ENABLED=false` (upstream default is `true`; with it `false` NO new account can be created, not even by an admin) and keep `MCP_ENABLED=false` (advisory).
On failure the fork *locks configuration only* (activated schedules, finalisation, drift job and notifications keep running): `/api/fork/status` carries the banner text; an audit event + one pending notification record are written per state change.

**Fork KEK:** `${PRIVATE_PATH}/keys/fork-kek/` (`<kid>.key` 0600 + `active`), generated on first use, separate from the master key. **Back it up together with the database** — fork secrets (Arcane API keys) are unreadable without it, and a DB dump alone does not contain it.
Audit retention: `FORK_AUDIT_RETENTION_DAYS` (default 400, floor 90).

## Arcane connection (W05)
Read-only discovery source. Code: `src/fork/arcane/` (client, schemas, key policy, connection service), `src/fork/discovery/provider.ts` (`DiscoveryProvider`, 8 methods), `src/fork/net/` (SSRF guard, IP-pinned GET transport, rate limiter), `src/fork/actions/arcane-connection.action.ts` (server actions: save / test / rotate key / disconnect). Design + threat mapping: vault `ADR/ADR-012-arcane-connection-ssrf`, `ADR/ADR-002-arcane-compat`.

- **Key = list permissions only, environment-scoped** (`environments:list` global; `projects|containers|volumes|networks|images:list` per environment). Any `*:read`, any write class or a global grant of an env-scoped permission is refused with the exact names; `projects:read` is an opt-in per connection (tier 2). Arcane's `*:read` returns env values / volume bytes / env-file bytes.
- **URL guard, default deny.** `https://` anywhere that resolves to public addresses. Loopback / private / link-local / ULA need the operator allow-list `FORK_ARCANE_NET_ALLOWLIST` (comma list of IPs, CIDRs, host names; empty = deny; env-only, never settable from the UI). `http://` only for allow-listed private addresses (lab: `FORK_ARCANE_NET_ALLOWLIST=127.0.0.1`). Cloud metadata addresses (169.254.169.254 …) are never allowed. The host is resolved once, every answer must pass, and the request connects to that vetted address (DNS-rebinding defence). Redirects are never followed. TLS verification is on; the per-connection opt-out is audited.
- **Changing host, port or scheme of the URL requires typing the key again** (SEC-10): a stored key is never sent to another endpoint.
- Connection actions are system-admin only, refused while the single-tenant self-check fails, rate limited (6/min per user), audited (`fork.arcane.connection.{save,test,rotate_key,disconnect}`), and never return, log or audit the key.
- Tests: `pnpm test:fork` (fake Arcane over real HTTP + Postgres). Live lab test: `cd dev/fork-lab && docker compose --env-file .env.lab -f compose.arcane.yml up -d arcane` (+ demo stack), then `FORK_LAB=1 pnpm test:fork arcane-live` (lab admin login only mints/deletes scoped keys).

## Integrations page (W06)
`/dashboard/integrations` (instance-level, under `(admin)`, D35). System administrator only (`arcane.manage`; the host role also needs `host_role.manage`, same rule). Hidden (real 404) while the fork is `off`; rendered with every action `aria-disabled` + the visible reason "Fork configuration locked: …" while `locked`. A signed-in user who is not a system administrator and reaches the page gets a plain explanation and no data (upstream's `(admin)` layout and the P04 gate answer 404 first, so in practice non-admins see a 404).
Code: page `app/(customer)/dashboard/(admin)/integrations/page.tsx` (server: authorises, loads the key-free read model) → `src/fork/ui/integrations/*` (client view, connection card/form, environment table), `src/fork/ui/{labels,tone}.ts` (all state copy + the one AA tone map), `src/fork/ui/{dangerous-action-confirm,disabled-reason,status-announcer,tone-badge}.tsx`; read model `src/fork/arcane/integrations-view.ts`; environment settings (enable, agent mapping, host role) `src/fork/arcane/environment-service.ts` + `src/fork/actions/arcane-environment.action.ts` (audited `fork.arcane.environment.update`, D21 gate, SEC-12 resource scoping, agent must be unbound or in the single organization).
- **9 connection states** (Not configured, Testing…, Connected, Syncing…, Partial sync, Invalid credentials, Insufficient permission, Unreachable, Incompatible API) derived from `health_status` + `last_error_class` (`ui/integrations/connection-state.ts`); each problem state has per-error-class copy in `labels.ts`. "Syncing…" comes only from a real sync (a pending "Sync now" in this tab, or the server-side sync lease held by the cron / another tab / another replica); the page never invents it.
- **The Arcane key never reaches the browser:** the read model has no key field (strict schema), the input is uncontrolled (value read once at submit and cleared, success or failure), it is not a `useMutation` variable (React Query keeps variables), forms post (never GET), and `ARCANE_KEY_INPUT_PROPS` from W05 is spread, not copied. Tests: `w06-integrations-ui`, `w06-ui-static`, `w06-environment-view`.
- "Sync now" is wired in W07 (see below). The prototype's discovery-interval select is not shown: the interval is the operator setting `FORK_DISCOVERY_INTERVAL_MINUTES`.
- Lab run: build (`pnpm build`) and start with `FORK_ARCANE_ENABLED=true AUTH_SIGNUP_ENABLED=false FORK_ARCANE_NET_ALLOWLIST=127.0.0.1` against a throw-away Postgres and the lab Arcane; exactly one organization must exist at boot (the first boot with the default admin creates it — restart once, or the self-check keeps the fork `off`).

## Discovery sync (W07)
Reads the inventory of every **enabled** Arcane environment into versioned, provenance-tagged `StackInventory` rows (`fork_stack` + `fork_stack_inventory`). Read-only against Arcane (GET only, the W05 client), **no secret value is ever stored**: the client drops env values at the boundary, the normaliser builds the inventory field by field from an allow-list (compose labels + the three D18 hint keys only; no command lines, no raw labels, no file contents), and the strict schema rejects anything else. Design: vault `ADR/ADR-004-stack-recoverypoint-model` §10, `Waves/W07-discovery-sync`.
Code: `src/fork/inventory/{normalize,labels,compose-yaml,schema}.ts` (pure normaliser, hint grammar, SEC-17 YAML limits, schema v1), `src/fork/discovery/{sync,sync-state,sync-summary}.ts` (orchestrator, lease/breaker/reconcile/write path), `src/fork/cron.ts` (cron on the runtime **config** plane — no upstream hook), `src/fork/actions/sync.action.ts` ("Sync now").
- **Trigger:** cron tick every 60 s, due when `now − last_sync_attempt_at ≥ interval × (0.8…1.2)` (persisted ⇒ a missed run is one catch-up, never a backlog); "Sync now" (system admin, `arcane.manage` resource-scoped, D21 gate, 6/min, audited). Mode machine (ADR-010): the cron is started only in mode `on` and every tick re-checks it — `locked`/`off` ⇒ no discovery (activated schedules in the runtime plane are unaffected).
- **ARCH-10:** one DB lease per connection (`fork_lock` `sync:<id>`, TTL 5 min, renewed per environment, stolen only after expiry) ⇒ overlap = skip (no queue), replicas safe. Circuit breaker (persisted): 5 consecutive connection-level failures open it, back-off 5 min × 2^(n−5) capped at 60 min; the cron skips while open, the first attempt after the back-off is the half-open probe, "Sync now" is always allowed and a success closes it. Opening records one pending notification (`discovery.circuit_open`, delivery W13).
- **Per run:** preflight (version pin, key permission self-test — a key that gained any `*:read` is refused —, environment list) → reconcile environments (newly covered ⇒ row `enabled=false`; no longer covered ⇒ marked, its stacks `stale_since`, cache kept) → per enabled environment (60 s budget): containers, volumes, networks, images, projects → normaliser → ONE transaction (stack upsert, new inventory version **only when the content hash changed**, `stale_since` cleared, unseen stacks `absent`, keep the newest 30 versions + any referenced by a recovery point). Failure ⇒ cached inventory kept and marked stale; the environment shows the code-only reason.
- **Untrusted input (SEC-22):** labels give hints (enum/boolean grammar, invalid values ignored), never identity or authority; paths must be absolute, no `..`, no control characters; a project label that is not a valid identity rejects that stack only; limits (500 services, 2000 mounts, 1 MiB) reject, never truncate. **Tier 2** (opt-in `projects:read`): compose text is parsed under SEC-17 limits (256 KiB, depth 24, 20 000 nodes, ≤ 10 aliases, no custom tags, no duplicate keys) and reduced to service names, env **key names**, env_file paths, profiles; a refused file leaves `compose_read: "none"` + a warning.
- `stop` / `exclude` / `consistency` hints are recorded as data; **R1 never stops containers** (D29).
- Tests: `pnpm test:fork normalize` (+ `w07-*`: normaliser fixtures, SEC-17, sync/ARCH-10/breaker, all-table canary, contract vs the pinned Arcane spec, static guards). Live lab test (demo stack must be discovered): `cd dev/fork-lab && docker compose --env-file .env.lab -f compose.arcane.yml up -d arcane && docker compose -f demo-stack/compose.yml -f demo-stack/compose.override.yml up -d db web` (NOT `seed.sh`: it rewrites tracked `uploads/`), then `FORK_LAB=1 FORK_TEST_DATABASE_URL=… pnpm test:fork discovery-live`.
- Not in W07: coverage/completeness (W09), reading file contents (W09/W10), keeping environment settings across disconnect/reconnect (follow-up), per-connection interval setting in the UI.

## Rollback
Fork and upstream migrations are forward-only. Take a dump before every deploy / upstream sync
(`DATABASE_URL=... scripts/fork/predeploy-dump.sh`); rollback = stop the app, drop + recreate the database, `pg_restore --no-owner`.
Every PR on the forks needs `[skip-release]` in its title.

## Syncing upstream
Runbook (vault `03-Upstream-Sync-Runbook`): `git fetch upstream --tags` → branch `sync/upstream-YYYYMMDD` → `scripts/fork/predeploy-dump.sh` → `git merge upstream/main` →
`FORK_TEST_DATABASE_URL=... bash scripts/fork/sync-gate.sh` (check-patches, typecheck:fork, D31 contract tests, unit + migration-lane integration; prints one PASS/FAIL table) →
`pnpm build`, lint vs the ADR-000 baseline, docker image check. A red `upstream-contract.test.ts` means a surface the fork imports/reads moved: adapt the fork in the same sync PR.
