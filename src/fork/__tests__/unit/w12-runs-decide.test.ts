import {describe, expect, it} from "vitest";
import {artifactEncrypted, artifactHasChecksum, artifactPresent, consistencyOf, decideRecoveryPoint, type ArtifactInput, type RunFacts} from "@/fork/recovery-point/decide";
import {RP_STATUSES} from "@/fork/recovery/status";

const SHA = "a".repeat(64);
const art = (o: Partial<ArtifactInput> = {}): ArtifactInput => ({hasBackupFk: true, hasStorageFk: true, storageStatus: "success", archive: "archive", encrypted: true, ciphertextSha256: SHA, snapshotId: null, ...o});
const facts = (o: Partial<RunFacts> = {}): RunFacts => ({cancelled: false, timedOut: false, queuedMembers: 2, validatorComplete: true, encryptionOn: true, artifacts: [art(), art({archive: "restic", ciphertextSha256: null, snapshotId: SHA})], ...o});

describe("runs: RecoveryPoint decision (D43 / D39 / D32 / EU-04)", () => {
    it("complete + encrypted + checksummed + validator complete ⇒ pending_verification (never verified)", () => {
        const r = decideRecoveryPoint(facts());
        expect(r).toEqual({status: "pending_verification", reason: null, runState: "succeeded", runReason: null});
        expect(r.status).not.toBe("verified");
    });
    it("the decision can only ever return a non-verified status, over a grid of inputs", () => {
        const arts: ArtifactInput[][] = [[], [art()], [art({storageStatus: "failed"})], [art({encrypted: false})], [art({ciphertextSha256: null})], [art({archive: "restic", snapshotId: "x"})], [art({hasBackupFk: false})]];
        for (const a of arts) for (const v of [true, false]) for (const e of [true, false]) for (const q of [0, 1, 3]) for (const c of [true, false]) for (const t of [true, false]) {
            const r = decideRecoveryPoint(facts({artifacts: a, validatorComplete: v, encryptionOn: e, queuedMembers: q, cancelled: c, timedOut: t}));
            expect(RP_STATUSES).toContain(r.status);
            expect(r.status).not.toBe("verified");
            if (r.status === "pending_verification") {
                expect(c || t).toBe(false);
                expect(q).toBeGreaterThan(0);
                expect(a.length).toBeGreaterThan(0);
                expect(a.every(artifactPresent) && a.every((x) => artifactEncrypted(x, e)) && a.every(artifactHasChecksum) && v).toBe(true);
            } else expect(r.reason).toBeTruthy();
        }
    });
    it("EU-04: validator blocked ⇒ INCOMPLETE of everything readable (reason validator_blocked)", () => {
        expect(decideRecoveryPoint(facts({validatorComplete: false}))).toEqual({status: "incomplete", reason: "validator_blocked", runState: "incomplete", runReason: null});
    });
    it("D39: an unencrypted archive, or encryption off in settings, is never pending_verification", () => {
        expect(decideRecoveryPoint(facts({artifacts: [art({encrypted: false})]}))).toMatchObject({status: "incomplete", reason: "unencrypted"});
        expect(decideRecoveryPoint(facts({encryptionOn: false}))).toMatchObject({status: "incomplete", reason: "unencrypted"});
    });
    it("restic is always encrypted; a restic artifact needs a full snapshot id", () => {
        expect(decideRecoveryPoint(facts({encryptionOn: false, artifacts: [art({archive: "restic", ciphertextSha256: null, snapshotId: SHA})]})).status).toBe("pending_verification");
        expect(decideRecoveryPoint(facts({artifacts: [art({archive: "restic", ciphertextSha256: null, snapshotId: "abc"})]}))).toMatchObject({status: "incomplete", reason: "checksum_unavailable"});
    });
    it("no checksum for an archive ⇒ incomplete(checksum_unavailable)", () => {
        expect(decideRecoveryPoint(facts({artifacts: [art({ciphertextSha256: null})]}))).toMatchObject({status: "incomplete", reason: "checksum_unavailable"});
        expect(decideRecoveryPoint(facts({artifacts: [art({ciphertextSha256: "zz"})]}))).toMatchObject({status: "incomplete", reason: "checksum_unavailable"});
    });
    it("one member failed but something was captured ⇒ incomplete(member_failed); nothing captured ⇒ failed(member_failed)", () => {
        expect(decideRecoveryPoint(facts({artifacts: [art(), art({storageStatus: "failed"})]}))).toMatchObject({status: "incomplete", reason: "member_failed"});
        expect(decideRecoveryPoint(facts({artifacts: [art({storageStatus: "failed"}), art({storageStatus: "none"})]}))).toMatchObject({status: "failed", reason: "member_failed", runState: "failed"});
    });
    it("a NULL FK is not present (D32)", () => {
        expect(decideRecoveryPoint(facts({artifacts: [art(), art({hasBackupFk: false})]}))).toMatchObject({status: "incomplete", reason: "member_failed"});
        expect(decideRecoveryPoint(facts({artifacts: [art({hasStorageFk: false})]}))).toMatchObject({status: "failed"});
    });
    it("stuck timeout ⇒ failed(member_timeout), no partial pending RP, even if other artifacts exist", () => {
        expect(decideRecoveryPoint(facts({timedOut: true}))).toMatchObject({status: "failed", reason: "member_timeout", runState: "failed"});
    });
    it("cancelled ⇒ failed(run_cancelled), run state cancelled", () => {
        expect(decideRecoveryPoint(facts({cancelled: true}))).toMatchObject({status: "failed", reason: "run_cancelled", runState: "cancelled", runReason: "cancelled"});
    });
    it("nothing queued ⇒ failed(run_not_started)", () => {
        expect(decideRecoveryPoint(facts({queuedMembers: 0, artifacts: []}))).toMatchObject({status: "failed", reason: "run_not_started", runReason: "nothing_queued"});
    });
    it("consistency level from the captured members", () => {
        expect(consistencyOf([])).toBe("unknown");
        expect(consistencyOf(["postgresql", "sqlite"])).toBe("engine_dump");
        expect(consistencyOf(["files", "docker-volume"])).toBe("crash_consistent_files");
        expect(consistencyOf(["files", "postgresql"])).toBe("mixed");
    });
});
