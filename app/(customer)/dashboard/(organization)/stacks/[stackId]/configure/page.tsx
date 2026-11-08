import type {Metadata} from "next";
import {notFound} from "next/navigation";
import {Page, PageContent} from "@/features/layout/components/page";
import {ForkForbiddenError, ForkNotFoundError} from "@/fork/acl";
import {appDb} from "@/fork/db/handle";
import {currentForkMode} from "@/fork/mode";
import {getForkPrincipal} from "@/fork/principal";
import {assertForkResource} from "@/fork/resource-scope";
import {forkBannerText} from "@/fork/self-check";
import {loadConfigureView} from "@/fork/stack-policy/configure-view";
import {CONFIGURE, STACKS_EMPTY} from "@/fork/ui/labels";
import {StateNotice} from "@/fork/ui/stacks/stack-empty-states";
import {forkEnv} from "@/fork/env";
import {previewQuiesce} from "@/fork/quiesce/service";
import {ConfigureForm} from "@/fork/ui/stacks/wizard/configure-form.client";
import {StatusAnnouncer} from "@/fork/ui/status-announcer";

// Configure Backup (W11): a FULL-PAGE route (§8.2), one form, nothing persists until Activate (UX-04). System administrators only (D21):
// resource-scoped authorisation BEFORE anything is read; a member who can view the stack gets an explanation, a stranger/missing id a real 404.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {title: CONFIGURE.title};

export default async function ConfigureBackupPage(props: {params: Promise<{stackId: string}>}) {
    const mode = await currentForkMode();
    if (mode.mode === "off") notFound();
    const principal = await getForkPrincipal();
    if (!principal) notFound();
    const {stackId} = await props.params;
    const db = await appDb();

    let organizationId: string;
    try {
        ({organizationId} = await assertForkResource(db, principal, "stacks.backup.manage", {kind: "stack", id: stackId}));
    } catch (e) {
        if (e instanceof ForkNotFoundError) notFound();
        if (e instanceof ForkForbiddenError) return <Page><PageContent><StateNotice testId="unauthorized" title={CONFIGURE.nonAdmin.title} body={CONFIGURE.nonAdmin.body}/></PageContent></Page>;
        throw e;
    }

    let view: Awaited<ReturnType<typeof loadConfigureView>>;
    try {
        view = await loadConfigureView(db, organizationId, stackId);
    } catch {
        return <Page><PageContent><StateNotice testId="load-error" tone="danger" alert title={STACKS_EMPTY.loadError.title} body={STACKS_EMPTY.loadError.body}/></PageContent></Page>;
    }
    if (!view) return <Page><PageContent><StateNotice testId="no-inventory" title={CONFIGURE.noInventory.title} body={CONFIGURE.noInventory.body}/></PageContent></Page>;

    const locked = forkBannerText(mode) !== null;
    // W17b: read-only "Stop + copy" status line, only while the dashboard switch is on (flags-off parity: nothing renders otherwise); `no_policy` = "available after activation"
    const quiesceReason = !forkEnv().FORK_QUIESCE_ENABLED ? undefined : await previewQuiesce({db, principal}, {stackId}).then((r) => (r.ok && r.dto.availability.state === "unavailable" && r.dto.availability.reason !== "no_policy" ? r.dto.availability.reason : null), () => undefined);
    return (
        <Page>
            <PageContent>
                <StatusAnnouncer>
                    <ConfigureForm view={view} locked={locked} quiesceReason={quiesceReason}/>
                </StatusAnnouncer>
            </PageContent>
        </Page>
    );
}
