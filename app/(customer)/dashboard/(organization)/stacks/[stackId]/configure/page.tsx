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
    return (
        <Page>
            <PageContent>
                <StatusAnnouncer>
                    <ConfigureForm view={view} locked={locked}/>
                </StatusAnnouncer>
            </PageContent>
        </Page>
    );
}
