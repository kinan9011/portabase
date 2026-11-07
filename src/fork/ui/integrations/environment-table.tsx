"use client";

import * as React from "react";
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from "@/components/ui/select";
import {Switch} from "@/components/ui/switch";
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from "@/components/ui/table";
import type {IntegrationsEnvironment, IntegrationsView} from "@/fork/arcane/integrations-view";
import {DangerousActionConfirm} from "@/fork/ui/dangerous-action-confirm";
import type {EnvVars} from "@/fork/ui/integrations/use-integrations-actions";
import {AGENT_STATUS_LABELS, ENVIRONMENT_COPY, HOST_ROLE_LABELS, SYNC_ERROR_LABELS} from "@/fork/ui/labels";
import {TONE_MAP, type Tone} from "@/fork/ui/tone";
import {ToneIcon} from "@/fork/ui/tone-badge";

const NO_AGENT = "__none__";
const AGENT_TONE: Record<"online" | "degraded" | "offline", Tone> = {online: "success", degraded: "warning", offline: "danger"};
const fmt = (iso: string | null) => (iso ? `${new Date(iso).toLocaleString("en-US", {dateStyle: "medium", timeStyle: "short", timeZone: "UTC"})} UTC` : ENVIRONMENT_COPY.notSynced);

/** What the last sync of this environment found — only from persisted facts (summary + status), nothing guessed. */
export function SyncCell({e}: {e: IntegrationsEnvironment}) {
    const sum = e.lastSyncSummary;
    const gone = e.lastSyncStatus === "error" && e.lastSyncErrorClass === "not_found";
    return (
        <div data-testid="sync-cell">
            <div>{fmt(e.lastSyncAt)}{e.lastSyncStatus && e.lastSyncStatus !== "ok" ? ` · ${e.lastSyncStatus}` : ""}</div>
            {e.lastSyncStatus === "ok" && sum && <div className="text-muted-foreground text-xs">{sum.stacks_found} stack{sum.stacks_found === 1 ? "" : "s"}{sum.stacks_new + sum.stacks_changed > 0 ? `, ${sum.stacks_new + sum.stacks_changed} new or changed` : ", unchanged"} · {Math.max(1, Math.round(sum.duration_ms / 1000))} s</div>}
            {e.lastSyncStatus && e.lastSyncStatus !== "ok" && <div role="note" className={`mt-0.5 text-xs ${TONE_MAP[e.lastSyncStatus === "error" ? "danger" : "warning"].title}`}>{gone ? ENVIRONMENT_COPY.gone : SYNC_ERROR_LABELS[e.lastSyncErrorClass ?? ""] ?? "Sync problem"}{!gone && sum && sum.errors.length > 1 ? ` (+${sum.errors.length - 1} more)` : ""}</div>}
        </div>
    );
}

export function AgentStatus({status}: {status: IntegrationsEnvironment["agentStatus"]}) {
    if (!status) return <span data-testid="agent-status" className="text-muted-foreground">{AGENT_STATUS_LABELS.none}</span>;
    const tone = AGENT_TONE[status];
    return <span data-testid="agent-status" className={`inline-flex items-center gap-1.5 text-sm ${TONE_MAP[tone].title}`}><ToneIcon tone={tone}/>{AGENT_STATUS_LABELS[status]}</span>;
}

/**
 * Environment settings. Controls are `aria-disabled` (still focusable) with ONE visible reason above the table when
 * configuration is locked (§8.2 rule 10); every change is a real server action and the row re-renders from server state.
 * `host_role` → `test` asks for confirmation (D44: production data may be copied to a test host).
 */
export function EnvironmentTable({view, lockedReason, busyId, onChange}: {view: IntegrationsView; lockedReason: string | null; busyId: string | null; onChange: (v: EnvVars) => void}) {
    const [pendingRole, setPendingRole] = React.useState<{env: IntegrationsEnvironment} | null>(null);
    const pendingRoleName = React.useRef("");
    if (pendingRole) pendingRoleName.current = pendingRole.env.name;
    const locked = !!lockedReason;
    const reasonId = React.useId();
    return (
        <section aria-labelledby="env-heading" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h2 id="env-heading" className="text-lg font-semibold">Environments</h2>
                <p className="text-muted-foreground text-sm">{ENVIRONMENT_COPY.discoveryHelp}</p>
            </div>
            {locked && <p id={reasonId} className="text-sm font-medium">{lockedReason}</p>}
            {view.environments.length === 0 ? (
                <p className="text-muted-foreground rounded-lg border p-6 text-sm">No environment found yet. Run Test connection: the key must cover at least one Arcane environment.</p>
            ) : (
                <div className="overflow-x-auto rounded-lg border">
                    <Table>
                        <caption className="sr-only">Arcane environments with discovery, Portabase agent and host role settings</caption>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Environment</TableHead><TableHead>Portabase agent</TableHead><TableHead>Last sync</TableHead><TableHead>Stacks found / backed up</TableHead><TableHead>Host role</TableHead><TableHead className="text-right">Discovery</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {view.environments.map((e) => {
                                const busy = busyId === e.id;
                                const block = locked || busy;
                                return (
                                    <TableRow key={e.id} aria-busy={busy || undefined}>
                                        <TableCell><div className="font-medium">{e.name}</div><div className="text-muted-foreground font-mono text-xs">id {e.externalId}</div></TableCell>
                                        <TableCell>
                                            <div className="flex flex-col gap-1.5">
                                                <Select value={e.agentId ?? NO_AGENT} open={block ? false : undefined} onValueChange={(v) => !block && onChange({environmentId: e.id, agentId: v === NO_AGENT ? null : v})}>
                                                    <SelectTrigger aria-label={`Portabase agent for ${e.name}`} aria-disabled={block || undefined} aria-describedby={locked ? reasonId : undefined} className="w-48"><SelectValue/></SelectTrigger>
                                                    <SelectContent>
                                                        <SelectItem value={NO_AGENT}>{AGENT_STATUS_LABELS.none}</SelectItem>
                                                        {view.agents.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
                                                        {e.agentId && !view.agents.some((a) => a.id === e.agentId) && <SelectItem value={e.agentId}>{e.agentName ?? "Unavailable agent"}</SelectItem>}
                                                    </SelectContent>
                                                </Select>
                                                <AgentStatus status={e.agentStatus}/>
                                            </div>
                                        </TableCell>
                                        <TableCell className="text-sm whitespace-normal"><SyncCell e={e}/></TableCell>
                                        <TableCell className="whitespace-normal">
                                            <span data-testid="stack-counts">{e.stacks.found} found · {e.stacks.protectedCount} protected</span>
                                            {e.stacks.stale > 0 && <span role="note" className={`block text-xs ${TONE_MAP.warning.title}`}>{ENVIRONMENT_COPY.stale}</span>}
                                        </TableCell>
                                        <TableCell className="min-w-48 whitespace-normal">
                                            <Select value={e.hostRole} open={block ? false : undefined} onValueChange={(v) => { if (block || v === e.hostRole) return; if (v === "test") setPendingRole({env: e}); else onChange({environmentId: e.id, hostRole: v as "production" | "test"}); }}>
                                                <SelectTrigger aria-label={`Host role for ${e.name}`} aria-disabled={block || undefined} aria-describedby={locked ? reasonId : undefined} className="w-40"><SelectValue/></SelectTrigger>
                                                <SelectContent>{(Object.keys(HOST_ROLE_LABELS) as (keyof typeof HOST_ROLE_LABELS)[]).map((r) => <SelectItem key={r} value={r}>{HOST_ROLE_LABELS[r].label}</SelectItem>)}</SelectContent>
                                            </Select>
                                            <span className="text-muted-foreground mt-1 block max-w-56 text-xs">{HOST_ROLE_LABELS[e.hostRole].description}</span>
                                        </TableCell>
                                        <TableCell className="text-right whitespace-normal">
                                            <Switch checked={e.enabled} aria-label={`Discovery for ${e.name}`} aria-disabled={block || undefined} aria-describedby={locked ? reasonId : undefined} onCheckedChange={(v) => { if (!block) onChange({environmentId: e.id, enabled: v}); }}/>
                                            <span className="text-muted-foreground mt-1 block text-xs">{e.enabled ? "Enabled" : "Disabled"}</span>
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </div>
            )}
            <DangerousActionConfirm
                open={!!pendingRole}
                onOpenChange={(o) => { if (!o) setPendingRole(null); }}
                title={`Mark ${pendingRole?.env.name ?? "this environment"} as a test host?`}
                description={<><p>{HOST_ROLE_LABELS.test.description}</p><p>Only mark a host you control and are willing to receive copies of production data for test restores.</p></>}
                confirmLabel="Mark as test host"
                returnFocus={() => document.querySelector<HTMLElement>(`[aria-label="Host role for ${pendingRoleName.current}"]`)}
                onConfirm={() => { if (pendingRole) onChange({environmentId: pendingRole.env.id, hostRole: "test"}); setPendingRole(null); }}
            />
        </section>
    );
}
