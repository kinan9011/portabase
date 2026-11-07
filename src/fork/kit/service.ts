import {randomBytes} from "node:crypto";
import {eq, isNull, sql} from "drizzle-orm";
import {z} from "zod";
import {forkCan, type ForkPrincipal} from "@/fork/acl";
import {recordAudit} from "@/fork/audit";
import type {ForkDb} from "@/fork/db/handle";
import {forkKit} from "@/fork/db/schema/kit";
import type {KeyProvider} from "@/fork/keys";
import {withForkLock} from "@/fork/locks";
import {assertForkConfigAllowed, ForkLockedError} from "@/fork/mode";
import {checkRate} from "@/fork/net/rate-limit";
import {codesEqual, looksLikeKey, normalizeCode} from "./fingerprint";
import {wrapDigitalKit} from "./digital";
import {buildKit} from "./material";
import {renderPaperKit} from "./paper";
import {checkPassphrase, type PassphraseVerdict} from "./passphrase";
import {verifyPasswordStepUp, type PasswordVerifier} from "./stepup";
import {consumeKitToken, issueKitToken, KIT_TOKEN_TTL_MS} from "./tokens";
import {loadKitSources} from "./sources";
import {rotateKekAndReencrypt} from "@/fork/kek-rotation";
import {watchKit} from "./watch";

/**
 * Recovery kit service (D25/D41, ADR-013 K-8/K-9). System administrator only (`recovery.kit.manage`, instance-wide like every fork configuration, D21),
 * refused while the fork is locked, rate-limited, audited (codes only — NEVER key material, passphrase, kit content or the verification code).
 *   1. `beginKitGeneration`  — step-up (account password) → single-use grants (paper / digital). No secret in the response.
 *   2. `generateKitArtifact` — spends a grant → builds the kit IN MEMORY → records the ISSUE (fingerprint, key ids, type; no key material) → returns the document
 *      once; the route handler streams it `no-store`. Never callable through the API-key / MCP surface (static test).
 *   3. `confirmKitFingerprint` — the operator types the code printed by the offline verifier; compared in constant time with the stored one.
 */
export type KitDeps = {
    db: ForkDb;
    principal: ForkPrincipal | null;
    keys: KeyProvider;
    kekDir?: string;
    now?: () => Date;
    rate?: typeof checkRate;
    assertConfigAllowed?: () => Promise<void>;
    verifyPassword?: PasswordVerifier;
    nonce?: () => string;
};

type Refusal = {ok: false; code: "forbidden" | "locked" | "rate_limited" | "invalid_input" | "step_up_failed" | "no_password" | "token_invalid" | "weak_passphrase" | "no_kit" | "wrong_code" | "code_locked" | "never_type_key" | "stale_kit" | "unavailable"; message: string; retryAfterSeconds?: number; passphrase?: Extract<PassphraseVerdict, {ok: false}>["reason"]};
const refuse = (code: Refusal["code"], message: string, extra: Partial<Refusal> = {}): Refusal => ({ok: false, code, message, ...extra});
const STEP_UP_RATE = {limit: 5, windowMs: 15 * 60_000} as const;
const KIT_RATE = {limit: 20, windowMs: 60_000} as const;
export const KIT_VERIFY_MAX_AGE_DAYS = 365;
export const CODE_ATTEMPTS = 5;
export const CODE_LOCK_MS = 15 * 60_000;

async function authorize(d: KitDeps, action: string): Promise<{userId: string} | Refusal> {
    const p = d.principal;
    const audit = (result: "denied", details: Record<string, unknown>) => recordAudit(d.db, {actorUserId: p?.userId ?? null, action, resourceType: "recovery_kit", result, details, now: d.now?.()});
    if (!p) return refuse("forbidden", "You must be signed in.");
    if (!forkCan({systemRole: p.systemRole ?? null}, "recovery.kit.manage")) { await audit("denied", {reason: "forbidden"}); return refuse("forbidden", "Only a system administrator can manage the recovery kit."); }
    try { await (d.assertConfigAllowed ?? assertForkConfigAllowed)(); }
    catch (e) {
        if (e instanceof ForkLockedError) { await audit("denied", {reason: e.mode === "locked" ? `locked:${e.lockReason ?? "unknown"}` : "mode-off"}); return refuse("locked", e.mode === "locked" ? `Fork configuration is locked (${e.lockReason ?? "see status"}); fix the cause first.` : "Stack Recovery is not enabled."); }
        throw e;
    }
    return {userId: p.userId};
}
const limited = (d: KitDeps, key: string, cfg: {limit: number; windowMs: number}): Refusal | null => {
    const r = (d.rate ?? checkRate)(key, cfg.limit, cfg.windowMs, d.now?.().getTime());
    return r.ok ? null : refuse("rate_limited", `Too many attempts. Try again in ${r.retryAfterSeconds} s.`, {retryAfterSeconds: r.retryAfterSeconds});
};

// ---- 1. step-up ---------------------------------------------------------------------------------------------------------------------------------
const BeginSchema = z.strictObject({types: z.array(z.enum(["paper", "digital"])).min(1).max(2), password: z.string().min(1).max(1024)});
export type BeginResult = {ok: true; tokens: {paper?: string; digital?: string}; expiresInSeconds: number} | Refusal;

export async function beginKitGeneration(d: KitDeps, raw: unknown): Promise<BeginResult> {
    const parsed = BeginSchema.safeParse(raw);
    if (!parsed.success) return refuse("invalid_input", "Choose at least one kit type and enter your password.");
    const a = await authorize(d, "fork.kit.step_up");
    if (!("userId" in a)) return a;
    const rl = limited(d, `${a.userId}:kit-stepup`, STEP_UP_RATE);
    if (rl) { await recordAudit(d.db, {actorUserId: a.userId, action: "fork.kit.step_up", resourceType: "recovery_kit", result: "denied", details: {reason: "rate-limited"}, now: d.now?.()}); return rl; }
    const now = d.now?.() ?? new Date();
    const verdict = await verifyPasswordStepUp(d.db, a.userId, parsed.data.password, d.verifyPassword);
    if (verdict !== "ok") {
        await recordAudit(d.db, {actorUserId: a.userId, action: "fork.kit.step_up", resourceType: "recovery_kit", result: "denied", details: {reason: verdict === "no_password" ? "no-password" : "wrong-password"}, now});
        return verdict === "no_password"
            ? refuse("no_password", "This account has no password, so it cannot confirm its identity for this step. Ask an administrator with a password account.")
            : refuse("step_up_failed", "The password is not correct.");
    }
    const tokens: {paper?: string; digital?: string} = {};
    for (const t of new Set(parsed.data.types)) tokens[t] = await issueKitToken(d.db, a.userId, t, now);
    await recordAudit(d.db, {actorUserId: a.userId, action: "fork.kit.step_up", resourceType: "recovery_kit", result: "success", details: {types: [...new Set(parsed.data.types)]}, now});
    return {ok: true, tokens, expiresInSeconds: KIT_TOKEN_TTL_MS / 1000};
}

// ---- 2. generation -------------------------------------------------------------------------------------------------------------------------------
const GenSchema = z.strictObject({kind: z.enum(["paper", "digital"]), token: z.string().min(20).max(100), passphrase: z.string().max(512).optional(), passphraseConfirm: z.string().max(512).optional()});
export type GenerateResult =
    | {ok: true; kind: "paper"; contentType: "text/html; charset=utf-8"; body: string; nonce: string}
    | {ok: true; kind: "digital"; contentType: "text/plain; charset=utf-8"; body: string; filename: string}
    | Refusal;

export async function generateKitArtifact(d: KitDeps, raw: unknown): Promise<GenerateResult> {
    const parsed = GenSchema.safeParse(raw);
    if (!parsed.success) return refuse("invalid_input", "The request is not valid.");
    const a = await authorize(d, "fork.kit.generate");
    if (!("userId" in a)) return a;
    const rl = limited(d, `${a.userId}:kit-generate`, KIT_RATE);
    if (rl) return rl;
    const {kind, token, passphrase, passphraseConfirm} = parsed.data;
    const now = d.now?.() ?? new Date();
    if (kind === "digital") {
        const v = checkPassphrase(passphrase ?? "", passphraseConfirm);
        if (!v.ok) {
            await recordAudit(d.db, {actorUserId: a.userId, action: "fork.kit.generate", resourceType: "recovery_kit", result: "denied", details: {reason: "weak-passphrase", rule: v.reason, kind}, now});
            return refuse("weak_passphrase", v.reason === "mismatch" ? "The two passphrases are not the same." : "Choose a longer, less guessable passphrase (at least 14 characters with three kinds of characters, or 24 or more).", {passphrase: v.reason});
        }
    }
    // spend the grant only after the cheap checks, so a typo in the passphrase form does not burn it
    if (!(await consumeKitToken(d.db, a.userId, kind, token, now))) {
        await recordAudit(d.db, {actorUserId: a.userId, action: "fork.kit.generate", resourceType: "recovery_kit", result: "denied", details: {reason: "token-invalid", kind}, now});
        return refuse("token_invalid", "This step expired or was already used. Confirm your password again to continue.");
    }
    let sources: Awaited<ReturnType<typeof loadKitSources>>;
    try { sources = await loadKitSources({db: d.db, keys: d.keys, kekDir: d.kekDir, now: () => now}); }
    catch { return refuse("unavailable", "The keys needed for the kit could not be read. Nothing was generated."); }
    const kit = buildKit(sources);

    await withForkLock(d.db, "fork-kit", async (tx) => {
        const t = tx as ForkDb;
        const [cur] = await t.select().from(forkKit).where(isNull(forkKit.supersededAt));
        const sameKeys = cur && cur.fingerprint === sources.liveCode;
        if (cur && sameKeys) {
            const types = [...new Set([...cur.types, kind])];
            await t.update(forkKit).set({types, issuedAt: now, issuedBy: a.userId, kekKids: [...sources.kek.keys.keys()].sort(), signingKid: sources.signingKid}).where(eq(forkKit.id, cur.id));
        } else {
            if (cur) await t.update(forkKit).set({supersededAt: now}).where(eq(forkKit.id, cur.id));
            await t.insert(forkKit).values({fingerprint: sources.liveCode, signingKid: sources.signingKid, kekKids: [...sources.kek.keys.keys()].sort(), types: [kind], status: "issued", issuedAt: now, issuedBy: a.userId, epoch: (cur?.epoch ?? 0) + 1});
        }
        await recordAudit(t, {actorUserId: a.userId, action: "fork.kit.generate", resourceType: "recovery_kit", result: "success", details: {kind, signingKid: sources.signingKid, kekCount: sources.kek.keys.size, channels: sources.channels.length, reissued: !!cur && !sameKeys}, now});
    });

    if (kind === "paper") {
        const nonce = (d.nonce ?? (() => randomBytes(16).toString("base64")))();
        return {ok: true, kind, contentType: "text/html; charset=utf-8", body: renderPaperKit(kit, {nonce}), nonce};
    }
    return {ok: true, kind, contentType: "text/plain; charset=utf-8", body: wrapDigitalKit(kit, passphrase as string), filename: `portabase-recovery-kit-${now.toISOString().slice(0, 10)}.pbkit`};
}

// ---- 3. fingerprint entry (D41) ---------------------------------------------------------------------------------------------------------------
const ConfirmSchema = z.strictObject({fingerprint: z.string().max(200), type: z.enum(["paper", "digital"])});
export type ConfirmResult = {ok: true; verifiedAt: string; type: "paper" | "digital"} | Refusal;

export async function confirmKitFingerprint(d: KitDeps, raw: unknown): Promise<ConfirmResult> {
    const parsed = ConfirmSchema.safeParse(raw);
    if (!parsed.success) return refuse("invalid_input", "Enter the code printed by the verifier and choose the kit type.");
    const a = await authorize(d, "fork.kit.confirm");
    if (!("userId" in a)) return a;
    const rl = limited(d, `${a.userId}:kit-confirm`, KIT_RATE);
    if (rl) return rl;
    const now = d.now?.() ?? new Date();
    const code = normalizeCode(parsed.data.fingerprint);
    if (!code) {
        // NEVER echo the input; a key typed here is a mistake the operator must not repeat
        await recordAudit(d.db, {actorUserId: a.userId, action: "fork.kit.confirm", resourceType: "recovery_kit", result: "denied", details: {reason: looksLikeKey(parsed.data.fingerprint) ? "key-like-input" : "bad-format"}, now});
        return looksLikeKey(parsed.data.fingerprint)
            ? refuse("never_type_key", "That looks like a key. Never type a key into the dashboard — enter only the short verification code (20 characters) that the verifier prints.")
            : refuse("invalid_input", "The verification code has 20 letters and digits, like 1A2B-3C4D-5E6F-7A8B-9C0D.");
    }
    return withForkLock(d.db, "fork-kit", async (tx): Promise<ConfirmResult> => {
        const t = tx as ForkDb;
        const [cur] = await t.select().from(forkKit).where(isNull(forkKit.supersededAt));
        if (!cur) return refuse("no_kit", "No recovery kit has been generated yet.");
        if (cur.status === "stale") return refuse("stale_kit", "The backup keys changed after this kit was made, so it no longer matches. Generate a new kit, verify it, then enter its code.");
        if (cur.lockedUntil && cur.lockedUntil.getTime() > now.getTime()) return refuse("code_locked", "Too many wrong codes. Try again later.", {retryAfterSeconds: Math.ceil((cur.lockedUntil.getTime() - now.getTime()) / 1000)});
        if (!codesEqual(code, cur.fingerprint)) {
            const attempts = cur.failedAttempts + 1;
            const lock = attempts >= CODE_ATTEMPTS;
            await t.update(forkKit).set({failedAttempts: lock ? 0 : attempts, lockedUntil: lock ? new Date(now.getTime() + CODE_LOCK_MS) : cur.lockedUntil}).where(eq(forkKit.id, cur.id));
            await recordAudit(t, {actorUserId: a.userId, action: "fork.kit.confirm", resourceType: "recovery_kit", result: "denied", details: {reason: "wrong-code", locked: lock}, now});
            return lock ? refuse("code_locked", "Too many wrong codes. Try again in 15 minutes.", {retryAfterSeconds: CODE_LOCK_MS / 1000}) : refuse("wrong_code", "That code does not match this kit. Check that you verified the newest kit.");
        }
        await t.update(forkKit).set({status: "verified", verifiedAt: now, verifiedType: parsed.data.type, failedAttempts: 0, lockedUntil: null, staleReason: null}).where(eq(forkKit.id, cur.id));
        await recordAudit(t, {actorUserId: a.userId, action: "fork.kit.confirm", resourceType: "recovery_kit", result: "success", details: {type: parsed.data.type, signingKid: cur.signingKid}, now});
        return {ok: true, verifiedAt: now.toISOString(), type: parsed.data.type};
    });
}

// ---- read model (no secrets, no code) -----------------------------------------------------------------------------------------------------------
export type KitView = {
    state: "none" | "issued" | "verified" | "stale";
    types: ("paper" | "digital")[];
    issuedAt: string | null;
    verifiedAt: string | null;
    verifiedType: "paper" | "digital" | null;
    /** verification expires after 12 months (§4.2) */
    reverifyDueAt: string | null;
    staleReason: string | null;
    locked: boolean;
};
export const KIT_NONE: KitView = {state: "none", types: [], issuedAt: null, verifiedAt: null, verifiedType: null, reverifyDueAt: null, staleReason: null, locked: false};

export async function loadKitView(db: ForkDb, now = new Date()): Promise<KitView> {
    const [k] = await db.select().from(forkKit).where(isNull(forkKit.supersededAt));
    if (!k) return KIT_NONE;
    const due = k.verifiedAt ? new Date(k.verifiedAt.getTime() + KIT_VERIFY_MAX_AGE_DAYS * 86_400_000) : null;
    const expired = k.status === "verified" && due !== null && due.getTime() <= now.getTime();
    return {
        state: expired ? "stale" : (k.status as KitView["state"]), types: k.types as KitView["types"], issuedAt: k.issuedAt.toISOString(), verifiedAt: k.verifiedAt?.toISOString() ?? null,
        verifiedType: (k.verifiedType as KitView["verifiedType"]) ?? null, reverifyDueAt: due?.toISOString() ?? null, staleReason: expired ? "expired" : k.staleReason, locked: !!k.lockedUntil && k.lockedUntil.getTime() > now.getTime(),
    };
}

/** The ONE input of `protection.kitVerified` (D41): a verified, current, unexpired kit. SQL only — no key is touched on a page load. */
export async function isKitVerified(db: ForkDb, now = new Date()): Promise<boolean> {
    const r = await db.execute(sql`select 1 from fork_kit where superseded_at is null and status = 'verified' and verified_at is not null and verified_at > ${new Date(now.getTime() - KIT_VERIFY_MAX_AGE_DAYS * 86_400_000)} limit 1`);
    return r.rows.length === 1;
}

// ---- 4. KEK rotation (ADR-013 §4) — same gates as generation; the kit goes stale at once ----------------------------------------------------------
const RotateSchema = z.strictObject({password: z.string().min(1).max(1024)});
export type RotateKekResult = {ok: true; moved: number; failed: number; kitState: string} | Refusal;

export async function rotateKek(d: KitDeps, raw: unknown): Promise<RotateKekResult> {
    const parsed = RotateSchema.safeParse(raw);
    if (!parsed.success) return refuse("invalid_input", "Enter your password.");
    const a = await authorize(d, "fork.kek.rotate");
    if (!("userId" in a)) return a;
    const rl = limited(d, `${a.userId}:kit-stepup`, STEP_UP_RATE);
    if (rl) return rl;
    const now = d.now?.() ?? new Date();
    const verdict = await verifyPasswordStepUp(d.db, a.userId, parsed.data.password, d.verifyPassword);
    if (verdict !== "ok") {
        await recordAudit(d.db, {actorUserId: a.userId, action: "fork.kek.rotate", resourceType: "fork_kek", result: "denied", details: {reason: verdict === "no_password" ? "no-password" : "wrong-password"}, now});
        return verdict === "no_password" ? refuse("no_password", "This account has no password, so it cannot confirm its identity for this step.") : refuse("step_up_failed", "The password is not correct.");
    }
    const r = await rotateKekAndReencrypt(d.db, d.kekDir, {actorUserId: a.userId, now});
    const w = await watchKit({db: d.db, keys: d.keys, kekDir: d.kekDir, now: () => now, unverifiedHours: 24}).catch(() => null);
    return {ok: true, moved: r.moved, failed: r.failed, kitState: w?.state ?? "unknown"};
}
