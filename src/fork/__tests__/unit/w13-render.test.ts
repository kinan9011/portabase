import {describe, expect, it} from "vitest";
import {NOTIFY} from "@/fork/ui/labels";
import {baseOrigin, renderNotification, safeStackName} from "@/fork/notifications/render";
import {DELIVERABLE_KINDS} from "@/fork/notifications/vocab";

const SID = "6f1d2c3a-4b5e-4f60-8a7b-9c0d1e2f3a4b";
const BASE = "https://pb.example.test";
const CANARY = ["/srv/secret/data", "AKIACANARYKEY", "postgres://u:hunter2@db/x", "CANARY-RAW-ERROR", "MINIO_ROOT_PASSWORD", "stack.env"];

describe("notification bodies (§4.7): state + stack name + link only", () => {
    it.each(DELIVERABLE_KINDS)("%s renders a fixed sentence + link and nothing from the payload's free text", (kind) => {
        const r = renderNotification({kind, stackName: "shop", baseUrl: BASE, payload: {stackId: SID, reason: "member_timeout", hours: 30, state: "failed", error: CANARY[3], path: CANARY[0], key: CANARY[1], url: CANARY[2], link: "https://evil.example/x", codes: [CANARY[4]]}});
        expect(r).not.toBeNull();
        const text = `${r!.title}\n${r!.message}`;
        for (const c of CANARY) expect(text).not.toContain(c);
        expect(text).not.toContain("evil.example");
        expect(r!.message).toContain(`${BASE}/dashboard/stacks`);
        expect(r!.title.startsWith(`${NOTIFY.titlePrefix} · `)).toBe(true);
    });

    it("a stack-scoped body names the (sanitised) stack and links to it; the link is rebuilt from the validated uuid, never taken from the payload", () => {
        const r = renderNotification({kind: "run.failed", stackName: "shop", baseUrl: BASE, payload: {stackId: SID, reason: "member_timeout", link: "https://evil.example/x"}})!;
        expect(r.message).toBe(["shop: The backup failed.", NOTIFY.reasons.member_timeout, `${BASE}/dashboard/stacks/${SID}`].join("\n"));
        expect(r.level).toBe("critical");
        expect(r.event).toBe("error_backup");
    });

    it("a non-uuid stack id yields the list link (never an interpolated string)", () => {
        const r = renderNotification({kind: "run.failed", stackName: "shop", baseUrl: BASE, payload: {stackId: "../../etc/passwd"}})!;
        expect(r.message).toContain(`${BASE}/dashboard/stacks`);
        expect(r.message).not.toContain("passwd");
    });

    it("unknown reason codes are dropped (closed table), unknown kinds are not notifications", () => {
        const r = renderNotification({kind: "run.failed", stackName: "x", baseUrl: BASE, payload: {stackId: SID, reason: "CANARY-RAW-ERROR /srv/x"}})!;
        expect(r.message).not.toContain("CANARY");
        expect(renderNotification({kind: "discovery.circuit_open", stackName: null, baseUrl: BASE, payload: {}})).toBeNull();
        expect(renderNotification({kind: "totally.unknown", stackName: null, baseUrl: BASE, payload: {}})).toBeNull();
    });

    it("dead-man: only a clamped integer hour count is interpolated; failures are critical with the existing `error_backup_missing` kind", () => {
        const r = renderNotification({kind: "stack.no_good_backup", stackName: "shop", baseUrl: BASE, payload: {stackId: SID, hours: 36.9}})!;
        expect(r.message).toContain("No verified backup for 36 h.");
        expect(r.event).toBe("error_backup_missing");
        expect(renderNotification({kind: "stack.no_good_backup", stackName: "s", baseUrl: BASE, payload: {stackId: SID, hours: 1e99}})!.message).toContain("100000 h");
        expect(renderNotification({kind: "stack.no_good_backup", stackName: "s", baseUrl: BASE, payload: {stackId: SID, hours: "36; DROP"}})!.message).not.toContain("DROP");
    });

    it("self-check kinds are not stack scoped; recovered is info with the recovery event", () => {
        const f = renderNotification({kind: "fork.selfcheck.failed", stackName: null, baseUrl: BASE, payload: {codes: ["org-count", CANARY[0]]}})!;
        expect(f.title).toContain("Fork configuration locked");
        expect(f.message).not.toContain("/srv");
        expect(f.message).not.toContain("org-count");
        const ok = renderNotification({kind: "fork.selfcheck.recovered", stackName: null, baseUrl: BASE, payload: {codes: []}})!;
        expect([ok.level, ok.event]).toEqual(["info", "success_backup_recovered"]);
    });

    it("no base URL ⇒ no link is guessed", () => {
        const r = renderNotification({kind: "run.failed", stackName: "s", baseUrl: null, payload: {stackId: SID}})!;
        expect(r.message).not.toMatch(/https?:\/\//);
        expect(r.message.endsWith(NOTIFY.generic)).toBe(true);
    });
});

describe("safeStackName / baseOrigin", () => {
    it.each([
        ["shop", "shop"],
        ["my.app.example.com", "my_app_example_com"],
        ["https://evil.test/x?a=b", "httpsevil_testxab"],
        ["a\nb\u0000c‮evil", "abcevil"],
        ["user:pass@host", "userpasshost"],
        ["  ", NOTIFY.stackFallback],
        ["", NOTIFY.stackFallback],
        ["ünïcode-Ñame", "ünïcode-Ñame"],
        ["x".repeat(200), "x".repeat(60)],
    ])("%j → %j", (input, out) => expect(safeStackName(input)).toBe(out));
    it("null name → fallback", () => expect(safeStackName(null)).toBe(NOTIFY.stackFallback));
    it("origin only, http(s) only", () => {
        expect(baseOrigin("https://pb.example.test/some/path?x=1#y")).toBe("https://pb.example.test");
        expect(baseOrigin("http://localhost:8887")).toBe("http://localhost:8887");
        expect(baseOrigin("javascript:alert(1)")).toBeNull();
        expect(baseOrigin("not a url")).toBeNull();
        expect(baseOrigin(undefined)).toBeNull();
    });
});
