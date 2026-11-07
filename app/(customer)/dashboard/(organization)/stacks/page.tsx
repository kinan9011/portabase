import type {Metadata} from "next";
import {notFound} from "next/navigation";
import {Page, PageContent, PageDescription, PageHeader, PageTitle} from "@/features/layout/components/page";
import {actorIn, forkCan} from "@/fork/acl";
import {soleOrganization} from "@/fork/arcane/connection-service";
import {appDb} from "@/fork/db/handle";
import {currentForkMode} from "@/fork/mode";
import {getForkPrincipal} from "@/fork/principal";
import {forkBannerText} from "@/fork/self-check";
import {parseStackListParams} from "@/fork/stacks/params";
import {loadStackList} from "@/fork/stacks/queries";
import {loadSafetyStrip} from "@/fork/stacks/safety-queries";
import type {SafetyStrip} from "@/fork/stacks/safety";
import {defaultNotificationChannel} from "@/fork/upstream/notification-channel";
import {SafetyStripView} from "@/fork/ui/stacks/safety-strip/safety-strip";
import type {StackList} from "@/fork/stacks/dto";
import {STACKS_EMPTY, STACKS_PAGE} from "@/fork/ui/labels";
import {StateNotice} from "@/fork/ui/stacks/stack-empty-states";
import {StackListView} from "@/fork/ui/stacks/stack-list";
import {StatusAnnouncer} from "@/fork/ui/status-announcer";

// Docker Stacks list (W08). Server component: gate (flag/mode, session, `stacks.view` in the organization) → org-scoped loader → DTO → view.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {title: STACKS_PAGE.title};

const Head = () => (
    <>
        <PageHeader><PageTitle>{STACKS_PAGE.title}</PageTitle></PageHeader>
        <PageDescription>{STACKS_PAGE.description}</PageDescription>
    </>
);

export default async function StacksPage(props: {searchParams: Promise<Record<string, string | string[] | undefined>>}) {
    const mode = await currentForkMode();
    if (mode.mode === "off") notFound(); // flags off, or nothing activated and the self-check failing: the fork is invisible (ADR-010)
    const principal = await getForkPrincipal();
    if (!principal) notFound();

    const db = await appDb();
    const organizationId = await soleOrganization(db);
    if (!organizationId) return <Page><Head/><PageContent><StateNotice testId="no-org" tone="warning" title="Stack Recovery needs exactly one organization" body="Fork configuration is locked until the instance has exactly one organization."/></PageContent></Page>;

    const actor = actorIn(principal, organizationId);
    if (!forkCan(actor, "stacks.view")) {
        // authenticated but not a member: an honest explanation, no data is loaded
        return <Page><Head/><PageContent><StateNotice testId="unauthorized" title={STACKS_EMPTY.unauthorized.title} body={STACKS_EMPTY.unauthorized.body}/></PageContent></Page>;
    }

    const params = parseStackListParams(await props.searchParams);
    let list: StackList | null = null;
    try {
        list = await loadStackList(db, organizationId, params);
    } catch {
        list = null; // never echo the failure to the browser; the server log has it
    }
    // W13: "Am I safe?" strip. A failure of the strip never hides the list (and the strip never invents a state: it is simply absent with an honest note).
    let strip: SafetyStrip | null = null;
    let noChannel = false;
    try {
        strip = await loadSafetyStrip(db, organizationId, {configLocked: mode.mode === "locked"});
        noChannel = forkCan(actor, "arcane.manage") && (await defaultNotificationChannel(db)) === null;
    } catch {
        strip = null;
    }
    const locked = forkBannerText(mode);
    return (
        <Page>
            <Head/>
            <PageContent>
                <StatusAnnouncer>
                    <div className="flex flex-col gap-4">
                        {locked && <p role="note" data-testid="locked-note" className="rounded-lg border p-3 text-sm">{STACKS_EMPTY.locked}</p>}
                        {strip && list && list.summary.total > 0 && <SafetyStripView strip={strip} noChannel={noChannel}/>}
                        {list ? <StackListView list={list} params={params} isAdmin={forkCan(actor, "arcane.manage")}/> : <StateNotice testId="load-error" tone="danger" alert title={STACKS_EMPTY.loadError.title} body={STACKS_EMPTY.loadError.body}/>}
                    </div>
                </StatusAnnouncer>
            </PageContent>
        </Page>
    );
}
