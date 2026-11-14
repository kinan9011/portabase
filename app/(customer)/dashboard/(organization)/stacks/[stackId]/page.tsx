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
import {forkEnv} from "@/fork/env";
import {fileKeyProvider} from "@/fork/keys";
import {getTestRestoreView} from "@/fork/test-restore/view";
import {getServerUrl} from "@/utils/get-server-url";
import {previewQuiesce} from "@/fork/quiesce/service";
import {StackDetailsClient} from "@/fork/ui/stacks/stack-details.client";
import {parseRp, parseTab} from "@/fork/ui/stacks/tabs";
import {StatusAnnouncer} from "@/fork/ui/status-announcer";
import {mirrorEntry} from "@/fork/ui/mirrors/entry";
import {loadMirrorEntryFacts} from "@/fork/mirror/wizard-view";

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
    // W17b: the Stop + copy panel exists only while the dashboard switch is on (flags-off parity: nothing renders otherwise)
    const quiesce = forkEnv().FORK_QUIESCE_ENABLED && detail.policy ? await previewQuiesce({db, principal}, {stackId}).then((r) => (r.ok ? r.dto : null), () => null) : null;
    // W-TR-f: the test-restore panel's strict view (members get `admin: null`); a load error hides the panel, never the page
    const testRestore = await getTestRestoreView({db, principal, keys: fileKeyProvider, serverUrl: getServerUrl}, {stackId}).then((r) => (r.ok ? r.view : null), () => null);
    // W22b: "Create test mirror" is a link only when every precondition holds; the facts are read only when the cheap gates (flag, role, lock) pass
    const mirrorOn = forkEnv().FORK_MIRRORS_ENABLED && forkCan(actor, "mirrors.manage") && locked === null;
    const facts = mirrorOn ? await loadMirrorEntryFacts(db, principal, organizationId, stackId).catch(() => ({verifiedCount: 0, runnerCount: 0})) : {verifiedCount: 0, runnerCount: 0};
    const mirror = mirrorEntry({enabled: forkEnv().FORK_MIRRORS_ENABLED, canManage: forkCan(actor, "mirrors.manage"), locked: locked !== null, ...facts, stackId});
    return (
        <Page>
            <PageContent>
                <StatusAnnouncer>
                    {locked && <p role="note" data-testid="locked-note" className="mb-4 rounded-lg border p-3 text-sm">{STACKS_EMPTY.locked}</p>}
                    <StackDetailsClient detail={detail} initialTab={parseTab(search.tab)} canConfigure={forkCan(actor, "stacks.backup.manage")} configLocked={locked !== null} canRun={forkCan(actor, "backup.run")} canRestore={forkCan(actor, "restore.plan")} quiesce={quiesce} testRestore={testRestore} mirror={mirror}/>
                </StatusAnnouncer>
            </PageContent>
        </Page>
    );
}
