import {sql} from "drizzle-orm";
import type {ForkDb} from "@/fork/db/handle";

/**
 * Step-up authentication for kit generation / KEK rotation (D21, SEC-10): the signed-in admin must re-enter their ACCOUNT PASSWORD, verified server-side against the
 * credential account hash with better-auth's own verifier (scrypt). A session cookie alone is never enough. Accounts without a password (SSO / passkey only)
 * are refused with a plain reason — recorded limitation (ADR-013 §9). The password is never logged, audited or returned; failures are generic.
 */
export type StepUpResult = "ok" | "wrong" | "no_password";
export type PasswordVerifier = (a: {hash: string; password: string}) => Promise<boolean>;

const defaultVerifier: PasswordVerifier = async (a) => (await import("better-auth/crypto")).verifyPassword(a);

export async function verifyPasswordStepUp(db: ForkDb, userId: string, password: string, verify: PasswordVerifier = defaultVerifier): Promise<StepUpResult> {
    if (typeof password !== "string" || password.length === 0 || password.length > 1024) return "wrong";
    const r = await db.execute(sql`select password from account where user_id = ${userId} and provider_id = 'credential' and password is not null limit 1`);
    const row = r.rows[0] as {password: string} | undefined;
    if (!row) return "no_password";
    try { return (await verify({hash: row.password, password})) ? "ok" : "wrong"; } catch { return "wrong"; }
}
