import {spawnSync} from "node:child_process";
import {cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {checkMirrorView, compileMirror} from "@/fork/compose-compiler/compile";
import {renderMirrorDiff} from "@/fork/compose-compiler/diff";
import {classifyEnvKey} from "@/fork/compose-compiler/rules";
import {applyMirrorSpec, mirrorHash} from "@/fork/compose-compiler/env";
import {evaluateRenderedCompose} from "@/fork/policy/engine";
import {checkRawCompose} from "@/fork/policy/raw";
import {blankPolicyView} from "@/fork/restore-tasks/view";

type Doc = Record<string, any>; // biome-ignore lint/suspicious/noExplicitAny: rendered compose JSON

/**
 * Env-gated LOCAL lab check (FORK_LAB_COMPOSE=1, W20 Step 10). Renders the synthetic lab demo stack with `docker compose config` (reads files, starts
 * NOTHING, no network), compiles it, applies the spec to the full render and validates the result with `docker compose config` again: the runner-side
 * validation, emulated locally. No container, network or volume is created; the temp copy is removed in `finally`. Never a pilot host.
 */
describe.skipIf(!process.env.FORK_LAB_COMPOSE)("lab demo stack → mirror (W20 Step 10, local, starts no container)", () => {
    const PROJECT = "pbm-w20lab";
    const seed = Uint8Array.from({length: 32}, (_, i) => 200 - i);
    const dockerConfig = (cwd: string, args: string[]) => {
        const r = spawnSync("docker", ["compose", ...args, "config", "--format", "json"], {cwd, encoding: "utf8"});
        expect(r.status, r.stderr).toBe(0);
        return r.stdout;
    };

    it("compiles, applies, validates, and refuses the poison variant", () => {
        const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "w20-lab-")));
        try {
            const root = path.join(tmp, PROJECT); // the mirror workspace layout: <restore_root>/<project>
            cpSync(path.join(process.cwd(), "dev/fork-lab/demo-stack"), root, {recursive: true});
            const stackEnv = Object.fromEntries(readFileSync(path.join(root, "stack.env"), "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
            const base = ["compose.yml", "compose.override.yml"];
            const raw = (files: string[]) => checkRawCompose({root: tmp, entry: files.map((f) => path.join(root, f)), files: files.map((f) => ({path: path.join(root, f), text: readFileSync(path.join(root, f), "utf8")}))});
            const full = dockerConfig(root, base.flatMap((f) => ["-f", f]));
            const fullDoc = JSON.parse(full) as Doc;
            const view = JSON.stringify(blankPolicyView(fullDoc));
            const options = {project: PROJECT, workspace: root, access: {service: "web", target: 8080, host_port: 18099}};

            const c = compileMirror({view, raw: raw(base), options: {...options, workspace: root}});
            expect(c.ok, c.ok ? "" : JSON.stringify(c.refusals)).toBe(true);
            if (!c.ok) return;
            const v = c.spec.view as Doc;
            expect(v.services.web.ports).toEqual([{mode: "ingress", host_ip: "127.0.0.1", target: 8080, published: "18099", protocol: "tcp"}]);
            expect(JSON.stringify(v.services)).not.toContain("18080");
            expect(v.networks.lab_proxy).toEqual({name: `${PROJECT}_lab_proxy`, internal: true});
            expect(v.networks.internal.internal).toBe(true);
            expect(v.services.db.networks.internal).toEqual({aliases: ["demo-db"]});
            expect(c.spec.env.db.POSTGRES_PASSWORD).toBe("rotate");
            expect(c.spec.env.web.APP_GREETING).toBe("keep");
            expect(v.services.web.labels["forklab.role"]).toBe("");
            expect(v.services.web.labels["com.portabase.fork.restore_id"]).toBeUndefined();
            const diff = renderMirrorDiff(c.diff);
            expect(diff).toContain("network lab_proxy: was shared with production (external)");
            expect(diff).toContain("published port 127.0.0.1:18080");

            const ap = applyMirrorSpec(fullDoc, c.spec, seed);
            expect(ap.ok).toBe(true);
            if (!ap.ok) return;
            const outPath = path.join(tmp, "out.json");
            writeFileSync(outPath, JSON.stringify(ap.doc), {mode: 0o600});
            // runner-side validation, emulated: compose must accept the merged document (nothing is started or created)
            const rerender = JSON.parse(dockerConfig(root, ["-p", PROJECT, "-f", outPath])) as Doc;
            const blank = blankPolicyView(rerender);
            const chk = checkMirrorView(blank, {project: PROJECT, workspace: root, access: options.access, requireOwnerLabels: false});
            expect(chk.violations).toEqual([]);
            expect(evaluateRenderedCompose({rendered: JSON.stringify(blank), roots: [root], raw: {refused: false, violations: [], reason: null}, drift: null}).verdict).toBe("allow");

            // credentials: rotated, consistent across db and web; non-secret env untouched
            const real = stackEnv.POSTGRES_PASSWORD as string;
            const d = ap.doc as Doc;
            expect(d.services.db.environment.POSTGRES_PASSWORD).not.toBe(real);
            expect(d.services.db.environment.POSTGRES_PASSWORD).toBe(mirrorHash(seed, real));
            expect(d.services.web.environment.POSTGRES_PASSWORD).toBe(d.services.db.environment.POSTGRES_PASSWORD);
            expect(d.services.web.environment.APP_GREETING).toBe(stackEnv.APP_GREETING);
            expect(JSON.stringify(d)).not.toContain(real);

            // poison variant (the W20a poison override): refused in mirror mode, no override path
            writeFileSync(path.join(root, "poison.yml"), "services:\n  web:\n    use_api_socket: true\n    security_opt: [seccomp=unconfined]\n    networks: [hostnet]\n    volumes:\n      - type: volume\n        source: evil\n        target: /evil\nnetworks:\n  hostnet:\n    external: true\n    name: host\nvolumes:\n  evil:\n    driver: local\n    driver_opts: {type: none, o: bind, device: /etc}\n");
            const all = [...base, "poison.yml"];
            const poisonView = JSON.stringify(blankPolicyView(JSON.parse(dockerConfig(root, all.flatMap((f) => ["-f", f])))));
            const p = compileMirror({view: poisonView, raw: raw(all), options: {...options, workspace: root}});
            expect(p.ok).toBe(false);
            if (p.ok) return;
            const rules = p.refusals.filter((x) => x.code === "policy_finding").map((x) => x.detail.split(":")[0]);
            for (const want of ["docker_sock", "network_mode_host", "unknown_directive", "bind_outside_root"]) expect(rules, want).toContain(want);

            const dir = process.env.LAB_EVIDENCE_DIR;
            if (dir) {
                mkdirSync(dir, {recursive: true});
                const scrub = (s: string) => s.split(root).join("<tmp-copy>");
                const files: [string, string][] = [
                    ["lab-mirror-diff.txt", `${scrub(diff)}\n`],
                    ["lab-mirror-spec.json", `${scrub(JSON.stringify({...c.spec, workspace: "<tmp-copy>"}, null, 1))}\n`],
                    ["lab-poison-refusals.json", `${scrub(JSON.stringify(p.refusals.map(({code, service, detail}) => ({code, service, detail})), null, 1))}\n`],
                ];
                for (const [name, text] of files) {
                    for (const [k, val] of Object.entries(stackEnv)) if (classifyEnvKey(k) !== "keep" && val.length >= 4) expect(text, `${name} must not carry ${k}`).not.toContain(val); // short non-secret values (e.g. the db name) may legitimately appear inside names
                    writeFileSync(path.join(dir, name), text);
                }
            }
        } finally {
            rmSync(tmp, {recursive: true, force: true});
        }
    });
});
