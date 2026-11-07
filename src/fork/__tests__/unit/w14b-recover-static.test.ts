import {readFileSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {RECOVER_STEPS} from "@/fork/ui/labels";

/** W14b static guards: CLI step lines == labels.ts, shared deny-list file shape, kit guide pointer, no stray secret option on a command line. */
const R = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const CLI = R("scripts/fork/recover/portabase-recover");

describe("portabase-recover static contract", () => {
    it("every step line equals its labels.ts sentence", () => {
        const pairs: Record<string, string> = {S_KIT: "kit", S_LIST: "list", S_SIG: "signature", S_SUMS: "checksums", S_FILES: "files", S_VOLS: "volumes", S_POLICY: "policy", S_DBS: "databases", S_UP: "start"};
        for (const [c, k] of Object.entries(pairs)) {
            const m = CLI.match(new RegExp(`readonly ${c}="([^"]+)"`));
            expect(m, c).not.toBeNull();
            expect(m?.[1], c).toBe(RECOVER_STEPS[k as keyof typeof RECOVER_STEPS]);
        }
    });
    it("compose-deny.json: version 1, the D27 rule set, unique ids, plain-words text for each directive", () => {
        const j = JSON.parse(R("src/fork/policy/compose-deny.json"));
        expect(j.version).toBe(1);
        expect(j.rules.map((r: {id: string}) => r.id)).toEqual(["privileged", "network_mode_host", "pid_host", "ipc_host", "devices", "cap_add", "docker_sock", "bind_outside_root"]);
        for (const r of j.rules) { expect(r.plain.length).toBeGreaterThan(20); expect(r.directive.length).toBeGreaterThan(3); }
        expect(j.cap_add_allowlist).not.toContain("SYS_ADMIN");
        expect(j.cap_add_allowlist).not.toContain("ALL");
        expect(j.docker_socket_paths).toContain("/var/run/docker.sock");
        expect(j.raw_read_scope.keys).toEqual(expect.arrayContaining(["env_file", "include", "extends.file"]));
    });
    it("the CLI reads its rules from that one file (never an inline copy of the rule list)", () => {
        expect(CLI).toContain("compose-deny.json");
        expect(CLI).not.toMatch(/SYS_ADMIN|privileged == true and/);
    });
    it("no eval, no secret on argv, hard stops use exit 3 and policy refusals exit 4", () => {
        expect(CLI).not.toMatch(/(^|[;&|(] *)eval[ (]/m);
        expect(CLI).not.toMatch(/hexkey:/);
        expect(CLI).toMatch(/hard\(\) \{[^}]*exit 3/);
        expect(CLI).toMatch(/die 4 /);
    });
    it("the guide exists, is linked from --help, and carries the Debian/Ubuntu install block incl. python3-cryptography", () => {
        const guide = R("scripts/fork/recover/my-server-died.md");
        expect(CLI).toContain("my-server-died.md");
        for (const p of ["openssl", "restic", "rclone", "jq", "python3-cryptography", "python3-yaml", "docker"]) expect(guide).toContain(p);
        expect(guide).toMatch(/apt(-get)? install/);
    });
});
