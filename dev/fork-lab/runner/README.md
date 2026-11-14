# Mirror runner lab (W21)

Disposable emulation of the mirror runner VM (docker-in-docker "runner box" + nftables), used to PROVE the egress runbook with the `runner_probe` task.
Everything here is lab evidence, not product state, and does not replace the real-VM check (#125, PENDING-HUMAN). Full design, the real-VM runbook and the residuals: vault `ADR/ADR-008-mirror-runner.md`.

- `nftables.conf`, `runner-dns.{vm,lab}.nft`, `daemon.{vm,lab}.json`: the files the runbook installs (the lab uses the `lab` variants).
- `runner.sh up|agent|status|fw-off|fw-on|down`: unique names `w21-*`; never `docker system prune`; `down` is idempotent and removes only its own containers, networks and volumes.
- Driven by `src/fork/__tests__/e2e/w21-runner-lab.test.ts` (`FORK_LAB=1`, one lab at a time). Never targets `192.168.8.0/24` or any real host.
