import type {Metadata} from "next";
import {notFound} from "next/navigation";
import {z} from "zod";
import {Page, PageContent} from "@/features/layout/components/page";
import {actorIn, forkCan, ForkForbiddenError, ForkNotFoundError} from "@/fork/acl";
import {appDb} from "@/fork/db/handle";
import {fileKeyProvider} from "@/fork/keys";
import {currentForkMode} from "@/fork/mode";
import {getForkPrincipal} from "@/fork/principal";
import {getRestoreRunView} from "@/fork/restore-run/view";
import {loadStackName} from "@/fork/restore-wizard/view";
import {assertForkResource} from "@/fork/resource-scope";
import {forkBannerText} from "@/fork/self-check";
import {R_ROLE, RECOVERY} from "@/fork/ui/recovery/labels";
import {RunView} from "@/fork/ui/recovery/run-view.client";
import {StateNotice} from "@/fork/ui/stacks/stack-empty-states";
import {StatusAnnouncer} from "@/fork/ui/status-announcer";
import {getServerUrl} from "@/utils/get-server-url";

// Step 6 (W18b): progress + final report. The first render is server-side from the durable run row (reload-safe); the client then polls the same read model.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {title: RECOVERY.page.title};

export default async function RunPage(props: {params: Promise<{runId: string}>}) {
    const mode = await currentForkMode();
    if (mode.mode === "off") notFound();
    const principal = await getForkPrincipal();
    if (!principal) notFound();
    const {runId} = await props.params;
    if (!z.uuid().safeParse(runId).success) notFound();
    const db = await appDb();

    let organizationId: string;
    try {
        ({organizationId} = await assertForkResource(db, principal, "restore.plan", {kind: "restore_run", id: runId}));
    } catch (e) {
        if (e instanceof ForkNotFoundError) notFound();
        if (e instanceof ForkForbiddenError) return <Page><PageContent><StateNotice testId="unauthorized" title={RECOVERY.page.title} body={R_ROLE}/></PageContent></Page>;
        throw e;
    }
    let r: Awaited<ReturnType<typeof getRestoreRunView>>;
    let appName: string;
    try {
        r = await getRestoreRunView({db, principal, keys: fileKeyProvider, serverUrl: getServerUrl}, {runId});
        appName = r.ok ? ((await loadStackName(db, organizationId, r.view.stackId)) ?? "Removed app") : "";
    } catch {
        return <Page><PageContent><StateNotice testId="load-error" tone="danger" alert title={RECOVERY.page.loadError.title} body={RECOVERY.page.loadError.body}/></PageContent></Page>;
    }
    if (!r.ok) {
        if (r.code === "forbidden") return <Page><PageContent><StateNotice testId="unauthorized" title={RECOVERY.page.title} body={R_ROLE}/></PageContent></Page>;
        notFound();
    }
    const actor = actorIn(principal, organizationId);
    const locked = forkBannerText(mode) !== null;
    return (
        <Page>
            <PageContent>
                <StatusAnnouncer>
                    {locked && <p role="note" data-testid="locked-note" className="mb-4 rounded-lg border p-3 text-sm">{forkBannerText(mode)}</p>}
                    <RunView initial={r.view} appName={appName} canExecute={forkCan(actor, "restore.execute")} canApproveProduction={forkCan(actor, "restore.production.approve")} locked={locked} serverNowIso={new Date().toISOString()}/>
                </StatusAnnouncer>
            </PageContent>
        </Page>
    );
}
