import {describe, expect, it} from "vitest";
import {compileMirror} from "@/fork/compose-compiler/compile";
import {type MirrorDiffEntry, renderMirrorDiff} from "@/fork/compose-compiler/diff";
import {ACCESS, CANARY, CLEAN_RAW, PROJECT, WS, labView} from "../fixtures/compose-compiler/lab";

type Doc = Record<string, any>; // biome-ignore lint/suspicious/noExplicitAny: loose JSON fixtures
const compile = (view: unknown, access: typeof ACCESS | null = ACCESS) => {
    const r = compileMirror({view: JSON.stringify(view), raw: CLEAN_RAW, options: {project: PROJECT, workspace: WS, access}});
    if (!r.ok) throw new Error(JSON.stringify(r.refusals));
    return r;
};

describe("redacted mirror diff (W20 D-8)", () => {
    const r = compile(labView());
    const text = renderMirrorDiff(r.diff);
    const lines = text.split("\n");

    it("reads as plain sentences (snapshot)", () => {
        expect(text).toMatchInlineSnapshot(`
          "environment: any password inside a URL value is replaced by a mirror-only value (all services)
          network internal: replaced by an isolated mirror network (no outside access)
          network pbm_access: added for private access to web (loopback publish only; the runner firewall blocks its egress)
          network lab_proxy: was shared with production (external) → replaced by an isolated mirror network
          project: name forklab-demo → pbm-lab (the mirror is a separate Compose project)
          volume appdata: renamed to pbm-lab_appdata (a mirror never shares production volumes)
          volume pgdata: renamed to pbm-lab_pgdata (a mirror never shares production volumes)
          db: postgresql role password (user from POSTGRES_USER) must be reset to the mirror-only value after a volume restore
          db: environment POSTGRES_PASSWORD → replaced by a mirror-only value
          web: container name lab-web → kept as a network alias so other services still find it
          web: postgresql role password (admin role) must be reset to the mirror-only value after a volume restore
          web: environment SMTP_HOST → pointed at disabled.invalid so it cannot reach a real service
          web: environment POSTGRES_PASSWORD → replaced by a mirror-only value
          web: label traefik.enable dropped (proxy, updater and scheduler labels do not belong to a mirror)
          web: private access published on 127.0.0.1:18099 → 8080/tcp (reachable only on the runner, through an SSH tunnel)
          web: published port 127.0.0.1:18080 → 8080/tcp removed (a mirror is reachable only through private access)
          web: extra_hosts removed (1 entry; values are never shown)"
        `);
    });

    it("every line is short, plain, and starts with a service name, network, volume, project or environment", () => {
        const services = Object.keys((labView() as Doc).services);
        for (const l of lines) {
            expect(l.length, l).toBeLessThanOrEqual(200);
            expect(l, l).not.toMatch(/[{}"]/);
            expect(l, l).not.toContain("undefined");
            expect(services.some((s) => l.startsWith(`${s}: `)) || /^(network|volume|project|environment)\b/.test(l), l).toBe(true);
        }
    });

    it("names the production network and the removed published port", () => {
        expect(text).toContain("network lab_proxy: was shared with production (external) → replaced by an isolated mirror network");
        expect(text).toContain("web: published port 127.0.0.1:18080 → 8080/tcp removed (a mirror is reachable only through private access)");
        expect(text).toContain("web: environment POSTGRES_PASSWORD → replaced by a mirror-only value");
        expect(text).toContain("environment: any password inside a URL value is replaced by a mirror-only value (all services)");
    });

    it("is sorted service → kind → subject and deterministic", () => {
        expect(renderMirrorDiff([...r.diff].reverse())).toBe(text);
        expect(renderMirrorDiff(compile(labView()).diff)).toBe(text);
    });

    it("shows env KEYS and actions but never a value; extra_hosts / dns show counts only", () => {
        const v = labView() as Doc;
        v.services.web.dns = ["1.1.1.1", "9.9.9.9"];
        v.services.web.extra_hosts = {"db.prod.example": "", "cache.prod.example": ""};
        const t = renderMirrorDiff(compile(v).diff);
        expect(t).toContain("web: dns removed (2 entries; values are never shown)");
        expect(t).toContain("web: extra_hosts removed (2 entries; values are never shown)");
        for (const secret of ["1.1.1.1", "9.9.9.9", "10.9.8.7", CANARY, "smtp.prod.example"]) expect(t).not.toContain(secret);
    });

    it("sanitises hostile subjects (keys that are allowed to appear)", () => {
        const v = labView() as Doc;
        v.services.web.labels["traefik.x\n\"{evil}\""] = "";
        v.services.web.environment["CANARY_KEY_W20_PASSWORD"] = "";
        const t = renderMirrorDiff(compile(v).diff);
        expect(t).toContain("CANARY_KEY_W20_PASSWORD");
        expect(t).not.toMatch(/[{}"]/);
        expect(t.split("\n").every((l) => l.length <= 200)).toBe(true);
    });

    it("a forged value is rejected before any diff exists and never appears in the refusal", () => {
        const v = labView() as Doc;
        v.services.web.environment.SMTP_HOST = CANARY;
        const c = compileMirror({view: JSON.stringify(v), raw: CLEAN_RAW, options: {project: PROJECT, workspace: WS, access: ACCESS}});
        expect(c.ok).toBe(false);
        expect(JSON.stringify(c)).not.toContain(CANARY);
    });

    it("entries are structured and typed", () => {
        const kinds = new Set(r.diff.map((e: MirrorDiffEntry) => e.kind));
        for (const k of ["project_renamed", "port_removed", "port_published_loopback", "container_name_to_alias", "network_replaced", "network_isolated", "volume_renamed", "label_dropped", "env_rotate", "env_disable", "removed_key", "credential_reset", "image_unpinned"]) {
            if (k === "image_unpinned") continue; // the lab images are digest-pinned
            expect(kinds.has(k as never), k).toBe(true);
        }
    });

    it("an image without a digest gets an informational line", () => {
        const v = labView() as Doc;
        v.services.db.image = "postgres:17";
        expect(renderMirrorDiff(compile(v).diff)).toContain("db: image postgres:17 is not pinned by digest");
    });
});
