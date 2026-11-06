import {notFound} from "next/navigation";
import {currentUser} from "@/lib/auth/current-user";
import {Page, PageContent, PageDescription, PageHeader, PageTitle} from "@/features/layout/components/page";
import {forkCan} from "@/fork/acl";
import {currentForkMode} from "@/fork/mode";

// Fork-only placeholder (W01). Instance-level Integrations page under (admin) (D35).
export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
    // The (admin) layout already 404s non-admins; re-check here so this page never depends on it.
    const mode = await currentForkMode();
    const user = mode.mode === "on" ? await currentUser() : null;
    if (mode.mode !== "on" || !user || !forkCan({systemRole: user.role}, "arcane.manage")) notFound();

    return (
        <Page>
            <PageHeader>
                <PageTitle>Integrations</PageTitle>
            </PageHeader>
            <PageDescription>Connections to external systems used by Stack Recovery.</PageDescription>
            <PageContent>
                <section aria-labelledby="arcane-heading" className="rounded-lg border p-6">
                    <h2 id="arcane-heading" className="text-lg font-semibold">Arcane (coming)</h2>
                    <p className="text-sm text-muted-foreground">Not available yet. Nothing is connected and nothing is backed up by this page.</p>
                </section>
            </PageContent>
        </Page>
    );
}
