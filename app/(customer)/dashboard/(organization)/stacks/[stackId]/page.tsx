import type {Metadata} from "next";
import {notFound} from "next/navigation";
import {Page, PageContent} from "@/features/layout/components/page";
import {actorIn, forkCan, ForkForbiddenError, ForkNotFoundError} from "@/fork/acl";
import {appDb} from "@/fork/db/handle";
import {currentForkMode} from "@/fork/mode";
import {getForkPrincipal} from "@/fork/principal";
import {assertForkResource} from "@/fork/resource-scope";
import {forkBannerText} from "@/fork/self-check";
import type {StackDetail} from "@/fork/stacks/dto";
import {loadStackDetail} from "@/fork/stacks/queries";
import {STACKS_EMPTY, STACKS_PAGE} from "@/fork/ui/labels";
import {StateNotice} from "@/fork/ui/stacks/stack-empty-states";
import {StackDetailsClient} from "@/fork/ui/stacks/stack-details.client";
import {parseRp, parseTab} from "@/fork/ui/stacks/tabs";
import {StatusAnnouncer} from "@/fork/ui/status-announcer";

// Stack Details (W08 + W09 + W13): header + Overview + Resources + Configuration + Backups + Schedule + Activity. Resource-scoped authorisation (SEC-12) BEFORE anything is read.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {title: STACKS_PAGE.title};

export default async function StackDetailsPage(props: {params: Promise<{stackId: string}>; searchParams: Promise<Record<string, string | string[] | undefined>>}) {
    const mode = await currentForkMode();
    if (mode.mode === "off") notFound();
    const principal = await getForkPrincipal();
    if (!principal) notFound();
    const {stackId} = await props.params;
    const db = await appDb();

    let organizationId: string;
    try {
        ({organizationId} = await assertForkResource(db, principal, "stacks.view", {kind: "stack", id: stackId}));
    } catch (e) {
        if (e instanceof ForkNotFoundError) notFound(); // missing, malformed, or another organization's: indistinguishable
        if (e instanceof ForkForbiddenError) return <Page><PageContent><StateNotice testId="unauthorized" title={STACKS_EMPTY.unauthorized.title} body={STACKS_EMPTY.unauthorized.body}/></PageContent></Page>;
        throw e;
    }

    const search = await props.searchParams;
    let detail: StackDetail | null;
    try {
        detail = await loadStackDetail(db, organizationId, stackId, {configLocked: mode.mode === "locked", rp: parseRp(search.rp)});
    } catch {
        return <Page><PageContent><StateNotice testId="load-error" tone="danger" alert title={STACKS_EMPTY.loadError.title} body={STACKS_EMPTY.loadError.body}/></PageContent></Page>;
    }
    if (!detail) notFound();

    const actor = actorIn(principal, organizationId);
    const locked = forkBannerText(mode);
    return (
        <Page>
            <PageContent>
                <StatusAnnouncer>
                    {locked && <p role="note" data-testid="locked-note" className="mb-4 rounded-lg border p-3 text-sm">{STACKS_EMPTY.locked}</p>}
                    <StackDetailsClient detail={detail} initialTab={parseTab(search.tab)} canConfigure={forkCan(actor, "stacks.backup.manage")} configLocked={locked !== null} canRun={forkCan(actor, "backup.run")}/>
                </StatusAnnouncer>
            </PageContent>
        </Page>
    );
}
