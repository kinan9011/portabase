import {readdirSync, readFileSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {ARCHIVE_KINDS, AUDIT_RESULTS, CONSISTENCY_LEVELS, DUMP_FORMATS, HEALTH_STATUSES, HOST_ROLES, OUTBOX_STATES, PROTECTION_STATES, RUN_STATUSES, RUNTIME_STATES, SYNC_STATUSES} from "@/fork/db/enums";
import {ARTIFACT_PRESENCE, canTransition, deriveDowngrade, RP_DOWNGRADE_REASONS, RP_STATUSES, RpStatusSchema, type ArtifactFacts} from "@/fork/recovery/status";

describe("D43 RP status enum", () => {
    it("is exactly incomplete / pending_verification / verified / failed (no restore-tested status in v1)", () => {
        expect([...RP_STATUSES]).toEqual(["incomplete", "pending_verification", "verified", "failed"]);
        expect(RpStatusSchema.safeParse("restore_tested").success).toBe(false);
        expect(RpStatusSchema.safeParse("ok").success).toBe(false);
    });
    it("transitions: only the verify path reaches verified; verified can only downgrade; failed is terminal", () => {
        expect(canTransition("pending_verification", "verified")).toBe(true);
        expect(canTransition("incomplete", "verified")).toBe(false); // an incomplete RP never jumps to verified
        expect(canTransition("verified", "pending_verification")).toBe(false);
        expect(canTransition("verified", "incomplete")).toBe(true);
        expect(canTransition("incomplete", "failed")).toBe(true);
        for (const to of RP_STATUSES) expect(canTransition("failed", to)).toBe(false);
    });
});

describe("D44 host_role values", () => {
    it("is production | test; `runner` only arrives in R3 (W21)", () => {
        expect([...HOST_ROLES]).toEqual(["production", "test"]);
        expect(HOST_ROLES as readonly string[]).not.toContain("runner");
    });
});

const art = (o: Partial<ArtifactFacts> = {}): ArtifactFacts => ({backupId: "b", backupStorageId: "s", presence: "present", required: true, ...o});
describe("D32 downgrade rule", () => {
    it("coherent ⇒ null", () => expect(deriveDowngrade(2, [art(), art()])).toBeNull());
    it("NULL FK ⇒ fk_null (either FK)", () => {
        expect(deriveDowngrade(1, [art({backupId: null})])).toBe("fk_null");
        expect(deriveDowngrade(1, [art({backupStorageId: null})])).toBe("fk_null");
    });
    it("presence ≠ present ⇒ artifact_missing", () => {
        expect(deriveDowngrade(1, [art({presence: "missing"})])).toBe("artifact_missing");
        expect(deriveDowngrade(1, [art({presence: "unknown"})])).toBe("artifact_missing");
    });
    it("count mismatch ⇒ count_mismatch", () => expect(deriveDowngrade(3, [art(), art()])).toBe("count_mismatch"));
    it("optional artifacts do not count and do not downgrade", () => expect(deriveDowngrade(1, [art(), art({required: false, presence: "missing", backupId: null})])).toBeNull());
    it("FK reason wins over missing over count", () => expect(deriveDowngrade(5, [art({backupId: null}), art({presence: "missing"})])).toBe("fk_null"));
});

// Keeps TS value sets and the SQL CHECK constraints from drifting apart.
describe("TS enums == SQL CHECK constraints in the fork migrations (the LAST definition of a constraint wins: 0006 re-creates the RP reason check)", () => {
    const dir = path.join(process.cwd(), "src/fork/db/migrations");
    const sql = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(path.join(dir, f), "utf8")).join("\n");
    const checkValues = (name: string) => {
        const all = [...sql.matchAll(new RegExp(`CONSTRAINT "${name}" CHECK \\([^)]*IN \\(([^)]*)\\)`, "g"))];
        const m = all.at(-1);
        if (!m) throw new Error(`no CHECK ${name}`);
        return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
    };
    it.each([
        ["fork_recovery_point_status_ck", RP_STATUSES],
        ["fork_recovery_point_reason_ck", RP_DOWNGRADE_REASONS],
        ["fork_recovery_point_consistency_ck", CONSISTENCY_LEVELS],
        ["fork_arcane_environment_host_role_ck", HOST_ROLES],
        ["fork_arcane_connection_health_ck", HEALTH_STATUSES],
        ["fork_arcane_environment_sync_status_ck", SYNC_STATUSES],
        ["fork_stack_runtime_state_ck", RUNTIME_STATES],
        ["fork_stack_protection_state_ck", PROTECTION_STATES],
        ["fork_audit_event_result_ck", AUDIT_RESULTS],
        ["fork_schedule_state_status_ck", RUN_STATUSES],
        ["fork_notification_outbox_state_ck", OUTBOX_STATES],
        ["fork_rp_artifact_dump_format_ck", DUMP_FORMATS],
        ["fork_rp_artifact_archive_kind_ck", ARCHIVE_KINDS],
        ["fork_rp_artifact_presence_ck", ARTIFACT_PRESENCE],
    ] as [string, readonly string[]][])("%s", (name, values) => expect(checkValues(name)).toEqual([...values]));
});
