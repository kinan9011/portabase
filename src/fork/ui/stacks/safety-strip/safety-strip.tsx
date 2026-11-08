import Link from "next/link";
import * as React from "react";
import {fixHref, STRIP_BUCKETS, type SafetyStrip, type StripBucket, type StripItem} from "@/fork/stacks/safety";
import {STRIP} from "@/fork/ui/labels";
import {stackHref} from "@/fork/ui/stacks/format";
import {TONE_MAP} from "@/fork/ui/tone";
import {ToneBadge} from "@/fork/ui/tone-badge";

const S = STRIP;

function Entry({item}: {item: StripItem}) {
    return (
        <li className="flex flex-col gap-1 rounded-lg border p-2 text-sm" data-testid="strip-item" data-stack-id={item.stackId}>
            <Link href={stackHref(item.stackId)} className="font-medium underline underline-offset-4">{item.name}</Link>
            {item.reasons.length > 0 && (
                <ul className="flex flex-col gap-0.5">
                    {item.reasons.map((r) => (
                        <li key={r} className="flex flex-wrap items-baseline gap-x-2" data-reason={r}>
                            <span>{S.reasons[r].label}</span>
                            <Link href={fixHref(r, item.stackId)} className="text-xs font-medium underline underline-offset-4">{S.reasons[r].fix}</Link>
                        </li>
                    ))}
                </ul>
            )}
        </li>
    );
}

function Group({bucket, items, count, extra}: {bucket: StripBucket; items: StripItem[]; count: number; extra?: React.ReactNode}) {
    const meta = S.buckets[bucket];
    const tone = TONE_MAP[meta.tone];
    const id = `strip-${bucket}`;
    return (
        <section aria-labelledby={id} data-testid={`strip-${bucket}`} className={`flex flex-col gap-2 rounded-xl border p-3 ${tone.panel}`}>
            <h3 id={id} className="flex items-center gap-2 font-semibold"><ToneBadge tone={meta.tone}>{meta.label}</ToneBadge><span data-testid={`strip-count-${bucket}`}>{count}</span></h3>
            {count === 0 && !extra ? <p className="text-muted-foreground text-sm">{meta.empty}</p> : (
                <ul className="flex flex-col gap-2">{extra}{items.map((i) => <Entry key={i.stackId} item={i}/>)}</ul>
            )}
        </section>
    );
}

/**
 * "Am I safe?" strip on the Stacks page (§4.6, W13): three groups from the pure mapping in `stacks/safety.ts`, every item with the reason in plain words and a
 * fix link (EU-15). "Agent poll failing" is ONE item per agent listing the affected stacks (CH-22c), inside Needs attention. Nothing here can say Safe for a
 * stack the mapping did not call Safe. Inline text only (no hover), tone + icon + label.
 */
export function SafetyStripView({strip, noChannel = false}: {strip: SafetyStrip; noChannel?: boolean}) {
    const byBucket = (b: StripBucket) => strip.items.filter((i) => i.bucket === b);
    const agentItems = strip.agentIssues.map((a) => (
        <li key={`agent-${a.agentName}`} className="flex flex-col gap-1 rounded-lg border p-2 text-sm" data-testid="strip-agent-issue">
            <span className="font-medium">{S.agentIssue(a.agentName)}</span>
            <span className="text-muted-foreground text-xs">{S.agentIssueBody(a.stacks.length)}</span>
            <ul className="flex flex-wrap gap-x-3">{a.stacks.map((s) => <li key={s.id}><Link href={stackHref(s.id)} className="underline underline-offset-4">{s.name}</Link></li>)}</ul>
            <Link href={fixHref("agent_poll_failing", a.stacks[0]?.id ?? "")} className="w-fit text-xs font-medium underline underline-offset-4">{S.reasons.agent_poll_failing.fix}</Link>
        </li>
    ));
    // the per-stack "agent not answering" reason is shown once, in the agent item — not repeated as N duplicates under every stack
    const attention = byBucket("needs_attention").map((i) => ({...i, reasons: i.reasons.filter((r) => r !== "agent_poll_failing")}));
    return (
        <section aria-labelledby="strip-heading" data-testid="safety-strip" className="flex flex-col gap-3">
            <div>
                <h2 id="strip-heading" className="text-lg font-semibold">{S.heading}</h2>
                <p className="text-muted-foreground text-sm">{S.intro}</p>
                <p className="sr-only" data-testid="strip-summary">{S.countsLabel(strip.counts.safe, strip.counts.needsAttention, strip.counts.notProtected)}</p>
            </div>
            {noChannel && (
                <div role="note" data-testid="strip-no-channel" className={`rounded-lg border p-3 text-sm ${TONE_MAP.warning.panel}`}>
                    <p className={`font-medium ${TONE_MAP.warning.title}`}>{S.noChannel.title}</p>
                    <p className={TONE_MAP.warning.body}>{S.noChannel.body}</p>
                </div>
            )}
            {strip.capped && <p className="text-muted-foreground text-sm" data-testid="strip-capped">{S.capped(strip.items.length, strip.total)}</p>}
            <div className="grid gap-3 md:grid-cols-3">
                {STRIP_BUCKETS.map((b) => (
                    <Group key={b} bucket={b} items={b === "needs_attention" ? attention : byBucket(b)} count={b === "safe" ? strip.counts.safe : b === "needs_attention" ? strip.counts.needsAttention : strip.counts.notProtected} extra={b === "needs_attention" ? (agentItems.length ? agentItems : undefined) : undefined}/>
                ))}
            </div>
        </section>
    );
}
