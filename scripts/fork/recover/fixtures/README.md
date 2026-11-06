# decrypt-archive fixtures (W02b)

Real output of the **stock** Portabase agent 1.25.2 (image digest in `fixtures.json`) with `setting.encryption = true`, taken
from the fork lab (`dev/fork-lab`). Synthetic data only (the lab's seeded demo database and demo volume).

| File | What it is |
|---|---|
| `lab-postgres.tar.gz.enc` | `demo-postgres` (PostgreSQL) backup: tar.gz holding one `pg_dump -Fc` custom-format `.dump`, then the agent's chunked AES-256-GCM encryption |
| `lab-volume.tar.gz.enc` | `demo-appdata-volume` (docker-volume) backup: tar.gz of the volume contents under `vol/`, same encryption |
| `fixtures.json` | expected plaintext SHA-256 + size, ciphertext SHA-256 + size, provenance, and the lab master key |

**TEST-ONLY KEY.** `master_key_b64` is the random 32-byte master key of one disposable lab, committed on purpose so CI can
decrypt the fixtures. It protects nothing (the lab was reset after generation). Never reuse it and never put a real key here.

Decrypt by hand (key file = base64 master key; the key is never accepted on the command line):

    jq -r .master_key_b64 fixtures.json > /tmp/test-key.txt
    ../decrypt-archive --key-file /tmp/test-key.txt lab-volume.tar.gz.enc /tmp/lab-volume.tar.gz && gzip -t /tmp/lab-volume.tar.gz

Regenerate (new key, new objects; update the tests' expectations only through `fixtures.json`):

    cd dev/fork-lab && ./lab.sh up && bash drills/archive-roundtrip.sh --write-fixtures && ./lab.sh reset

Tests: `src/fork/__tests__/unit/decrypt-archive.test.ts`. W14b (`portabase-recover`) reuses these as CLI CI fixtures; the
truncated `.tar.gz.enc` fixture is W14b's (the tests here truncate in memory).
