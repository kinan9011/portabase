import {describe, expect, it} from "vitest";
import {consistencyOf, decideRecoveryPoint, type RunFacts} from "@/fork/recovery-point/decide";
import {ManifestV1} from "@/fork/manifest/schema";
import {verifyManifestBundle} from "@/fork/manifest/verify";
import {signedFixture} from "@/fork/__tests__/w14-fixtures";

const art = {hasBackupFk: true, hasStorageFk: true, storageStatus: "success" as const, archive: "archive" as const, encrypted: true, ciphertextSha256: "a".repeat(64), snapshotId: null};
const facts = (over: Partial<RunFacts> = {}): RunFacts => ({cancelled: false, timedOut: false, queuedMembers: 1, validatorComplete: true, encryptionOn: true, artifacts: [art], ...over});

describe("W17b recovery-point honesty", () => {
    it("consistencyOf: 'stopped' only with an intact window AND a file/volume artifact", () => {
        expect(consistencyOf(["files", "docker-volume"], {stoppedWindow: true})).toBe("stopped");
        expect(consistencyOf(["files", "postgresql"], {stoppedWindow: true})).toBe("stopped");
        expect(consistencyOf(["files"], {stoppedWindow: false})).toBe("crash_consistent_files");
        expect(consistencyOf(["files"])).toBe("crash_consistent_files");
        expect(consistencyOf(["postgresql"], {stoppedWindow: true})).toBe("engine_dump");
        expect(consistencyOf([], {stoppedWindow: true})).toBe("unknown");
        expect(consistencyOf(["files", "postgresql"])).toBe("mixed");
    });
    it("unconfirmed ⇒ incomplete/quiesce_unconfirmed — never pending_verification (m3: treating it as confirmed fails here)", () => {
        const d = decideRecoveryPoint(facts({quiesce: "unconfirmed"}));
        expect(d).toEqual({status: "incomplete", reason: "quiesce_unconfirmed", runState: "incomplete", runReason: null});
        expect(decideRecoveryPoint(facts({quiesce: "confirmed"})).status).toBe("pending_verification");
        expect(decideRecoveryPoint(facts({quiesce: "none"})).status).toBe("pending_verification");
        expect(decideRecoveryPoint(facts()).status).toBe("pending_verification");
    });
    it("precedence: failures and missing artifacts still win over unconfirmed; unconfirmed beats only the validator check", () => {
        expect(decideRecoveryPoint(facts({quiesce: "unconfirmed", cancelled: true})).reason).toBe("run_cancelled");
        expect(decideRecoveryPoint(facts({quiesce: "unconfirmed", artifacts: [art, {...art, storageStatus: "failed"}]})).reason).toBe("member_failed");
        expect(decideRecoveryPoint(facts({quiesce: "unconfirmed", validatorComplete: false})).reason).toBe("quiesce_unconfirmed");
        expect(decideRecoveryPoint(facts({quiesce: "unconfirmed", encryptionOn: false})).reason).toBe("unencrypted");
    });
    it("the manifest accepts, signs and re-verifies consistency_level 'stopped' (manifest_version stays 1); an unknown level is refused", () => {
        const f = signedFixture({rp: {consistencyLevel: "stopped"}});
        expect(f.manifest.manifest_version).toBe(1);
        expect(f.manifest.rp.consistency_level).toBe("stopped"); // not silently mapped to "unknown"
        const v = verifyManifestBundle({json: f.signed.json, sig: f.signed.sig}, f.anchors, {stackId: f.rp.stackId, rpId: f.rp.id, sequence: f.rp.sequence});
        expect(v.ok).toBe(true);
        if (v.ok) expect(v.manifest.rp.consistency_level).toBe("stopped");
        expect(ManifestV1.shape.rp.shape.consistency_level.safeParse("frozen").success).toBe(false);
    });
});
