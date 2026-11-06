# Arcane API spike (W03)

Disposable lab only: the lab Arcane manager on `127.0.0.1:13552`, synthetic demo stack, no real credentials.
Findings, capability table and decisions: ADR-002 in the project vault (`ADR/ADR-002-arcane-compat.md`).

| File | What |
|---|---|
| `openapi.v<ver>.json` + `.sha256` | spec exactly as served by `/api/openapi.json` (key-sorted, compact). Bump = rerun `spike.sh`, then `scripts/fork/arcane-openapi-diff.sh <old> <new>` |
| `capability-map.json` | capability → method, path, exact permission, tier (1 minimum / 2 opt-in / never / unused), pagination, response schema, proof. Checked against the spec by `src/fork/__tests__/unit/arcane-spike.test.ts` |
| `permission-catalogue.json` | every permission the server recognises (from `/roles/available-permissions`) |
| `permission-matrix.json` | per single permission: which GET endpoints answer 200 (observed) |
| `spike-results.json` | capability runs, exposure probes (booleans only), 401/403/429 probes |
| `fixtures/` | scrubbed payloads of `forklab-*` resources only. Seed for W05's `src/fork/arcane/__fixtures__/` |

## Run
```
cd dev/fork-lab && ./lab.sh up          # Arcane + demo stack (demo-stack is mounted under /app/data/projects)
bash arcane/remote-env.sh               # optional: pair a remote Arcane environment (lab admin writes, token never on disk)
bash arcane/spike.sh                    # ~40 s; rewrites this directory (remote_environment = unverified without the line above)
```
Needs bash, curl, jq. Arcane rate-limits `/auth/login` (429 + `Retry-After: 60` after ~5 attempts per minute, successes
count): the script waits once; do not run it twice within a minute.

## Rules the script enforces
- loopback `ARCANE_URL` only (exit 2 otherwise, no bypass);
- the LAB admin session is used only to mint/delete scoped API keys and read the permission catalogue (`admin_call`);
  every capability call is `api_get` = `GET` with `X-API-Key` of a scoped key;
- the only non-GET request is one deliberate negative probe (POST with the read-only key must be 403);
- exposure probes record booleans/status only, never the lab secret value; fixtures are filtered to `forklab-*`
  resources and scrubbed (paths, IPs, MACs, long ids, `$schema`, service environment); the unit test re-checks;
- every key it creates is deleted on exit.
