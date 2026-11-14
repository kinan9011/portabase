import type {Metadata} from "next";
import {notFound} from "next/navigation";
import {z} from "zod";
import {Page, PageContent} from "@/features/layout/components/page";
import {actorIn, forkCan} from "@/fork/acl";
import {soleOrganization} from "@/fork/arcane/connection-service";
import {appDb} from "@/fork/db/handle";
import {forkEnv} from "@/fork/env";
import {loadMirrorRunners, loadMirrorSource} from "@/fork/mirror/wizard-view";
import {currentForkMode} from "@/fork/mode";
import {getForkPrincipal} from "@/fork/principal";
import {assertForkResource} from "@/fork/resource-scope";
import {loadRestorePoints} from "@/fork/restore-wizard/view";
import {forkBannerText} from "@/fork/self-check";
import {RP_STATUS_LABELS} from "@/fork/ui/labels";
import {MIRROR_FLAG_OFF, MIRRORS} from "@/fork/ui/mirrors/labels";
import {runnerBlock} from "@/fork/ui/mirrors/wizard/model";
import {MirrorWizardSteps, type WizardData} from "@/fork/ui/mirrors/wizard/wizard-steps.client";
import {formatInstant, relative} from "@/fork/ui/recovery/model";
import {fmtBytes} from "@/fork/ui/stacks/format";
import {StateNotice} from "@/fork/ui/stacks/stack-empty-states";
import {StatusAnnouncer} from "@/fork/ui/status-announcer";
import {getServerUrl} from "@/utils/get-server-url";

// Create test mirror wizard (W22b, plan DD-1): steps 1-2 are server-rendered, steps 3-5 live in ONE client component. Nothing is persisted until Create on step 5. Query params carry ids, a sequence and the step only.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {title: MIRRORS.page.title};

const Params = z.object({step: z.enum(["source", "runner", "configure"]).optional().catch(undefined), stack: z.uuid().optional().catch(undefined), point: z.coerce.number().int().min(1).optional().catch(undefined), runner: z.uuid().optional().catch(undefined)});
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const notice = (testId: string, title: string, body: string, alert = false) => <Page><PageContent><StateNotice testId={testId} title={title} body={body} alert={alert} tone={alert ? "danger" : "neutral"}/></PageContent></Page>;

export default async function NewMirrorPage(props: {searchParams: Promise<Record<string, string | string[] | undefined>>}) {
    const mode = await currentForkMode();
    if (mode.mode === "off") notFound();
    const principal = await getForkPrincipal();
    if (!principal) notFound();
    const db = await appDb();
    const organizationId = await soleOrganization(db);
    if (!organizationId) notFound();
    const actor = actorIn(principal, organizationId);
    if (!actor || !forkCan(actor, "mirrors.view")) notFound();
    if (!forkEnv().FORK_MIRRORS_ENABLED) return notice("flag-off", MIRRORS.page.title, MIRROR_FLAG_OFF);
    if (!forkCan(actor, "mirrors.manage")) return notice("unauthorized", MIRRORS.page.title, MIRRORS.entry.role);

    const sp = await props.searchParams;
    const raw = {step: one(sp.step), stack: one(sp.stack), point: one(sp.point), runner: one(sp.runner)};
    const parsed = Params.safeParse(raw);
    const p = parsed.success ? parsed.data : {};
    let dropped = !parsed.success || Object.entries(raw).some(([k, v]) => v !== undefined && (p as Record<string, unknown>)[k] === undefined);

    const now = new Date();
    const locked = forkBannerText(mode) !== null;
    try {
        let stackId = p.stack;
        if (stackId) {
            try { await assertForkResource(db, principal, "mirrors.manage", {kind: "stack", id: stackId}); } catch { stackId = undefined; dropped = true; } // missing and foreign look the same (no existence oracle)
        }
        const pts = stackId ? await loadRestorePoints(db, organizationId, stackId) : null;
        if (stackId && !pts) { stackId = undefined; dropped = true; }
        const chosen = pts && p.point !== undefined ? pts.points.find((x) => x.sequence === p.point) : undefined;
        if (p.point !== undefined && pts && (!chosen || chosen.status !== "verified")) dropped = true;
        const rp = chosen?.status === "verified" ? chosen : undefined;

        const canProbe = forkCan(actor, "agents.channel.manage");
        const isSysAdmin = forkCan(actor, "host_role.manage");
        const runners = stackId && rp ? await loadMirrorRunners(db, principal, organizationId, {now, serverUrl: getServerUrl()}) : [];
        const picked = runners.find((r) => r.id === p.runner);
        if (p.runner !== undefined && stackId && rp && (!picked || runnerBlock(picked) !== null)) dropped = true;
        const runner = picked && runnerBlock(picked) === null ? picked : undefined;

        // the effective step never outruns what has been chosen
        const wanted = p.step ?? (rp ? "runner" : "source");
        const step: WizardData["step"] = wanted === "configure" && rp && runner ? "configure" : wanted !== "source" && rp ? "runner" : "source";

        const newest = pts?.points.find((x) => x.status === "verified");
        const source = stackId && (rp ?? newest) ? await loadMirrorSource(db, organizationId, stackId, (rp ?? newest)!.id) : null;
        const label = (x: {createdAt: string}) => formatInstant(new Date(x.createdAt), pts!.timezone);
        const data: WizardData = {
            step, dropped, locked, nowIso: now.toISOString(), stackId: stackId ?? null, stackName: pts?.stackName ?? null, pointSeq: rp?.sequence ?? null,
            points: pts ? pts.points.map((x) => ({id: x.id, sequence: x.sequence, verified: x.status === "verified", label: label(x), relative: relative(new Date(x.createdAt), now), size: fmtBytes(x.sizeBytes),
                statusText: RP_STATUS_LABELS[(Object.hasOwn(RP_STATUS_LABELS, x.status) ? x.status : "incomplete") as keyof typeof RP_STATUS_LABELS].label})) : [],
            privacy: source?.privacy ?? null, isSysAdmin, canProbe, runners, runnerId: runner?.id ?? null, configure: null,
        };
        if (step === "configure" && stackId && rp && runner) {
            const facts = await loadMirrorSource(db, organizationId, stackId, rp.id);
            if (!facts) data.step = "runner";
            else data.configure = {stackId, stackName: pts!.stackName, rp: {id: rp.id, sequence: rp.sequence, label: label(rp)}, runner: {id: runner.id, name: runner.name}, source: facts, locked};
        }
        return (
            <Page>
                <PageContent>
                    <StatusAnnouncer>
                        <MirrorWizardSteps data={data}/>
                    </StatusAnnouncer>
                </PageContent>
            </Page>
        );
    } catch {
        return notice("load-error", MIRRORS.page.loadError.title, MIRRORS.page.loadError.body, true);
    }
}
