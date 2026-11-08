"use client";

import {useRouter} from "next/navigation";
import * as React from "react";
import {Button} from "@/components/ui/button";
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from "@/components/ui/dialog";
import {Label} from "@/components/ui/label";
import {Textarea} from "@/components/ui/textarea";
import {
    enqueueAgentTaskAction, enrolAgentAction, pinDashboardKeyAction, requestAgentCredentialRotationAction, revokeAgentEnrollmentAction, setAgentChannelEnabledAction, unpinDashboardKeyAction,
} from "@/fork/actions/agent-channel.action";
import type {AgentChannelRow, AgentChannelView} from "@/fork/agent-channel/view";
import type {TransportVerdict} from "@/fork/agent-channel/transport-policy";
import {DangerousActionConfirm} from "@/fork/ui/dangerous-action-confirm";
import {ReasonButton} from "@/fork/ui/disabled-reason";
import {SecretInput, type SecretHandle} from "@/fork/ui/secret-input";
import {ToneBadge} from "@/fork/ui/tone-badge";
import {AGENT_CHANNEL as L} from "@/fork/ui/agent-channel/labels";
import {PRIMARY_AA} from "@/fork/ui/recovery/style";

/**
 * Agent channel admin page body (W15b). Every control calls a real server action (CSRF = Next's origin check; the services re-check system admin,
 * lock state, rate limit, password step-up, https and audit). Secret handling:
 *  - the account password lives only in an uncontrolled `SecretInput` and is read once per action;
 *  - the enrolment bundle exists only in the local state of the open dialog: closing it sets the state to `null`; it never goes into a URL, a cache,
 *    browser storage or any log. The credential rotation is a signed task: no credential is ever shown for it;
 *  - nothing here receives a stored credential — the page's view model has none (strict DTO).
 */
type Bundle = {bundle: string; fingerprint: string; insecureLab: boolean; agentName: string};
type Msg = {kind: "ok" | "error"; text: string};
type Reply = {ok: boolean; code?: string} & Record<string, unknown>;
const when = (iso: string | null) => (iso ? new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC" : L.fields.never);

export function AgentChannelPanel({view, lockedReason, transport}: {view: AgentChannelView; lockedReason: string | null; transport: TransportVerdict}) {
    const [bundle, setBundle] = React.useState<Bundle | null>(null);
    const router = useRouter();
    const closeBundle = () => { setBundle(null); router.refresh(); };
    const transportReason = transport.ok ? null : transport.code === "insecure_transport" ? L.needsHttps : L.invalidUrl;
    return (
        <div className="flex flex-col gap-4">
            {lockedReason && <p role="status" className="text-sm">{lockedReason}</p>}
            {transportReason && <p role="status" className="text-sm" data-testid="transport-reason">{transportReason}</p>}
            {view.agents.length === 0 && <p className="text-sm">{L.page.empty}</p>}
            <ul className="flex flex-col gap-4">
                {view.agents.map((a) => (
                    <li key={a.id}><AgentCard agent={a} signingKid={view.signingKid} blockedReason={lockedReason ?? transportReason} onBundle={setBundle}/></li>
                ))}
            </ul>
            <Dialog open={bundle !== null} onOpenChange={(o) => { if (!o) closeBundle(); }}>
                <DialogContent preventOutsideClose>
                    {bundle && <BundleBody b={bundle} onClose={closeBundle}/>}
                </DialogContent>
            </Dialog>
        </div>
    );
}

function BundleBody({b, onClose}: {b: Bundle; onClose: () => void}) {
    const id = React.useId();
    function download() {
        const url = URL.createObjectURL(new Blob([b.bundle], {type: "text/plain"}));
        const a = document.createElement("a");
        a.href = url; a.download = `agent-channel-${b.agentName.replace(/[^A-Za-z0-9_-]/g, "_")}.bundle`; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }
    return (
        <>
            <DialogHeader>
                <DialogTitle>{L.bundle.title}</DialogTitle>
                <DialogDescription>{L.bundle.warning}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
                <Label htmlFor={id}>{L.bundle.label}</Label>
                <Textarea id={id} readOnly value={b.bundle} rows={5} spellCheck={false} className="font-mono text-xs" data-testid="bundle-text"/>
            </div>
            <p className="text-sm">{L.bundle.fingerprint}: <code className="break-all text-xs" data-testid="bundle-fingerprint">{b.fingerprint}</code></p>
            {b.insecureLab && <p className="text-sm">{L.bundle.insecureLab}</p>}
            <ol className="list-decimal pl-5 text-sm">{L.bundle.steps.map((s) => <li key={s}>{s}</li>)}</ol>
            <DialogFooter>
                <Button type="button" variant="outline" onClick={download}>{L.bundle.download}</Button>
                <Button className={PRIMARY_AA} type="button" onClick={onClose}>{L.actions.close}</Button>
            </DialogFooter>
        </>
    );
}

function AgentCard({agent: a, signingKid, blockedReason, onBundle}: {agent: AgentChannelRow; signingKid: string | null; blockedReason: string | null; onBundle: (b: Bundle) => void}) {
    const router = useRouter();
    const pw = React.useRef<SecretHandle>(null);
    const pemId = React.useId();
    const [pem, setPem] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const [msg, setMsg] = React.useState<Msg | null>(null);
    const [confirm, setConfirm] = React.useState<null | {kind: "disable" | "reenroll" | "revoke" | "unpin"; kid?: string}>(null);
    const err = (c: string | undefined) => setMsg({kind: "error", text: L.errors[c ?? "invalid_input"] ?? L.errors.invalid_input});

    const generic = blockedReason;
    const enrolledReason = a.enrolled ? (a.revoked ? L.revoked : null) : L.notEnrolled;
    const maintReason = enrolledReason ?? (!a.enabled ? L.disabledAgent : !a.canMaint ? L.needsCapability : null);
    const reason = (specific: string | null) => generic ?? specific;

    /** Runs one server action; `ok` replies refresh the page data, refusals show their message. Never claims success on a refusal. */
    async function run(call: (password: string | undefined) => Promise<{data?: unknown} | undefined>, opts: {needsPassword: boolean; okText?: string; onOk?: (d: Reply) => void}) {
        if (busy) return;
        const password = opts.needsPassword ? pw.current?.take() : undefined;
        if (opts.needsPassword && !password) return err("step_up_failed");
        setBusy(true); setMsg(null);
        let d: Reply | undefined;
        try { d = (await call(password))?.data as Reply | undefined; } catch { d = undefined; }
        setBusy(false);
        if (d && d.ok) { opts.onOk?.(d); if (opts.okText) setMsg({kind: "ok", text: opts.okText}); router.refresh(); } else err(d?.code);
    }
    const enrol = (reenroll: boolean) => run((password) => enrolAgentAction({agentId: a.id, password, ...(reenroll ? {reenroll: true} : {})}), {
        needsPassword: true,
        onOk: (d) => onBundle({bundle: String(d.bundle), fingerprint: String(d.pinFingerprint), insecureLab: Boolean(d.insecureLab), agentName: a.name}),
    });
    const rotate = () => run((password) => requestAgentCredentialRotationAction({agentId: a.id, password}), {needsPassword: true, okText: L.queued(L.taskTypes.rotate_credential)});
    const pin = () => run((password) => pinDashboardKeyAction({agentId: a.id, password, pem}), {needsPassword: true, onOk: (d) => { setPem(""); setMsg({kind: "ok", text: L.pinForm.shown(String(d.kid))}); }});
    const unpin = (kid: string) => run((password) => unpinDashboardKeyAction({agentId: a.id, password, kid}), {needsPassword: true, okText: L.queued(L.taskTypes.pin_revoke)});
    const revoke = () => run(() => revokeAgentEnrollmentAction({agentId: a.id}), {needsPassword: false, okText: L.done});
    const toggle = (enabled: boolean) => run(() => setAgentChannelEnabledAction({agentId: a.id, enabled}), {needsPassword: false, okText: L.done});
    const test = () => run(() => enqueueAgentTaskAction({agentId: a.id, type: "noop", payload: {echo: "ui-check"}}), {needsPassword: false, okText: L.queued(L.taskTypes.noop)});

    const headingId = `agent-${a.id}`;
    const rotationBadge = a.rotation === "pending" ? L.badges.rotationPending : a.rotation === "overlap" ? L.badges.rotationOverlap : null;
    return (
        <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-xl border p-4" data-testid="agent-card" data-agent-id={a.id}>
            <div className="flex flex-wrap items-center gap-2">
                <h2 id={headingId} className="font-semibold">{a.name}</h2>
                {!a.enrolled && <ToneBadge tone="neutral">{L.badges.notEnrolled}</ToneBadge>}
                {a.enrolled && a.revoked && <ToneBadge tone="danger">{L.badges.revoked}</ToneBadge>}
                {a.enrolled && !a.revoked && <ToneBadge tone="success">{L.badges.enrolled}</ToneBadge>}
                {a.enrolled && !a.revoked && <ToneBadge tone={a.enabled ? "success" : "warning"}>{a.enabled ? L.badges.enabled : L.badges.disabled}</ToneBadge>}
                {rotationBadge && <ToneBadge tone="active" busy>{rotationBadge}</ToneBadge>}
            </div>

            {a.enrolled && (
                <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
                    <dt className="text-muted-foreground">{L.fields.lastSeen}</dt><dd>{when(a.lastSeenAt)}</dd>
                    <dt className="text-muted-foreground">{L.fields.enrolledAt}</dt><dd>{when(a.enrolledAt)}</dd>
                    <dt className="text-muted-foreground">{L.fields.capabilities}</dt><dd>{a.capabilities.length ? a.capabilities.join(", ") : L.fields.none}</dd>
                    <dt className="text-muted-foreground">{L.fields.fingerprint}</dt><dd className="break-all font-mono text-xs">{a.pinFingerprint}</dd>
                </dl>
            )}

            <div role="status" aria-live="polite" className="min-h-5 text-sm" data-testid="agent-status">{msg && <span className={msg.kind === "error" ? "text-destructive" : ""}>{msg.text}</span>}</div>

            <SecretInput ref={pw} label={L.password} name={`pw-${a.id}`} purpose="current-password"/>

            <div className="flex flex-wrap items-start gap-3">
                {!a.enrolled && <ReasonButton className={PRIMARY_AA} reason={reason(null)} onClick={() => enrol(false)}>{busy ? L.actions.working : L.actions.enrol}</ReasonButton>}
                {a.enrolled && <>
                    <ReasonButton reason={reason(a.revoked ? L.revoked : null)} variant="outline" onClick={() => setConfirm({kind: "reenroll"})}>{L.actions.reenrol}</ReasonButton>
                    <ReasonButton reason={reason(maintReason)} variant="outline" onClick={rotate}>{L.actions.rotate}</ReasonButton>
                    <ReasonButton reason={reason(a.revoked ? L.revoked : null)} variant="outline" onClick={() => (a.enabled ? setConfirm({kind: "disable"}) : toggle(true))}>{a.enabled ? L.actions.disable : L.actions.enable}</ReasonButton>
                    <ReasonButton reason={reason(a.revoked ? L.revoked : !a.enabled ? L.disabledAgent : null)} variant="outline" onClick={test}>{L.actions.testTask}</ReasonButton>
                    <ReasonButton reason={reason(a.revoked ? L.revoked : null)} variant="destructive" onClick={() => setConfirm({kind: "revoke"})}>{L.actions.revoke}</ReasonButton>
                </>}
            </div>
            {a.enrolled && !a.revoked && <p className="text-xs text-muted-foreground">{L.rotateHelp}</p>}

            {a.enrolled && (
                <div className="flex flex-col gap-2">
                    <h3 className="text-sm font-medium">{L.fields.pins}</h3>
                    <ul className="flex flex-col gap-1 text-sm">
                        {a.pinnedKids.map((kid) => {
                            const inUse = kid === signingKid;
                            const why = inUse ? L.errors.pin_in_use : a.pinnedKids.length <= 1 ? L.errors.last_pin : maintReason;
                            return (
                                <li key={kid} className="flex flex-wrap items-start gap-3">
                                    <code className="font-mono text-xs" data-testid="pinned-kid">{kid}</code>
                                    <ReasonButton reason={reason(why)} variant="outline" size="sm" aria-label={`${L.actions.unpin} ${kid}`} onClick={() => setConfirm({kind: "unpin", kid})}>{L.actions.unpin}</ReasonButton>
                                </li>
                            );
                        })}
                    </ul>
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor={pemId}>{L.pinForm.pem}</Label>
                        <Textarea id={pemId} value={pem} onChange={(e) => setPem(e.target.value)} rows={4} spellCheck={false} maxLength={4096} placeholder="-----BEGIN PUBLIC KEY-----" className="font-mono text-xs"/>
                        <p className="text-xs text-muted-foreground">{L.pinForm.help}</p>
                    </div>
                    <ReasonButton reason={reason(maintReason ?? (pem.trim() ? null : L.pinForm.pem))} variant="outline" className="w-fit" onClick={pin}>{L.actions.pin}</ReasonButton>
                </div>
            )}

            {a.enrolled && (
                <div className="flex flex-col gap-1">
                    <h3 className="text-sm font-medium">{L.fields.tasks}</h3>
                    {a.recentTasks.length === 0 ? <p className="text-sm text-muted-foreground">{L.fields.noTasks}</p> : (
                        <ul className="flex flex-col gap-1 text-sm">
                            {a.recentTasks.map((t) => (
                                <li key={t.id} data-testid="recent-task">{L.taskTypes[t.type] ?? t.type} · {L.taskStatuses[t.status] ?? t.status}{t.reason ? ` (${t.reason})` : ""} · {when(t.createdAt)}</li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            {confirm && (
                <DangerousActionConfirm
                    open
                    onOpenChange={(o) => { if (!o) setConfirm(null); }}
                    title={L.confirms[confirm.kind].title}
                    description={<p>{L.confirms[confirm.kind].body}</p>}
                    confirmLabel={L.confirms[confirm.kind].button}
                    onConfirm={() => {
                        const c = confirm; setConfirm(null);
                        if (c.kind === "disable") toggle(false);
                        else if (c.kind === "reenroll") enrol(true);
                        else if (c.kind === "revoke") revoke();
                        else if (c.kid) unpin(c.kid);
                    }}
                />
            )}
        </section>
    );
}
