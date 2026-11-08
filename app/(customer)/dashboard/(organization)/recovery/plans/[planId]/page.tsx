import type {Metadata} from "next";
import {notFound} from "next/navigation";
import {z} from "zod";
import {Page, PageContent} from "@/features/layout/components/page";
import {actorIn, forkCan, ForkForbiddenError, ForkNotFoundError} from "@/fork/acl";
import {getRestoreOverridesView} from "@/fork/config/service";
import {appDb} from "@/fork/db/handle";
import {fileKeyProvider} from "@/fork/keys";
import {currentForkMode} from "@/fork/mode";
import {getForkPrincipal} from "@/fork/principal";
import {getRestorePlanView} from "@/fork/restore/service";
import {listRestoreRuns} from "@/fork/restore-run/view";
import {loadRestorePoints} from "@/fork/restore-wizard/view";
import {assertForkResource} from "@/fork/resource-scope";
import {forkBannerText} from "@/fork/self-check";
import {R_ROLE, RECOVERY} from "@/fork/ui/recovery/labels";
import {formatInstant, toPlanUi} from "@/fork/ui/recovery/model";
import {PlanScreen} from "@/fork/ui/recovery/plan-view";
import {StateNotice} from "@/fork/ui/stacks/stack-empty-states";
import {StatusAnnouncer} from "@/fork/ui/status-announcer";
import {getServerUrl} from "@/utils/get-server-url";

// Steps 4-5 (W18b): "What will happen" + "Start the restore". The plan is read server-side and NARROWED (`toPlanUi`) before it reaches client code: no host path, no backup internals.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {title: RECOVERY.steps.plan};

export default async function PlanPage(props: {params: Promise<{planId: string}>}) {
    const mode = await currentForkMode();
    if (mode.mode === "off") notFound();
    const principal = await getForkPrincipal();
    if (!principal) notFound();
    const {planId} = await props.params;
    if (!z.uuid().safeParse(planId).success) notFound();
    const db = await appDb();

    let organizationId: string;
    try {
        ({organizationId} = await assertForkResource(db, principal, "restore.plan", {kind: "restore_plan", id: planId}));
    } catch (e) {
        if (e instanceof ForkNotFoundError) notFound();
        if (e instanceof ForkForbiddenError) return <Page><PageContent><StateNotice testId="unauthorized" title={RECOVERY.page.title} body={R_ROLE}/></PageContent></Page>;
        throw e;
    }
    const err = (id: string, tone: "danger" | "neutral", body: string) => <Page><PageContent><StateNotice testId={id} tone={tone} alert={tone === "danger"} title={RECOVERY.steps.plan} body={body}/></PageContent></Page>;

    const keys = {db, principal, keys: fileKeyProvider, serverUrl: getServerUrl};
    try {
        const r = await getRestorePlanView({db, principal}, {planId});
        if (!r.ok) {
            if (r.code === "forbidden") return err("unauthorized", "neutral", R_ROLE);
            if (r.code === "plan_tampered") return err("plan-tampered", "danger", RECOVERY.plan.tampered);
            notFound();
        }
        const actor = actorIn(principal, organizationId);
        const plan = toPlanUi(r.view);
        const ov = await getRestoreOverridesView({db, principal}, {planId, planHash: plan.planHash});
        const used = await listRestoreRuns(keys, {planId});
        const pts = await loadRestorePoints(db, organizationId, plan.stackId); // app name + the backup's own date (in the instance time zone), not the plan's
        const stackName = pts?.stackName ?? "Removed app";
        const rpAt = pts?.points.find((x) => x.sequence === plan.rp.sequence)?.createdAt ?? null;
        const locked = forkBannerText(mode) !== null;
        return (
            <Page>
                <PageContent>
                    <StatusAnnouncer>
                        {locked && <p role="note" data-testid="locked-note" className="mb-4 rounded-lg border p-3 text-sm">{forkBannerText(mode)}</p>}
                        <PlanScreen
                            plan={plan} appName={stackName} backupLabel={rpAt && pts ? formatInstant(new Date(rpAt), pts.timezone) : "the selected backup"} validUntil={formatInstant(new Date(plan.expiresAt), "UTC") + " UTC"}
                            overrides={ov.ok ? ov.view : null} overridesRateLimited={!ov.ok && ov.code === "rate_limited"} locked={locked}
                            canExecute={forkCan(actor, "restore.execute")} canApproveProduction={forkCan(actor, "restore.production.approve")} canEditOverrides={forkCan(actor, "restore.plan")}
                            usedRunId={used.ok ? (used.runs[0]?.id ?? null) : null}
                        />
                    </StatusAnnouncer>
                </PageContent>
            </Page>
        );
    } catch (e) {
        if (e instanceof Error && e.message === "NEXT_NOT_FOUND") throw e;
        if (typeof e === "object" && e !== null && "digest" in e) throw e; // Next's own control-flow errors (notFound/redirect)
        return err("load-error", "danger", RECOVERY.page.loadError.body);
    }
}
