import type {Metadata} from "next";
import {notFound} from "next/navigation";
import {Page, PageContent} from "@/features/layout/components/page";
import {actorIn, forkCan} from "@/fork/acl";
import {soleOrganization} from "@/fork/arcane/connection-service";
import {appDb} from "@/fork/db/handle";
import {forkEnv} from "@/fork/env";
import {loadMirrorList, type MirrorListRow} from "@/fork/mirror/list-view";
import {currentForkMode} from "@/fork/mode";
import {getForkPrincipal} from "@/fork/principal";
import {forkBannerText} from "@/fork/self-check";
import {MIRRORS} from "@/fork/ui/mirrors/labels";
import {MirrorList} from "@/fork/ui/mirrors/list/list.client";
import {StateNotice} from "@/fork/ui/stacks/stack-empty-states";
import {StatusAnnouncer} from "@/fork/ui/status-announcer";

// Test mirrors list (W23, plan DD-3). Same real-404 gate as the other fork pages (mode off / no usable principal → 404). Members see the list (`mirrors.view`); buttons need `mirrors.manage` (the services re-check).
// With the mirror flag off the existing mirrors are still listed (and can be deleted: OD-W23-2) next to an honest notice.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {title: MIRRORS.list.title};

export default async function MirrorsIndexPage() {
    const mode = await currentForkMode();
    if (mode.mode === "off") notFound();
    const principal = await getForkPrincipal();
    if (!principal) notFound();
    const db = await appDb();
    const organizationId = await soleOrganization(db);
    if (!organizationId) notFound();
    const actor = actorIn(principal, organizationId);
    if (!forkCan(actor, "mirrors.view")) return <Page><PageContent><StateNotice testId="unauthorized" title={MIRRORS.list.unauthorized.title} body={MIRRORS.list.unauthorized.body}/></PageContent></Page>;
    const flagOn = forkEnv().FORK_MIRRORS_ENABLED;
    let rows: MirrorListRow[];
    try {
        rows = await loadMirrorList(db, organizationId);
    } catch {
        return <Page><PageContent><StateNotice testId="load-error" tone="danger" alert title={MIRRORS.list.loadError.title} body={MIRRORS.list.loadError.body}/></PageContent></Page>;
    }
    return (
        <Page>
            <PageContent>
                <div className="space-y-4">
                    {!flagOn && <StateNotice testId="flag-off" tone="warning" title={MIRRORS.list.title} body={MIRRORS.list.flagOff}/>}
                    <StatusAnnouncer>
                        <MirrorList rows={rows} canManage={forkCan(actor, "mirrors.manage")} locked={forkBannerText(mode) !== null} flagOn={flagOn} now={new Date().toISOString()}/>
                    </StatusAnnouncer>
                </div>
            </PageContent>
        </Page>
    );
}
