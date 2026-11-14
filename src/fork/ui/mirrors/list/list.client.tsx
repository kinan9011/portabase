"use client";

import Link from "next/link";
import {useRouter} from "next/navigation";
import * as React from "react";
import {Button} from "@/components/ui/button";
import type {MirrorListRow} from "@/fork/mirror/list-view";
import {DeleteMirrorButton} from "@/fork/ui/mirrors/lifecycle/delete-button.client";
import {MIRRORS, statusText} from "@/fork/ui/mirrors/labels";
import {ago, mirrorActions, type Health} from "@/fork/ui/mirrors/model";
import {PRIMARY_AA} from "@/fork/ui/recovery/style";
import type {Tone} from "@/fork/ui/tone";
import {ToneBadge} from "@/fork/ui/tone-badge";

const L = MIRRORS.list;
const HEALTH_TONE: Record<Health, Tone> = {healthy: "success", degraded: "warning", not_running: "neutral", pending: "active", failed: "danger", unknown: "neutral"};
const STATUS_TONE = (s: string): Tone => (s === "ready" ? "success" : s === "failed" ? "danger" : s === "cancelled" || s === "stopped" ? "neutral" : "active");
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

export type MirrorListProps = {rows: MirrorListRow[]; canManage: boolean; locked: boolean; flagOn: boolean; stopStart?: boolean; now: string};

export function MirrorList({rows, canManage, locked, flagOn, stopStart = false, now}: MirrorListProps) {
    const router = useRouter();
    const at = new Date(now);
    const healthy = rows.filter((r) => r.health === "healthy").length;
    const stopped = rows.filter((r) => r.health === "not_running").length;
    const attention = rows.filter((r) => r.health === "failed" || r.health === "degraded" || r.alert).length;
    return (
        <section aria-labelledby="mirrors-h" className="space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 id="mirrors-h" className="mb-1 text-2xl font-bold">{L.title}</h1>
                    <p className="text-muted-foreground max-w-prose text-sm">{L.intro}</p>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={() => router.refresh()} data-testid="mirrors-reload">{L.reload}</Button>
            </div>
            <p role="note" data-testid="privacy-banner" className="rounded-lg border-2 p-3 text-sm font-medium">{L.banner}</p>
            {rows.length === 0 ? (
                <section aria-labelledby="mirrors-empty-h" data-testid="mirrors-empty" className="flex flex-col items-start gap-2 rounded-xl border border-dashed p-8">
                    <h2 id="mirrors-empty-h" className="text-lg font-semibold">{L.empty.title}</h2>
                    {canManage && <><p className="text-muted-foreground text-sm">{L.empty.manager}</p>
                        <Link href="/dashboard/stacks" className={`${PRIMARY_AA} inline-flex h-9 items-center rounded-md px-4 text-sm font-medium`}>{L.empty.link}</Link></>}
                </section>
            ) : (
                <>
                    <ul aria-label={L.counts.label} data-testid="mirror-counts" className="flex flex-wrap gap-3">
                        {([[L.counts.healthy, healthy, "success"], [L.counts.stopped, stopped, "neutral"], [L.counts.attention, attention, attention > 0 ? "danger" : "neutral"]] as const).map(([label, n, tone]) => (
                            <li key={label} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"><ToneBadge tone={tone}>{label}</ToneBadge><span className="text-lg font-semibold" data-testid="mirror-count">{n}</span></li>
                        ))}
                    </ul>
                    <div role="region" aria-label={L.region} tabIndex={0} className="overflow-x-auto rounded-lg border">
                        <table className="w-full text-left text-sm" data-testid="mirror-table">
                            <thead><tr className="border-b">{(["name", "stack", "runner", "revision", "rp", "status", "access", "actions"] as const).map((k) => <th key={k} scope="col" className="px-3 py-2 font-semibold whitespace-nowrap">{L.cols[k]}</th>)}</tr></thead>
                            <tbody>{rows.map((r) => <Row key={r.id} r={r} at={at} canManage={canManage} locked={locked} flagOn={flagOn} stopStart={stopStart}/>)}</tbody>
                        </table>
                    </div>
                </>
            )}
        </section>
    );
}

function Row({r, at, canManage, locked, flagOn, stopStart}: {r: MirrorListRow; at: Date; canManage: boolean; locked: boolean; flagOn: boolean; stopStart: boolean}) {
    const actions = mirrorActions({status: r.status, hasActiveRevision: r.activeSeq !== null, activeCreation: r.status === "creating", wipeFailed: false}, {manage: canManage, locked, flagOn, stopStart});
    const checked = r.checkedAt && (r.health === "healthy" || r.health === "degraded" || r.health === "not_running") ? ago(r.checkedAt, at) : "";
    const seq = r.activeSeq ?? r.latest?.seq ?? null;
    return (
        <tr data-testid="mirror-row" data-status={r.status} data-health={r.health} className="border-b align-top last:border-0">
            <th scope="row" className="px-3 py-2 font-medium"><Link href={`/dashboard/mirrors/${r.id}`} className="underline underline-offset-4 break-all">{r.name}</Link></th>
            <td className="px-3 py-2"><Link href={`/dashboard/stacks/${r.stack.id}`} className="underline underline-offset-4">{r.stack.name}</Link></td>
            <td className="px-3 py-2 break-all">{r.runnerName}</td>
            <td className="px-3 py-2 whitespace-nowrap">{seq === null ? "—" : `#${seq}`}</td>
            <td className="px-3 py-2 whitespace-nowrap">{r.rpSequence === null ? "—" : L.rp(r.rpSequence, day(r.rpCreatedAt))}</td>
            <td className="space-y-1 px-3 py-2">
                <ToneBadge tone={STATUS_TONE(r.status)} busy={r.status === "creating" || r.status === "deleting"}>{statusText(r.status)}</ToneBadge>
                <p className="flex items-center gap-1.5 text-xs" data-testid="mirror-health"><ToneBadge tone={HEALTH_TONE[r.health]}>{MIRRORS.health.text[r.health]}</ToneBadge>{checked && <span className="text-muted-foreground">{MIRRORS.health.at(checked)}</span>}</p>
                {r.alert && <p className="text-xs" data-testid="mirror-last-failed">{L.lastFailed}</p>}
            </td>
            <td className="px-3 py-2">
                {r.status === "ready" ? <><span className="block text-xs">{L.loopback(r.runnerName)}{r.hostPort !== null ? ` · port ${r.hostPort}` : ""}</span><Link href={`/dashboard/mirrors/${r.id}`} className="text-xs underline underline-offset-4">{L.connect}</Link></> : "—"}
            </td>
            <td className="px-3 py-2">
                <span className="flex flex-wrap items-start gap-2">
                    <Link href={`/dashboard/mirrors/${r.id}`} className="inline-flex h-8 items-center rounded-md border px-3 text-sm">{L.open}<span className="sr-only"> {r.name}</span></Link>
                    <DeleteMirrorButton mirrorId={r.id} name={r.name} runner={r.runnerName} action={actions.delete}/>
                </span>
            </td>
        </tr>
    );
}
