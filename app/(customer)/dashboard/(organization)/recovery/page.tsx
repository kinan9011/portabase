import type {Metadata} from "next";
import {notFound} from "next/navigation";
import {Page, PageContent} from "@/features/layout/components/page";
import {actorIn, forkCan} from "@/fork/acl";
import {soleOrganization} from "@/fork/arcane/connection-service";
import {appDb} from "@/fork/db/handle";
import {fileKeyProvider} from "@/fork/keys";
import {currentForkMode} from "@/fork/mode";
import {getForkPrincipal} from "@/fork/principal";
import {listRestoreRuns, type RestoreRunSummary} from "@/fork/restore-run/view";
import {loadRestoreChoices, type RestoreChoice} from "@/fork/restore-wizard/view";
import {forkBannerText} from "@/fork/self-check";
import {RECOVERY} from "@/fork/ui/recovery/labels";
import {RecoveryHome} from "@/fork/ui/recovery/recovery-home";
import {StateNotice} from "@/fork/ui/stacks/stack-empty-states";
import {StatusAnnouncer} from "@/fork/ui/status-announcer";
import {getServerUrl} from "@/utils/get-server-url";

// Stack Recovery page (W18b, Screen R). Gate order: mode → principal → organization → `recovery.view`, then org-scoped loaders; members get no Restores section.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {title: RECOVERY.page.title};

export default async function RecoveryPage() {
    const mode = await currentForkMode();
    if (mode.mode === "off") notFound();
    const principal = await getForkPrincipal();
    if (!principal) notFound();
    const db = await appDb();
    const organizationId = await soleOrganization(db);
    if (!organizationId) notFound();
    const actor = actorIn(principal, organizationId);
    if (!forkCan(actor, "recovery.view")) notFound();

    const lockedText = forkBannerText(mode);
    const canPlan = forkCan(actor, "restore.plan");
    let choices: RestoreChoice[];
    let runs: RestoreRunSummary[] | null = null;
    try {
        choices = await loadRestoreChoices(db, organizationId, {now: new Date(), configLocked: lockedText !== null});
        if (canPlan) {
            const r = await listRestoreRuns({db, principal, keys: fileKeyProvider, serverUrl: getServerUrl}, {});
            runs = r.ok ? r.runs : [];
        }
    } catch {
        return <Page><PageContent><StateNotice testId="load-error" tone="danger" alert title={RECOVERY.page.loadError.title} body={RECOVERY.page.loadError.body}/></PageContent></Page>;
    }
    return (
        <Page>
            <PageContent>
                <StatusAnnouncer>
                    <RecoveryHome choices={choices} runs={runs} canPlan={canPlan} locked={lockedText !== null} lockedText={lockedText} now={new Date()}/>
                </StatusAnnouncer>
            </PageContent>
        </Page>
    );
}
