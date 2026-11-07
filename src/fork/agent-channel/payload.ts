import {createCipheriv, createDecipheriv, createHash, randomBytes} from "node:crypto";

/**
 * Per-agent payload confidentiality (ADR-007 D4): AES-256-GCM under the agent's own task key, AAD = `task_id|agent_id|type`.
 * Wire/storage form: base64(nonce(12) ‖ ciphertext ‖ tag(16)). A payload of task A cannot be replayed as task B or for agent C (AAD).
 */
export type PayloadAad = {taskId: string; agentId: string; type: string};
const aad = (a: PayloadAad) => Buffer.from(`${a.taskId}|${a.agentId}|${a.type}`, "utf8");

export function encryptPayload(taskKey: Buffer, a: PayloadAad, plaintext: Buffer): string {
    if (taskKey.length !== 32) throw new Error("task key length");
    const nonce = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", taskKey, nonce);
    c.setAAD(aad(a));
    const ct = Buffer.concat([c.update(plaintext), c.final()]);
    return Buffer.concat([nonce, ct, c.getAuthTag()]).toString("base64");
}

/** Reference decryptor (tests + the dashboard-side round trip); the agent has its own Rust implementation of the same format. */
export function decryptPayload(taskKey: Buffer, a: PayloadAad, b64: string): Buffer {
    const raw = Buffer.from(b64, "base64");
    if (raw.length < 12 + 16) throw new Error("payload too short");
    const d = createDecipheriv("aes-256-gcm", taskKey, raw.subarray(0, 12));
    d.setAAD(aad(a));
    d.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]);
}

export const payloadSha256 = (plaintext: Buffer) => createHash("sha256").update(plaintext).digest("hex");
