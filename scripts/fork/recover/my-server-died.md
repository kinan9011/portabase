# My server died — get your stacks back

This guide brings a stack back on a **new, empty machine** using only two things: your **recovery kit** and your **backup storage**. It does not need the old server, and it does not need the Portabase dashboard. You do not need to be an expert: copy each command exactly, one at a time, and read what it prints.

> **Do the first part today, not on the bad day.** Part 1 takes ten minutes and tells you whether your kit really works. A kit you have never tested is a hope, not a backup.

Words used here: **kit** = the file or the paper you got from the dashboard's *Recovery kit* page. It lets anyone who holds it read all your backups, so treat it like a bank key. **Storage** = where your backups are kept (S3, MinIO, …). **Stack** = one application with its files, volumes and databases.

---

## Part 1 — Check your kit today (offline, 10 minutes)

You need a computer with the tools of Part 2 and the kit. You do **not** need your server.

1. Install the tools (Part 2) and fetch the recovery tool (Part 3).
2. Run the kit check. For a **digital kit** (a file ending `.pbkit`):

   ```bash
   cd ~/portabase-recover-src
   scripts/fork/recover/portabase-recover verify-kit --kit /path/to/kit.pbkit
   ```

   It asks for your passphrase (nothing is shown while you type). For a **paper kit**, type the key lines from the paper into a text file first — one line per row, exactly as printed, including the two letters after the dot — and add the line that starts with the signing key number and says `(current)`:

   ```bash
   nano ~/kit-lines.txt        # type the lines, save with Ctrl+O, leave with Ctrl+X
   scripts/fork/recover/portabase-recover verify-kit --paper-file ~/kit-lines.txt \
       --rclone-config ~/my-rclone.conf --storage-root MYREMOTE:MYBUCKET
   ```

   (A paper kit does not hold your storage password. `my-rclone.conf` is an rclone configuration for your storage; `MYREMOTE:MYBUCKET` is the remote name and the bucket.)
3. If a line you typed has a typo, the tool tells you which line. Fix it and run again.
4. At the end it prints one line: **Verification code … `XXXX-XXXX-XXXX-XXXX-XXXX`**. Open the dashboard → *Integrations → Recovery kit* and type this code into the *Verify* box. The dashboard now shows the kit as verified. The code is safe to type; it is not a key.
5. Do this again after every key change (the dashboard tells you) and once a year.

If the tool says *"the kit could NOT open the repository"*, your kit does not match your backups. Do not wait for the bad day: create a new kit in the dashboard now.

---

## Part 2 — What the new machine needs

A fresh **Debian 12 / Ubuntu 22.04 or newer** machine, with internet access and a user that may use `sudo`. Copy these commands exactly:

```bash
sudo apt-get update
sudo apt-get install -y openssl jq restic rclone python3 python3-cryptography python3-yaml git ca-certificates curl
openssl version      # must say OpenSSL 3.0 or newer
```

Then install Docker with the Compose plugin (version 2.24 or newer):

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"      # then log out and in again, so you may use docker
docker compose version               # must say 2.24 or newer
```

(Why these: `openssl`, `jq`, `restic`, `rclone` read your backups; `python3-cryptography` unlocks the encrypted archives; `python3-yaml` lets the tool read your Compose file safely; Docker runs the stack.)

---

## Part 3 — Get the recovery tool

The tool is a folder of three small scripts. Fetch exactly the version your kit names (the *Recovery tool* line on the paper kit, or `recover.cli_version` in the digital kit; if it says only `pending`, use the tag below):

```bash
git clone --depth 1 --filter=blob:none --sparse --branch fork/w14b-done https://github.com/kinan9011/portabase.git ~/portabase-recover-src
cd ~/portabase-recover-src
git sparse-checkout set scripts/fork/recover src/fork/policy
scripts/fork/recover/portabase-recover help
```

No internet on the new machine? Copy the folders `scripts/fork/recover` and `src/fork/policy` from any other machine (USB stick) into `~/portabase-recover-src/` keeping the same layout.

**Keep your kit outside any folder you restore into** (for example in your home folder, `~/kit/`). The tool refuses a restore folder that contains your kit.

---

## Part 4 — Restore

Put the kit on the new machine (for example `~/kit/kit.pbkit`). Replace `KIT` below with its path. In the commands, `--kit` is for a digital kit; for a paper kit use `--paper-file ~/kit-lines.txt --rclone-config ~/my-rclone.conf --storage-root MYREMOTE:MYBUCKET` instead (see Part 1).

**Step 1 — See what is in storage** (changes nothing):

```bash
cd ~/portabase-recover-src
scripts/fork/recover/portabase-recover list --kit KIT
```

It prints your stacks (each with a long id) and their recovery points. Copy the stack id of the one you want.

**Step 2 — Check the plan** (changes nothing). Replace `STACKID`:

```bash
scripts/fork/recover/portabase-recover plan --deep --kit KIT --stack STACKID
```

The tool checks the signature on the recovery point with your kit, then downloads and checks **every** backup file against its recorded checksum. You will see lines such as `signature valid` and `artifact 0 ok`. If you know the number of your newest recovery point from the dashboard, add `--min-sequence NUMBER`; the tool then refuses anything older (protection against someone replacing your backups with old ones).

**If it says `STOP (cannot be overridden)`:** the signature or a checksum is wrong. Nothing was changed. Do not try to force it: the backup was damaged or tampered with. Try an older recovery point by adding `--rp ID` (ids are in `list`) and tell whoever manages your storage.

**Step 3 — Restore.** Choose an empty folder (the default is `/srv/portabase-restore/STACKID`):

```bash
sudo mkdir -p /srv/portabase-restore
scripts/fork/recover/portabase-recover restore --yes --kit KIT --stack STACKID --root /srv/portabase-restore/mystack
```

The tool does it in this order and says each step in plain words: checks the signature → checks all files → restores files → restores Docker volumes → checks your Compose file for risky settings → restores databases → starts the stack. **Nothing on your machine changes until every check has passed.**

**Risky settings.** If your Compose file asks for powers a recovery should not grant — full control of the machine, the Docker socket (a reverse proxy like Traefik does this), host networking, hardware devices, or files outside the restore folder — the tool refuses and says in plain words what the service wants. If you wrote that file and trust it, allow **that one service** and run the same command again:

```bash
scripts/fork/recover/portabase-recover restore --yes --kit KIT --stack STACKID --root /srv/portabase-restore/mystack2 --allow-privileged=SERVICENAME
```

(Use a fresh empty restore folder each time.) Never allow something you do not recognise. A Compose file that tries to read files **outside** the restore folder is always refused, with no way around it.

**Your own project name.** To start the restored stack next to something else, add `--project-name newname`.

---

## Part 5 — After the stack is up (the tool prints this list too)

- [ ] **DNS / IP address:** point your domain names at the new machine.
- [ ] **Ports and firewall:** open only the ports the stack needs. `docker compose -p NAME ps` shows them.
- [ ] **TLS certificates:** a reverse proxy usually fetches new ones once DNS points here.
- [ ] **Open your application** and check that your data is there.

**Protect the new machine again (important):**

1. Install a Portabase agent on the new machine and add it to your dashboard.
2. Re-bind the sources (files, volumes, databases) to the new agent and run **one backup now**.
3. Confirm that backup succeeds. Until it does, the new machine has **no fresh backup**.

**Switch off the old machine's access:**

1. Delete the old agent in the dashboard and rotate the edge key (the old server might still run somewhere, or have been broken into).
2. Rotate your storage credentials at your storage provider and update them in the dashboard.

---

## If the dashboard died too

Your stacks can come back without it (Parts 1–5). To bring the dashboard itself back:

1. Install the same dashboard version on a new machine with an empty database.
2. Restore the dashboard's database backup: this tool unpacks it. Run `portabase-recover restore` for the stack that holds the dashboard database, or decrypt one archive by hand (the dump is an ordinary PostgreSQL dump inside the archive).
3. Put the **master key** and the **signing key** from your kit into the dashboard's `keys` folder (`master_key.bin`, `server_private.pem`, `server_public.pem`), and the fork key files into `keys/fork-kek/`.
4. **Before anyone logs in:** sign every user out, rotate every API key, rotate the storage credentials, re-enroll agents if you doubt the edge key.
5. Open *Integrations → Recovery kit*. If it says the kit is out of date, create a new kit and verify it (Part 1).

---

## Good to know

- **Nothing is sent anywhere.** The tool talks only to your storage (and Docker). It prints no key, and writes keys only into a private temporary folder that it deletes at the end.
- **A technical note for experts:** deriving a key with `openssl kdf … hexkey:` puts the key on the command line, where other users of the same machine could see it. The tool does not do that; it derives keys inside Python from a file. If you do it by hand, do it on a machine only you use.
- **Databases other than PostgreSQL:** the tool unpacks their dumps into `<restore folder>/databases/<name>` and tells you so; import them with that database's own tools. SQLite files are unpacked the same way because a backup does not record where the file lived: copy it to the place your application expects.
- **Exit codes:** `0` fine · `1` something failed (read the message) · `2` wrong command · `3` a check failed and cannot be overridden · `4` a risky setting was refused · `5` a tool is missing (the message says what to install).
