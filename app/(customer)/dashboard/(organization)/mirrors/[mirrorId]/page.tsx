import type {Metadata} from "next";
import {notFound} from "next/navigation";
import {Page, PageContent} from "@/features/layout/components/page";
import {actorIn, forkCan, ForkForbiddenError, ForkNotFoundError} from "@/fork/acl";
import {appDb} from "@/fork/db/handle";
import {fileKeyProvider} from "@/fork/keys";
import {getMirrorView} from "@/fork/mirror/service";
import {currentForkMode} from "@/fork/mode";
import {getForkPrincipal} from "@/fork/principal";
import {assertForkResource} from "@/fork/resource-scope";
import {forkBannerText} from "@/fork/self-check";
import {MIRRORS, refusalText} from "@/fork/ui/mirrors/labels";
import {MirrorProgress} from "@/fork/ui/mirrors/progress/progress.client";
import {StateNotice} from "@/fork/ui/stacks/stack-empty-states";
import {StatusAnnouncer} from "@/fork/ui/status-announcer";
import {getServerUrl} from "@/utils/get-server-url";

// Test mirror progress / result (W22b, plan DD-7; W23 extends this into the 4-tab detail page). The first render comes from durable server state; a client poller then reads it every 3 s until it settles.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {title: MIRRORS.progress.title};

export default async function MirrorPage(props: {params: Promise<{mirrorId: string}>}) {
    const mode = await currentForkMode();
    if (mode.mode === "off") notFound();
    const principal = await getForkPrincipal();
    if (!principal) notFound();
    const {mirrorId} = await props.params;
    const db = await appDb();
    let organizationId: string;
    try {
        ({organizationId} = await assertForkResource(db, principal, "mirrors.view", {kind: "mirror", id: mirrorId}));
    } catch (e) {
        if (e instanceof ForkNotFoundError) notFound(); // missing, malformed, or another organization's: indistinguishable
        if (e instanceof ForkForbiddenError) return <Page><PageContent><StateNotice testId="unauthorized" title={MIRRORS.progress.unauthorized.title} body={MIRRORS.progress.unauthorized.body}/></PageContent></Page>;
        throw e;
    }
    const r = await getMirrorView({db, principal, keys: fileKeyProvider, serverUrl: getServerUrl}, {mirrorId}).catch(() => null);
    if (!r) return <Page><PageContent><StateNotice testId="load-error" tone="danger" alert title={MIRRORS.page.loadError.title} body={MIRRORS.page.loadError.body}/></PageContent></Page>;
    if (!r.ok) {
        if (r.code === "not_found") notFound();
        return <Page><PageContent><StateNotice testId="refused" tone="warning" title={MIRRORS.progress.title} body={refusalText(r.code)}/></PageContent></Page>;
    }
    const actor = actorIn(principal, organizationId);
    return (
        <Page>
            <PageContent>
                <StatusAnnouncer>
                    <MirrorProgress initial={r.view} canManage={forkCan(actor, "mirrors.manage")} locked={forkBannerText(mode) !== null}/>
                </StatusAnnouncer>
            </PageContent>
        </Page>
    );
}
