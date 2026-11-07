import {notFound} from "next/navigation";
import {currentUser} from "@/lib/auth/current-user";
import {Page, PageContent, PageDescription, PageHeader, PageTitle} from "@/features/layout/components/page";
import {forkCan} from "@/fork/acl";
import {soleOrganization} from "@/fork/arcane/connection-service";
import {loadIntegrationsView} from "@/fork/arcane/integrations-view";
import {appDb} from "@/fork/db/handle";
import {currentForkMode} from "@/fork/mode";
import {forkBannerText} from "@/fork/self-check";
import {NonAdminExplanation} from "@/fork/ui/integrations/empty-states";
import {IntegrationsViewClient} from "@/fork/ui/integrations/integrations-view.client";

// Instance-level Integrations page under (admin) (D35). Server component: authorises, loads the key-free read model, hands it to the client view.
export const dynamic = "force-dynamic";

const Head = () => (
    <>
        <PageHeader><PageTitle>Integrations</PageTitle></PageHeader>
        <PageDescription>Connect external systems that Portabase reads inventory from. Integrations never replace Portabase storage, agents or recovery points.</PageDescription>
    </>
);

export default async function IntegrationsPage() {
    // The (admin) layout and P04 already 404 non-system-admins; this page re-checks and never depends on them.
    const mode = await currentForkMode();
    if (mode.mode === "off") notFound(); // flags off (or nothing activated + self-check failing): the fork is invisible (ADR-010)
    const user = await currentUser();
    if (!user) notFound();
    if (!forkCan({systemRole: user.role}, "arcane.manage")) {
        // role-aware empty state (D35/CH-20): plain explanation, no data is loaded
        return <Page><Head/><PageContent><NonAdminExplanation/></PageContent></Page>;
    }
    const db = await appDb();
    const organizationId = await soleOrganization(db);
    const lockedReason = forkBannerText(mode) ?? (organizationId ? null : "Fork configuration locked: Stack Recovery needs exactly one organization");
    if (!organizationId) {
        return <Page><Head/><PageContent><section className="rounded-xl border p-6 text-sm"><p role="status">{lockedReason}</p></section></PageContent></Page>;
    }
    const view = await loadIntegrationsView(db, organizationId);
    return <Page><Head/><PageContent><IntegrationsViewClient view={view} lockedReason={lockedReason}/></PageContent></Page>;
}
