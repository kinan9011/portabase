import type {Metadata} from "next";
import {notFound} from "next/navigation";
import {z} from "zod";
import {Page, PageContent} from "@/features/layout/components/page";
import {actorIn, forkCan} from "@/fork/acl";
import {soleOrganization} from "@/fork/arcane/connection-service";
import {appDb} from "@/fork/db/handle";
import {currentForkMode} from "@/fork/mode";
import {getForkPrincipal} from "@/fork/principal";
import {assertForkResource} from "@/fork/resource-scope";
import {loadRestoreChoices, loadRestorePoints, loadRestoreTargets} from "@/fork/restore-wizard/view";
import {forkBannerText} from "@/fork/self-check";
import {BACKUPS, FACET_COPY} from "@/fork/ui/labels";
import {R_ROLE, RECOVERY} from "@/fork/ui/recovery/labels";
import {defaultRestoreFolder, formatInstant, relative} from "@/fork/ui/recovery/model";
import {fmtBytes} from "@/fork/ui/stacks/format";
import {StateNotice} from "@/fork/ui/stacks/stack-empty-states";
import {StatusAnnouncer} from "@/fork/ui/status-announcer";
import {WizardSteps, type WizardData} from "@/fork/ui/recovery/wizard-steps.client";

// Restore wizard steps 1-3 (W18b, DD-1/DD-4): choices only, nothing is persisted until "Next: see what will happen" on step 3 creates the plan. Query params carry ids and a sequence, never values.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {title: RECOVERY.steps.app};

const Params = z.object({step: z.enum(["app", "backup", "machine"]).optional().catch(undefined), stack: z.uuid().optional().catch(undefined), point: z.coerce.number().int().min(1).optional().catch(undefined), machine: z.uuid().optional().catch(undefined)});
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function NewRestorePage(props: {searchParams: Promise<Record<string, string | string[] | undefined>>}) {
    const mode = await currentForkMode();
    if (mode.mode === "off") notFound();
    const principal = await getForkPrincipal();
    if (!principal) notFound();
    const db = await appDb();
    const organizationId = await soleOrganization(db);
    if (!organizationId) notFound();
    const actor = actorIn(principal, organizationId);
    if (!forkCan(actor, "recovery.view")) notFound();
    if (!forkCan(actor, "restore.plan")) return <Page><PageContent><StateNotice testId="unauthorized" title={RECOVERY.page.title} body={R_ROLE}/></PageContent></Page>;

    const sp = await props.searchParams;
    const raw = {step: one(sp.step), stack: one(sp.stack), point: one(sp.point), machine: one(sp.machine)};
    const parsed = Params.safeParse(raw);
    const p = parsed.success ? parsed.data : {};
    let dropped = !parsed.success || (Object.entries(raw).some(([k, v]) => v !== undefined && (p as Record<string, unknown>)[k] === undefined));

    const now = new Date();
    const locked = forkBannerText(mode) !== null;
    try {
        let stackId = p.stack;
        if (stackId) {
            try { await assertForkResource(db, principal, "restore.plan", {kind: "stack", id: stackId}); } catch { stackId = undefined; dropped = true; } // missing and foreign look the same (no existence oracle)
        }
        const pts = stackId ? await loadRestorePoints(db, organizationId, stackId) : null;
        if (stackId && !pts) { stackId = undefined; dropped = true; }
        const chosen = pts && p.point !== undefined ? pts.points.find((x) => x.sequence === p.point) : undefined;
        let pointGone = false;
        if (p.point !== undefined && pts && (!chosen || chosen.status !== "verified")) { pointGone = true; dropped = true; }
        const rp = chosen?.status === "verified" ? chosen : undefined;
        // the effective step never outruns what has been chosen
        const wanted = p.step ?? (rp ? "machine" : stackId ? "backup" : "app");
        const step: WizardData["step"] = wanted === "machine" && rp ? "machine" : wanted !== "app" && stackId ? "backup" : "app";

        const data: WizardData = {step, dropped: dropped || pointGone, pointGone, locked, canCompose: true, stackId: stackId ?? null, stackName: pts?.stackName ?? null, rpId: rp?.id ?? null, rpSequence: rp?.sequence ?? null, machineId: p.machine ?? null};
        if (step === "app") {
            const all = await loadRestoreChoices(db, organizationId, {now, configLocked: locked});
            data.choices = all.map((c) => ({
                stackId: c.stackId, name: c.name, environmentName: c.environmentName, runtime: c.runtime, verifiedCount: c.verifiedCount, pendingCount: c.pendingCount,
                lastGood: c.lastGood.hoursAgo === null ? FACET_COPY.lastGood.never : FACET_COPY.lastGood.ago(c.lastGood.hoursAgo),
                testRestore: c.testRestoreDaysAgo === null ? FACET_COPY.testRestore.never : FACET_COPY.testRestore.ago(c.testRestoreDaysAgo),
            }));
        } else if (pts) {
            data.points = pts.points.map((x) => {
                const at = new Date(x.createdAt);
                return {sequence: x.sequence, status: x.status, label: formatInstant(at, pts.timezone), relative: relative(at, now), size: fmtBytes(x.sizeBytes), consistency: BACKUPS.consistency[x.consistency as keyof typeof BACKUPS.consistency] ?? null, destinations: x.destinations};
            });
            if (step === "machine") {
                const targets = await loadRestoreTargets(db, principal, organizationId, {stackId: stackId!, now});
                data.isSysAdmin = forkCan(actor, "agents.channel.manage");
                data.targets = targets.map((t) => ({id: t.id, name: t.name, status: t.status, readiness: t.readiness, hostRole: t.hostRole, hostRoleSource: t.hostRoleSource, wasSource: t.wasSource, folder: defaultRestoreFolder(t)}));
            }
        }
        return (
            <Page>
                <PageContent>
                    <StatusAnnouncer>
                        <WizardSteps data={data}/>
                    </StatusAnnouncer>
                </PageContent>
            </Page>
        );
    } catch {
        return <Page><PageContent><StateNotice testId="load-error" tone="danger" alert title={RECOVERY.page.loadError.title} body={RECOVERY.page.loadError.body}/></PageContent></Page>;
    }
}
