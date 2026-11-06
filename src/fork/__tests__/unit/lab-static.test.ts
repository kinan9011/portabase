import {existsSync, readdirSync, readFileSync, statSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";

/**
 * W02 static guards for `dev/fork-lab/` (disposable lab, synthetic data, localhost only). Source-text checks on purpose:
 * they run in the unit tier without Docker and fail the moment someone widens a bind address, commits a secret or
 * un-pins an image. The live behaviour is proven by `dev/fork-lab/drills/*.sh` (see ADR-001).
 */
const LAB = path.join(process.cwd(), "dev/fork-lab");
const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
        const p = path.join(dir, n);
        if (n === "results" || n === "data" || n === ".env.lab") return [];
        return statSync(p).isDirectory() ? walk(p) : [p];
    });
const files = walk(LAB);
const composeFiles = files.filter((f) => /compose[^/]*\.ya?ml$|override[^/]*\.ya?ml$/.test(f));
const read = (f: string) => readFileSync(f, "utf8");

describe("fork lab — network exposure", () => {
    it("has compose files to check", () => {
        expect(composeFiles.length).toBeGreaterThanOrEqual(6);
    });

    it("publishes every port on 127.0.0.1 only", () => {
        const offenders: string[] = [];
        for (const f of composeFiles) {
            for (const m of read(f).matchAll(/^\s*-?\s*(?:ports:\s*)?\[?\s*"?(\d{1,5}:\d{1,5}|[0-9.]+:\d{1,5}:\d{1,5})"?/gm)) {
                const spec = m[1];
                if (spec.split(":").length === 3 && !spec.startsWith("127.0.0.1:")) offenders.push(`${f}: ${spec}`);
                if (spec.split(":").length === 2 && /ports:/.test(m[0])) offenders.push(`${f}: ${spec} (no bind address)`);
            }
            const portsBlocks = [...read(f).matchAll(/ports:\s*\[([^\]]*)\]/g)].flatMap((m) => m[1].split(","));
            for (const p of portsBlocks) if (!p.trim().replace(/"/g, "").startsWith("127.0.0.1:")) offenders.push(`${f}: ${p.trim()}`);
            const listItems = [...read(f).matchAll(/ports:\n((?:\s+-\s+.*\n)+)/g)].flatMap((m) => m[1].split("\n").filter(Boolean));
            for (const p of listItems) if (!p.replace(/[\s"-]/g, "").startsWith("127.0.0.1:")) offenders.push(`${f}: ${p.trim()}`);
        }
        expect(offenders).toEqual([]);
    });

    it("never uses host networking, privileged containers or 0.0.0.0 binds", () => {
        for (const f of composeFiles) {
            const t = read(f).replace(/^\s*#.*$/gm, "");
            expect(t, f).not.toMatch(/network_mode:\s*"?host/);
            expect(t, f).not.toMatch(/privileged:\s*true/);
            expect(t, f).not.toMatch(/0\.0\.0\.0/);
        }
    });

    it("mounts the docker socket only where the lab documents it (arcane, agent)", () => {
        const withSock = composeFiles.filter((f) => /\/var\/run\/docker\.sock/.test(read(f).replace(/^\s*#.*$/gm, ""))).map((f) => path.relative(LAB, f));
        expect(withSock.sort()).toEqual(["compose.arcane.yml", "portabase-agent/compose.yml"]);
    });
});

describe("fork lab — supply chain and secrets", () => {
    it("pins every image by digest", () => {
        for (const f of composeFiles) {
            for (const m of read(f).matchAll(/^\s*image:\s*(\S+)/gm)) expect(m[1], `${f}: ${m[1]}`).toMatch(/@sha256:[0-9a-f]{64}$/);
        }
    });

    it("git-ignores the generated secrets file and raw run output", () => {
        const gi = read(path.join(LAB, ".gitignore"));
        for (const entry of [".env.lab", "results/", "data/"]) expect(gi).toContain(entry);
    });

    it("never ships a generated .env.lab; the example holds placeholders only", () => {
        const ex = read(path.join(LAB, ".env.lab.example"));
        expect(ex).toContain("__generated__");
        expect(ex).not.toMatch(/=[0-9a-f]{24,}/i);
    });

    it("contains no secret-looking literals (long hex/base64 outside digests and expected.json)", () => {
        for (const f of files) {
            if (f.endsWith("expected.json") || f.endsWith(".gitkeep") || f.endsWith(".sha256") /* W03: pinned spec checksum, not a secret */ || /uploads\//.test(f)) continue;
            const t = read(f).replace(/sha256:[0-9a-f]{64}/g, "").replace(/-----BEGIN/g, "BEGIN");
            expect(t, f).not.toMatch(/\b[0-9a-f]{40,}\b/i);
            expect(t, f).not.toMatch(/AKIA[0-9A-Z]{16}/);
            expect(t, f).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/); // JWT / edge key
        }
    });

    it("generates secrets with openssl rand and writes the env file with umask 077", () => {
        const lab = read(path.join(LAB, "lab.sh"));
        expect(lab).toMatch(/openssl rand/);
        expect(lab).toMatch(/umask 077/);
    });
});

describe("fork lab — demo stack oracle", () => {
    const expected = JSON.parse(read(path.join(LAB, "demo-stack/expected.json"))) as Record<string, string>;

    it("pins exactly the five checksums every restore diff compares against", () => {
        expect(Object.keys(expected).sort()).toEqual(["compose_dir", "postgres_items", "sqlite_ledger", "uploads", "volume_appdata"]);
        for (const v of Object.values(expected)) expect(v).toMatch(/^[0-9a-f]{64}$/);
    });

    it("keeps the compose dir checksum in step with the files it hashes", async () => {
        const {createHash} = await import("node:crypto");
        const sum = createHash("sha256");
        for (const n of ["compose.yml", "compose.override.yml", "stack.env"]) sum.update(readFileSync(path.join(LAB, "demo-stack", n)));
        // seed.sh: cat compose.yml compose.override.yml stack.env | sha256sum  -> must equal expected.json (regenerate with seed.sh --write-expected)
        expect(sum.digest("hex")).toBe(expected.compose_dir);
    });

    it("keeps the demo webhook on a blackhole documentation address (RFC 5737)", () => {
        expect(read(path.join(LAB, "demo-stack/compose.yml"))).toContain("192.0.2.1");
    });

    it("has the seed script and the drills the wave verification names", () => {
        for (const p of ["demo-stack/seed.sh", "drills/smoke.sh", "drills/matrix.sh", "drills/restore-diff.sh", "drills/f4-gate.sh", "drills/poll-blast.sh", "drills/sqlite-consistency.sh", "drills/trigger-probe.sh", "lab.sh"]) {
            expect(existsSync(path.join(LAB, p)), p).toBe(true);
        }
    });
});
