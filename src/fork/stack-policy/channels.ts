/**
 * Storage-channel rules of the activation (REVISED-PLAN §4.5, W11). Pure: the form and the server action use the SAME functions;
 * the server is the authority.
 *
 * - `local` channels (restic REST/tus on the dashboard host) are lost with the dashboard host: they never count as a DR source.
 * - "Deletable from source host" has no data source before F4 (W14P): every channel reads `not_checked`, which FAILS CLOSED
 *   (facet "Not protected against host compromise", W09). A verified F4 copy cannot be recorded yet, so the `local + verified F4 copy`
 *   alternative of §4.5 is not satisfiable in this release: `local`-only is always refused.
 */
export type ChannelFacts = {id: string; provider: string};
export type ChannelRuleResult = {ok: true} | {ok: false; reason: "no_channel_selected" | "local_only_channels"};
export const isLocalProvider = (provider: string) => provider === "local";

export function checkChannelRule(selected: readonly ChannelFacts[]): ChannelRuleResult {
    if (selected.length === 0) return {ok: false, reason: "no_channel_selected"};
    if (!selected.some((c) => !isLocalProvider(c.provider))) return {ok: false, reason: "local_only_channels"};
    return {ok: true};
}

export type DeletableFacet = "yes" | "no" | "not_checked";
/** No F4 check exists yet (W14P): always "not checked". Kept as a function so the callers do not hard-code the claim. */
export const deletableFacet = (_c: ChannelFacts): DeletableFacet => "not_checked";
