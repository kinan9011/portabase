#!/usr/bin/env python3
"""Fixture builder for the portabase-recover shell tests (W14b). TEST TOOLING ONLY: every key is generated per run (labelled TEST-ONLY), nothing real.

Builds, under OUTDIR: a local 'storage' (rclone `local` remote) holding a REAL restic manifest repository (signed manifest + detached RSA signature
written exactly like the dashboard does), archive objects in the agent's `.tar.gz.enc` format, one real restic artifact repository, the digital kit
(PBKIT1) + passphrase file, the retyped paper lines, and `info.json` (ids). `--case` selects a mutation (forged signature, tampered archive, poisoned
compose, injection in names ...). Uses openssl + restic + python3-cryptography, like the tool under test. Independent encoder: written from the format
description, not from the decryptor.
"""
import argparse, base64, gzip, hashlib, hmac, io, json, os, secrets, subprocess, sys, tarfile, uuid
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

COMPOSE_OK = """name: pbrtest
services:
  app:
    image: busybox:latest
    command: ["sleep", "3600"]
    env_file: stack.env
    volumes:
      - ./data:/data
      - appdata:/appdata
volumes:
  appdata:
"""
POISON = {
    "privileged": ("app", "    privileged: true\n"),
    "host-net": ("app", "    network_mode: host\n"),
    "pid-host": ("app", "    pid: host\n"),
    "ipc-host": ("app", "    ipc: host\n"),
    "devices": ("app", "    devices: ['/dev/fuse:/dev/fuse']\n"),
    "cap-add": ("app", "    cap_add: [SYS_ADMIN]\n"),
    "docker-sock": ("app", "    volumes: ['/var/run/docker.sock:/var/run/docker.sock']\n"),
    "bind-outside": ("app", "    volumes: ['/etc:/hostetc:ro']\n"),
    "env-file-outside": ("app", "    env_file: ['../../../../../../../../../../outside.env']\n"),
    "env-file-var": ("app", "    env_file: ['${HOME}/secrets.env']\n"),
    "dup-key": ("app", "    env_file: ['../../../../../../../../../../outside.env']\n"),
    "unknown-key": ("app", "    security_opt: ['seccomp=unconfined']\n"),
    "api-socket": ("app", "    use_api_socket: true\n"),
    "label-file-outside": ("app", "    label_file: ['../../../../../../../../../../outside.labels']\n"),
    "extends-outside": ("app", "    extends: {file: '../../../../../../../../../../other.yml', service: base}\n"),
}
SPECIAL = {"include-outside", "secret-file-outside", "allow-override-ok", "vol-driver-bind", "net-host-external", "include-inside-env-outside"}


def sh(args, **kw):
    r = subprocess.run(args, capture_output=True, **kw)
    if r.returncode != 0:
        sys.stderr.write(f"mkstore: {args[0]} failed: {r.stderr.decode()[:400]}\n")
        raise SystemExit(1)
    return r.stdout


def canon(o):
    return json.dumps(o, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def hkdf(master, info):
    prk = hmac.new(b"\0" * 32, master, hashlib.sha256).digest()
    return hmac.new(prk, info.encode() + b"\x01", hashlib.sha256).digest()


def enc_archive(master, plain, chunk=1 << 20):
    nonce = secrets.token_bytes(8)
    out = [json.dumps({"version": 1, "cipher": "AES-256-GCM", "chunk_size": chunk, "base_nonce": list(nonce)}).encode() + b"\n"]
    for n, i in enumerate(range(0, len(plain), chunk)):
        ct = AESGCM(master).encrypt(nonce + n.to_bytes(4, "big"), plain[i:i + chunk], None)
        out += [len(ct).to_bytes(4, "big"), ct]
    return b"".join(out)


def tgz(members):
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as t:
        for name, data in members:
            ti = tarfile.TarInfo(name)
            ti.size, ti.mode = len(data), 0o644
            t.addfile(ti, io.BytesIO(data))
    return gzip.compress(raw.getvalue(), 6, mtime=0)


def spki_hex(pem_path):
    return hashlib.sha256(sh(["openssl", "pkey", "-pubin", "-in", pem_path, "-outform", "DER"])).hexdigest()


def b32(raw):
    return base64.b32encode(raw).decode().rstrip("=")


def paper_lines(master, kek, kid, spki):
    def lines(label, key):
        chars = b32(key)
        res = []
        for n, i in enumerate(range(0, len(chars), 16), 1):
            part = chars[i:i + 16]
            chk = b32(hashlib.sha256(f"pbkit1|{label}|{n}|{part}".encode()).digest())[:2]
            res.append(f"{label} {n}:  {' '.join(part[j:j + 4] for j in range(0, len(part), 4))}  ·  {chk}")
        return res
    return "\n".join(lines("MASTER", master) + lines(f"KEK-{kid}", kek) + [f"{spki[:12]} (current) — SHA-256 {' '.join(spki[j:j + 4] for j in range(0, 64, 4))}"]) + "\n"


def real_pg(fmt):
    """REAL pg_dump output of a seeded postgres:17-alpine (Fc: one file; Fd: the directory as the agent tars it) + the row oracle hash."""
    nm = "pbr-dumpsrc-" + secrets.token_hex(3)
    sh(["docker", "run", "-d", "--rm", "--name", nm, "-e", "POSTGRES_USER=app", "-e", "POSTGRES_PASSWORD=x", "-e", "POSTGRES_DB=app", "postgres:17-alpine"])
    try:
        for _ in range(60):
            if subprocess.run(["docker", "exec", nm, "pg_isready", "-U", "app", "-d", "app"], capture_output=True).returncode == 0 and subprocess.run(["docker", "exec", nm, "psql", "-U", "app", "-d", "app", "-Atc", "select 1"], capture_output=True).returncode == 0:
                break
            subprocess.run(["sleep", "1"])
        sh(["docker", "exec", nm, "psql", "-U", "app", "-d", "app", "-v", "ON_ERROR_STOP=1", "-qc", "create table items(id int primary key, payload text); insert into items select i, md5(i::text) from generate_series(1,500) i"])
        rows = sh(["docker", "exec", nm, "psql", "-U", "app", "-d", "app", "-Atc", "select string_agg(id||chr(58)||payload, chr(44) order by id) from items"])
        if fmt == "fc":
            data = sh(["docker", "exec", nm, "pg_dump", "-U", "app", "-Fc", "app"])
        else:
            data = sh(["docker", "exec", nm, "sh", "-c", "rm -rf /tmp/d && pg_dump -U app -Fd -f /tmp/d app && tar -C /tmp/d -czf - ."])
        return data, hashlib.sha256(rows).hexdigest()
    finally:
        subprocess.run(["docker", "rm", "-f", nm], capture_output=True)


COMPOSE_PG = """name: pbrtest
services:
  db:
    image: postgres:17-alpine
    env_file: stack.env
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("outdir")
    ap.add_argument("--case", default="ok")
    a = ap.parse_args()
    case, out = a.case, os.path.abspath(a.outdir)
    os.makedirs(out, mode=0o700)
    store = os.path.join(out, "storage"); folder = os.path.join(store, "backups")
    os.makedirs(folder)
    master, kek = secrets.token_bytes(32), secrets.token_bytes(32)
    kekid = "k" + hashlib.sha256(kek).hexdigest()[:12]
    stack, rp, gid = str(uuid.uuid4()), str(uuid.uuid4()), "gen" + secrets.token_hex(6)
    # --- signing keys (TEST-ONLY)
    key, other = os.path.join(out, "sign.pem"), os.path.join(out, "other.pem")
    for k in (key, other):
        sh(["openssl", "genrsa", "-out", k, "2048"])
        sh(["openssl", "rsa", "-in", k, "-pubout", "-out", k + ".pub"])
    pub = key + ".pub"; spki = spki_hex(pub); kid = spki[:12]
    signer = other if case in ("forged-sig", "unknown-kid") else key
    mkid = spki_hex(other + ".pub")[:12] if case == "unknown-kid" else kid
    # --- plaintexts
    compose = COMPOSE_OK
    if case in POISON:
        svc, extra = POISON[case]
        compose = COMPOSE_OK.replace("    command: [\"sleep\", \"3600\"]\n", "    command: [\"sleep\", \"3600\"]\n" + extra) if "volumes" not in extra else COMPOSE_OK.replace("    volumes:\n      - ./data:/data\n      - appdata:/appdata\n", extra)
        if case in ("extends-outside", "env-file-outside", "env-file-var"):
            compose = compose.replace("    env_file: stack.env\n", "")
    extra_files = []
    if case == "vol-driver-bind":  # a NAMED volume that is really a bind of /etc (the bind-mount rule alone does not see it)
        compose = COMPOSE_OK.replace("volumes:\n  appdata:\n", "volumes:\n  appdata:\n    driver: local\n    driver_opts: {type: none, o: bind, device: /etc}\n")
    if case == "net-host-external":  # an external network literally named `host` = host networking
        compose = COMPOSE_OK.replace("    command:", "    networks: [h]\n    command:").replace("volumes:\n  appdata:\n", "volumes:\n  appdata:\nnetworks:\n  h:\n    external: true\n    name: host\n")
    if case == "include-inside-env-outside":  # the include target is INSIDE the root, the poison is one level down
        compose = "include:\n  - ./sub.yml\n" + COMPOSE_OK
        extra_files = [("sub.yml", b"services:\n  extra:\n    image: busybox:latest\n    env_file: ['../../../../../../../../../../outside.env']\n")]
    if case == "include-outside":
        compose = "include:\n  - ../../../../../../../../../../elsewhere.yml\n" + COMPOSE_OK
    if case == "secret-file-outside":
        compose = COMPOSE_OK + "secrets:\n  s:\n    file: /etc/shadow\n"
    if case == "abs-bind":
        compose = COMPOSE_OK.replace("      - ./data:/data\n", '      - "/srv/pbr app/data:/data"\n')
    if case == "allow-override-ok":
        compose = COMPOSE_OK.replace("    command:", "    privileged: true\n    command:")
    stack_env = b"A=1\n"
    if case.startswith("pg-real-"):
        compose, stack_env = COMPOSE_PG, b"POSTGRES_USER=app\nPOSTGRES_PASSWORD=x\nPOSTGRES_DB=app\n"
    compose_tgz = tgz([("compose.yml", compose.encode()), ("stack.env", stack_env)] + extra_files)
    data_files = [("hello.txt", b"hello from the bind path\n"), ("dir/more.txt", b"more\n")]
    vol_tgz = tgz([("vol/file-1.txt", b"volume data one\n"), ("vol/sub/file-2.txt", b"two\n")])
    dump = b"PGDMP\x01\x0e\x00" + secrets.token_bytes(300)
    pg_tgz, pg_format, rows_sha = tgz([(f"{uuid.uuid4()}.dump", dump)]), "pg_custom", None
    if case == "pg-real-fc":
        real, rows_sha = real_pg("fc"); pg_tgz = tgz([(f"{uuid.uuid4()}.dump", real)])
    if case == "pg-real-fd":
        real, rows_sha = real_pg("fd"); pg_tgz, pg_format = tgz([(f"{gid}.tar.gz", real)]), "pg_directory"
    db_engine = "postgresql"
    if case == "sqlite-engine":  # upstream `sqlite` engine archive: the database file at the tar root; the manifest records no original path
        import sqlite3, tempfile
        tf = os.path.join(tempfile.mkdtemp(), "app.db"); c = sqlite3.connect(tf); c.execute("create table ledger(id integer primary key, payload text)"); c.executemany("insert into ledger values(?,?)", [(i, hashlib.md5(str(i).encode()).hexdigest()) for i in range(200)]); c.commit(); c.close()
        dbb = open(tf, "rb").read(); rows_sha = hashlib.sha256(dbb).hexdigest()
        pg_tgz, pg_format, db_engine = tgz([("app.db", dbb)]), None, "sqlite"
    if case == "fd-poison":  # inner -Fd archive with a traversal member (hostile archive inside a valid outer one)
        pg_tgz, pg_format = tgz([(f"{gid}.tar.gz", tgz([("../evil", b"x")]))]), "pg_directory"
    label = "/srv/pbr app"
    names = {"compose": f"compose: {label}", "bind": f"bind: {label}/data", "volume": "volume: pbrtest_appdata", "db": "db: db"}
    if case == "sqlite-engine": names["db"] = "db: ledger"
    if case == "manual-role": names["compose"] = f"manual: {label}"
    if case == "inject-dollar": names["bind"] = "bind: /srv/$(touch " + os.path.join(out, "CANARY") + ")"
    if case == "inject-backtick": names["bind"] = "bind: /srv/`touch " + os.path.join(out, "CANARY") + "`"
    if case == "inject-semicolon": names["bind"] = "bind: /srv/x; touch " + os.path.join(out, "CANARY")
    if case == "inject-newline": names["bind"] = "bind: /srv/x\ntouch " + os.path.join(out, "CANARY")
    if case == "inject-dotdot": names["bind"] = "bind: /srv/../../etc"
    if case == "inject-svc": names["db"] = "db: db$(touch " + os.path.join(out, "CANARY") + ")"
    arts, objs = [], {}
    def add_archive(role, plain_tgz, engine, location, dump_format=None, tamper=None):
        enc = enc_archive(master, plain_tgz)
        sha_enc = hashlib.sha256(enc).hexdigest()  # manifest records the PRISTINE object ...
        if tamper == "flip": enc = enc[:-20] + bytes([enc[-20] ^ 1]) + enc[-19:]  # ... a swapped object then fails the ciphertext checksum
        if tamper == "flip-consistent":  # attacker/bug that also fixed the recorded ciphertext hash: the GCM tag must catch it
            enc = enc[:-20] + bytes([enc[-20] ^ 1]) + enc[-19:]; sha_enc = hashlib.sha256(enc).hexdigest()
        pt_sha, pt_size = hashlib.sha256(plain_tgz).hexdigest(), len(plain_tgz)
        if tamper == "truncate-consistent": enc = enc_archive(master, plain_tgz, 64); cut = enc.index(b"\n") + 1; [cut := cut + 4 + int.from_bytes(enc[cut:cut + 4], "big") for _ in range(2)]; enc = enc[:cut]; sha_enc = hashlib.sha256(enc).hexdigest()
        if tamper == "bad-plain-hash": pt_sha = "0" * 64
        path = os.path.join(store, location); os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, "wb").write(enc)
        arts.append({"source_name": names[role], "engine": engine, "archive_kind": "archive_enc", "dump_format": dump_format, "archive_format_version": 1, "encrypted": True,
                     "channel_id": None, "channel_kind": "s3", "location": location, "generated_id": None, "size_bytes": pt_size,
                     "ciphertext_sha256": sha_enc, "plaintext_sha256": pt_sha, "plaintext_size": pt_size,
                     "plaintext_hash_source": "dashboard_verify_job", "required": True})
    t = lambda name: case.replace("tampered-", "") == name and case.startswith("tampered-")
    add_archive("compose", compose_tgz, "files", "backups/proj/compose.tar.gz.enc")
    add_archive("volume", vol_tgz, "docker-volume", "backups/proj/volume.tar.gz.enc", tamper="flip" if case == "tampered-archive" else "flip-consistent" if case == "tampered-consistent" else "truncate-consistent" if case == "truncated-consistent" else "bad-plain-hash" if case == "bad-plaintext-hash" else None)
    add_archive("db", pg_tgz, db_engine, "backups/proj/db.tar.gz.enc", dump_format="pg_directory" if case == "dump-format-mismatch" else pg_format)
    # restic artifact repo (bind path)
    rdir = os.path.join(folder, "restic", gid); os.makedirs(os.path.dirname(rdir), exist_ok=True)
    pwf = os.path.join(out, "pw.restic"); open(pwf, "w").write(hkdf(master, f"portabase/restic/v1/{gid}").hex())
    src = os.path.join(out, "bindsrc"); os.makedirs(os.path.join(src, "dir"))
    for n, d in data_files: open(os.path.join(src, n), "wb").write(d)
    env = {**os.environ, "RESTIC_PASSWORD_FILE": pwf, "RESTIC_REPOSITORY": rdir, "RESTIC_CACHE_DIR": os.path.join(out, "cache")}
    sh(["restic", "init"], env=env); sh(["restic", "backup", "--host", "agent", "."], env=env, cwd=src)
    snap = json.loads(sh(["restic", "snapshots", "--json"], env=env))[0]["id"]
    arts.append({"source_name": names["bind"], "engine": "files", "archive_kind": "restic_snapshot", "dump_format": None, "archive_format_version": None, "encrypted": True,
                 "channel_id": None, "channel_kind": "s3", "location": snap, "generated_id": gid, "size_bytes": None, "ciphertext_sha256": None,
                 "plaintext_sha256": None, "plaintext_size": None, "plaintext_hash_source": "not_applicable_restic", "required": True})
    manifest = {"manifest_version": 1, "kid": mkid, "signed_at": "2026-11-07T10:00:00Z",
                "rp": {"id": rp, "stack_id": str(uuid.uuid4()) if case == "stack-mismatch" else stack, "stack_name": "pbrtest", "sequence": 1, "created_at": "2026-11-07T09:00:00Z",
                       "finalized_at": "2026-11-07T09:05:00Z", "verified_at": "2026-11-07T10:00:00Z", "consistency_level": "mixed", "inventory_version": 1,
                       "inventory_hash": "h", "required_artifact_count": len(arts)},
                "artifacts": arts, "inventory": {"schema_version": 1, "stack": {"compose_project": "pbrtest", "display_name": "pbrtest", "compose_read": "none", "config_files_hint": [f"{label}/compose.yml"]}, "services": [], "mounts": [], "volumes": [], "networks": [], "env_files": [], "external_dependencies": [], "provenance": {}, "warnings": []}}
    if case == "bad-schema": manifest["unexpected_extra_field"] = 1
    mdir = os.path.join(out, "mdir"); os.makedirs(mdir)
    mjson = canon(manifest).encode(); open(os.path.join(mdir, "manifest.json"), "wb").write(mjson)
    sh(["openssl", "dgst", "-sha256", "-sign", signer, "-out", os.path.join(mdir, "manifest.json.sig"), os.path.join(mdir, "manifest.json")])
    if case == "flipped-manifest": open(os.path.join(mdir, "manifest.json"), "wb").write(mjson.replace(b'"stack_name":"pbrtest"', b'"stack_name":"pbrtesT"'))
    open(os.path.join(mdir, "signing-key.pub.pem"), "w").write(open(signer + ".pub").read())
    mrepo = os.path.join(folder, "fork-manifest", stack); os.makedirs(os.path.dirname(mrepo), exist_ok=True)
    mpw = os.path.join(out, "pw.manifest"); open(mpw, "w").write(hkdf(master, f"portabase-fork/manifest/v1/{stack}").hex())
    menv = {**os.environ, "RESTIC_PASSWORD_FILE": mpw, "RESTIC_REPOSITORY": mrepo, "RESTIC_CACHE_DIR": os.path.join(out, "cache")}
    sh(["restic", "init"], env=menv)
    sh(["restic", "backup", "--host", "portabase-fork", "--tag", "fork-manifest", "--tag", f"rp:{rp}", "--tag", "seq:1", "."], env=menv, cwd=mdir)
    # --- kit
    kit = {"kit_version": 1, "issued_at": "2026-11-07T08:00:00Z", "master_key_b64": base64.b64encode(master).decode(),
           "kek": {"active": kekid, "keys": [{"kid": kekid, "key_b64": base64.b64encode(kek).decode()}]},
           "signing_public_keys": [{"kid": kid, "spki_sha256": spki, "pem": open(pub).read(), "retired": False}], "storage": [], "recover": {}}
    pw = "TEST-ONLY correct horse 9 battery"
    header = json.dumps({"kdf": "scrypt", "N": 131072, "r": 8, "p": 1, "salt": base64.b64encode(os.urandom(16)).decode(), "iv": base64.b64encode(os.urandom(12)).decode()}, separators=(",", ":"))
    h = json.loads(header)
    k = hashlib.scrypt(pw.encode(), salt=base64.b64decode(h["salt"]), n=131072, r=8, p=1, dklen=32, maxmem=256 << 20)
    body = base64.b64encode(AESGCM(k).encrypt(base64.b64decode(h["iv"]), json.dumps(kit).encode(), header.encode())).decode()
    open(os.path.join(out, "kit.pbkit"), "w").write("PBKIT1\n" + header + "\n" + "\n".join(body[i:i + 64] for i in range(0, len(body), 64)) + "\n")
    open(os.path.join(out, "pass.txt"), "w").write(pw + "\n")
    open(os.path.join(out, "paper.txt"), "w").write(paper_lines(master, kek, kekid, spki))
    open(os.path.join(out, "secrets.txt"), "w").write("\n".join([base64.b64encode(master).decode(), master.hex(), base64.b64encode(kek).decode(), kek.hex(), pw, hkdf(master, f"portabase-fork/manifest/v1/{stack}").hex(), hkdf(master, f"portabase/restic/v1/{gid}").hex()]) + "\n")
    open(os.path.join(out, "rclone.conf"), "w").write("[local]\ntype = local\n")
    code_in = hashlib.sha256(b"portabase-fork-kit/v1\0" + master + b"\0" + kekid.encode() + b":" + kek + b"\0" + bytes.fromhex(spki)).hexdigest()[:20].upper()
    json.dump({"stack": stack, "rp": rp, "store": store, "code": "-".join(code_in[i:i + 4] for i in range(0, 20, 4)), "label": label, "kid": kid, "rows_sha": rows_sha}, open(os.path.join(out, "info.json"), "w"))
    for f in os.listdir(out):
        p = os.path.join(out, f)
        if os.path.isfile(p): os.chmod(p, 0o600)


main()
