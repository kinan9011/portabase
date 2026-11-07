/**
 * Digital-kit passphrase policy (§4.2 "minimum strength enforced", server-side; the form only mirrors it). Closed reason codes, never the passphrase.
 * Rule: ≥ 14 characters AND (≥ 3 of lower/upper/digit/symbol OR ≥ 24 characters), not a repeated unit, not an obvious word.
 */
export type PassphraseVerdict = {ok: true} | {ok: false; reason: "too_short" | "too_simple" | "repetitive" | "obvious" | "too_long" | "mismatch"};
export const PASSPHRASE_MIN = 14;
export const PASSPHRASE_MAX = 256;

export function checkPassphrase(p: string, confirm?: string): PassphraseVerdict {
    if (confirm !== undefined && p !== confirm) return {ok: false, reason: "mismatch"};
    if (p.length > PASSPHRASE_MAX) return {ok: false, reason: "too_long"};
    if (p.length < PASSPHRASE_MIN) return {ok: false, reason: "too_short"};
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
    if (classes < 3 && p.length < 24) return {ok: false, reason: "too_simple"};
    if (new Set(p.toLowerCase()).size < 6) return {ok: false, reason: "repetitive"};
    for (let unit = 1; unit <= 4; unit++) if (p.length % unit === 0 && p === p.slice(0, unit).repeat(p.length / unit)) return {ok: false, reason: "repetitive"};
    if (/(password|passw0rd|portabase|recoverykit|qwerty|letmein|1234567)/i.test(p)) return {ok: false, reason: "obvious"};
    return {ok: true};
}
