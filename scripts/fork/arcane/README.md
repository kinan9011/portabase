# Arcane discovery key — `create-discovery-key.sh`

Creates the API key the Portabase fork uses to *discover* stacks in Arcane: **list permissions only, scoped to one
environment** (ADR-002 A2). Verified working on Arcane v2.17.3 (the pinned version) against the pilot setup.

## Why a script
- Arcane's UI (Settings → API Keys) cannot scope a grant to **one environment**; its API can:
  `POST /api-keys` with `permissions: [{permission, environmentId?}]` (omit `environmentId` ⇒ global grant).
- A key created from a user's own account (`POST /auth/me/api-keys`) has **no grants of its own** — it inherits the
  user's roles at call time. It works, but the dashboard's permission self-test reads the key's *own* grants
  (`GET /auth/me/api-keys`), sees none, and reports **"Some environments are not fully covered by the key"**
  (`partial`, no environments saved). Roles on the user are irrelevant to that check.
- Any `*:read` permission returns secrets (env values, volume bytes), so the key must never hold one.

## What it grants (mirrors `GLOBAL_MINIMUM` / `ENV_MINIMUM` in `src/fork/arcane/endpoints.ts`)
- global: `environments:list`
- scoped to the chosen environment: `projects:list`, `containers:list`, `volumes:list`, `networks:list`, `images:list`

A unit test (`src/fork/__tests__/unit/arcane-key-script.test.ts`) fails if the script and `endpoints.ts` drift apart.

## Use
1. In Arcane make a **temporary admin API key** (Settings → API Keys, full access). Grants cannot exceed the creator's own.
2. In your own terminal (needs `bash`, `curl`, `jq`):
   ```bash
   bash scripts/fork/arcane/create-discovery-key.sh
   # ARCANE_API=https://arcane.example/api   KEYNAME=...   INSECURE=1 (self-signed https only)
   ```
3. Paste the admin key (hidden), pick the environment id from the list, confirm the printed grants.
4. Copy the new key (shown **once**) → dashboard → Integrations → Arcane → save / **rotate key**.
5. **Delete the temporary admin key** in Arcane.

Expected: connection `healthy`, the chosen environment listed. A different environment needs its own key (re-run).

## Security notes
- No secret is stored in the script; the admin key is read with `read -s`, kept in a shell variable only, never written to
  disk or history, and unset at the end. The new key is printed to the terminal once — do not paste it into chat or tickets.
- Run it on a trusted machine; if Arcane is plain `http`, the admin key crosses your LAN in clear text (prefer https +
  `INSECURE=1` only for a self-signed LAN certificate, never across untrusted networks).
- Rotate the key from the dashboard (SEC-10: it must be typed again); revoke old ones in Arcane.

## Troubleshooting
| Symptom | Cause / fix |
|---|---|
| card says `partial`, no environments | key made from a user account, or missing a permission → recreate with this script; the card's "Missing: …" line names what is absent |
| `key_too_broad` | key has a `*:read`, a global grant of an env-scoped permission, or `projects:read` while tier 2 is off |
| script: "cannot reach Arcane" | wrong `ARCANE_API` (include `/api`), firewall, or self-signed https (`INSECURE=1`) |
| Arcane 403 on create | the admin key lacks a permission it tries to grant |
