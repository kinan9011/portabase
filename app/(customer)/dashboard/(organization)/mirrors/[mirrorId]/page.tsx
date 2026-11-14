import type {Metadata} from "next";
import {notFound} from "next/navigation";
import {Page, PageContent} from "@/features/layout/components/page";
import {actorIn, forkCan, ForkForbiddenError, ForkNotFoundError} from "@/fork/acl";
import {appDb} from "@/fork/db/handle";
import {fileKeyProvider} from "@/fork/keys";
import {z} from "zod";
import {forkEnv} from "@/fork/env";
import {loadMirrorDetailExtras, loadMirrorLog} from "@/fork/mirror/list-view";
import {getMirrorView} from "@/fork/mirror/service";
import {currentForkMode} from "@/fork/mode";
import {getForkPrincipal} from "@/fork/principal";
import {assertForkResource} from "@/fork/resource-scope";
import {forkBannerText} from "@/fork/self-check";
import {MIRRORS, refusalText} from "@/fork/ui/mirrors/labels";
import {MirrorDetail, MIRROR_TABS} from "@/fork/ui/mirrors/detail/detail.client";
import {StateNotice} from "@/fork/ui/stacks/stack-empty-states";
import {StatusAnnouncer} from "@/fork/ui/status-announcer";
import {getServerUrl} from "@/utils/get-server-url";

// Test mirror detail (W22b progress page, extended in W23 into the 4-tab detail: Overview / Configuration / Refresh History / Logs; plan DD-5). The first render comes from durable server state; a client poller then reads it every 3 s until it settles.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {title: MIRRORS.progress.title};

const TabParam = z.enum(MIRROR_TABS).catch("overview");

export default async function MirrorPage(props: {params: Promise<{mirrorId: string}>; searchParams: Promise<{tab?: string | string[]}>}) {
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
    if (r.view.mirror.status === "deleted") return <Page><PageContent><StateNotice testId="mirror-deleted" title={r.view.mirror.name} body={MIRRORS.detail.deleted}/></PageContent></Page>;
    const actor = actorIn(principal, organizationId);
    const canManage = forkCan(actor, "mirrors.manage");
    const sp = await props.searchParams;
    const tab = TabParam.parse(Array.isArray(sp.tab) ? sp.tab[0] : sp.tab);
    const now = new Date();
    let extras: Awaited<ReturnType<typeof loadMirrorDetailExtras>>;
    let log: Awaited<ReturnType<typeof loadMirrorLog>>;
    try {
        [extras, log] = await Promise.all([loadMirrorDetailExtras(db, mirrorId, {now, serverUrl: getServerUrl(), canManage}), loadMirrorLog(db, mirrorId)]);
    } catch {
        return <Page><PageContent><StateNotice testId="load-error" tone="danger" alert title={MIRRORS.detail.loadError.title} body={MIRRORS.detail.loadError.body}/></PageContent></Page>;
    }
    return (
        <Page>
            <PageContent>
                <StatusAnnouncer>
                    <MirrorDetail initial={r.view} extras={extras} log={log} canManage={canManage} locked={forkBannerText(mode) !== null} flagOn={forkEnv().FORK_MIRRORS_ENABLED} now={now.toISOString()}
                        staleAfterDays={forkEnv().FORK_MIRROR_START_STALE_DAYS} tab={tab}/>
                </StatusAnnouncer>
            </PageContent>
        </Page>
    );
}
