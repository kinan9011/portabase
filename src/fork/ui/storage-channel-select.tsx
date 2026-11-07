"use client";

import * as React from "react";
import {Checkbox} from "@/components/ui/checkbox";
import {Label} from "@/components/ui/label";
import {CONFIGURE} from "@/fork/ui/labels";
import {ToneBadge} from "@/fork/ui/tone-badge";

/**
 * Storage-channel selector (W11, D31 controlled copy of the upstream channel picker, rebuilt on Radix `Checkbox`). Shows id-free facts only:
 * name, provider, whether it lives on the dashboard host, and the "Deletable from source host" facet (§4.5; "not checked" fails closed). It never
 * receives a channel's configuration.
 */
const C = CONFIGURE.storage;
export type ChannelOption = {id: string; name: string; provider: string; local: boolean; deletable: "yes" | "no" | "not_checked"};

export function StorageChannelSelect({channels, value, onChange}: {channels: readonly ChannelOption[]; value: readonly string[]; onChange: (ids: string[]) => void}) {
    const base = React.useId();
    if (channels.length === 0) return <p className="text-muted-foreground text-sm" data-testid="channels-none">{C.none}</p>;
    const toggle = (id: string, on: boolean) => onChange(on ? [...new Set([...value, id])] : value.filter((x) => x !== id));
    return (
        <ul aria-label={C.listLabel} className="flex flex-col gap-2" data-testid="channel-list">
            {channels.map((c) => {
                const id = `${base}-${c.id}`;
                return (
                    <li key={c.id} className="flex items-start gap-3 rounded-lg border p-3">
                        <Checkbox id={id} checked={value.includes(c.id)} onCheckedChange={(v) => toggle(c.id, v === true)} aria-describedby={`${id}-facts`} className="mt-0.5"/>
                        <div className="flex min-w-0 flex-col gap-1">
                            <Label htmlFor={id} className="font-medium break-words">{c.name} <span className="text-muted-foreground font-normal">({c.provider})</span></Label>
                            <p id={`${id}-facts`} className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                                {c.local && <ToneBadge tone="warning">{C.local}</ToneBadge>}
                                <span>{C.deletable.label}: {C.deletable[c.deletable]}</span>
                            </p>
                        </div>
                    </li>
                );
            })}
        </ul>
    );
}
