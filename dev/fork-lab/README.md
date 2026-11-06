# Fork lab (W02)

Disposable lab for the Stack Recovery fork: **Arcane** manager, the **Portabase dashboard + agent** (upstream 1.35.2 / 1.25.2 images, pinned by digest), **MinIO** as the storage channel, a synthetic **demo Compose stack**, and the **F4** compromise-resilient copy reference.

> **Lab only.** Localhost only (every published port is `127.0.0.1`), synthetic data only, no production credentials, ever. The agent and Arcane mount the Docker socket on purpose (Docker-admin equivalent — see `05-Security-Model` / ADR-001).

```
./lab.sh up        # generates .env.lab (git-ignored), starts everything, enrolls the agent, registers the sources  (~15 s warm, images ≈ 4 GB cold)
bash drills/smoke.sh
./lab.sh down      # stop, keep volumes          ./lab.sh reset   # delete lab volumes/networks (forklab-* only)
```

| URL | What |
|---|---|
| `http://forklab-dashboard.localhost:18887` | Portabase dashboard (Chrome/Firefox resolve `*.localhost` to loopback; containers reach the same name through the `edge` proxy alias) |
| `http://127.0.0.1:13552` | Arcane manager (set the admin account on first visit) |
| `http://127.0.0.1:19001` | MinIO console · S3 `127.0.0.1:19000` |
| `http://127.0.0.1:18080` | demo stack web service (DB rows, uploads count, volume count) |

Admin login for the dashboard: `LAB_ADMIN_EMAIL` / `LAB_ADMIN_PASSWORD` in `.env.lab` (generated, never committed).

## Layout
| Path | Purpose |
|---|---|
| `compose.portabase.yml` | dashboard + postgres + MinIO + `edge` alias proxy |
| `compose.arcane.yml` | Arcane manager (+ optional agent, profile `arcane-agent`, needs a token minted in the Arcane UI) |
| `portabase-agent/` | agent compose + one override file per decision variant (`attach-demo-net`, `host-bind`, `volume-mount`, …) |
| `demo-stack/` | the stack under protection: `compose.yml`, `compose.override.yml`, `stack.env`, `uploads/` (bind), named volumes `appdata`/`sqlitedata`, `seed.sh`, `expected.json` (checksum oracle) |
| `f4/` | home-side rclone pull copy (read-only identity) |
| `drills/` | `smoke.sh`, `matrix.sh`, `restore-diff.sh`, `trigger-probe.sh`, `sqlite-consistency.sh`, `arch11-q2.sh`, `poll-blast.sh`, `f4-gate.sh`; helpers `lib.sh`, `minio-init.sh`, `bootstrap-dashboard.sh`, `provision-sources.sh` |

`demo-stack/seed.sh --verify` is the determinism check; after editing the demo compose files run `seed.sh --write-expected` (the compose checksum is part of the oracle). `src/fork/__tests__/unit/lab-static.test.ts` guards the static rules (127.0.0.1 only, digests pinned, no secrets, `.env.lab` ignored).

## Known gaps (see ADR-001)
- The dashboard has no create-source API; `drills/bootstrap-dashboard.sh` writes the same rows the UI actions write (the first lab was onboarded through the real UI once).
- The demo stack env file is `stack.env` (not `.env`).
- Arcane's own agent environment is not started by default (token comes from the Arcane UI); Arcane API pinning is W03.
