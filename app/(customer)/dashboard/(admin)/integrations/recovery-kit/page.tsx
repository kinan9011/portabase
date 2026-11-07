import {notFound} from "next/navigation";
import {Page, PageContent, PageDescription, PageHeader, PageTitle} from "@/features/layout/components/page";
import {currentUser} from "@/lib/auth/current-user";
import {forkCan} from "@/fork/acl";
import {appDb} from "@/fork/db/handle";
import {loadKitView} from "@/fork/kit/service";
import {currentForkMode} from "@/fork/mode";
import {forkBannerText} from "@/fork/self-check";
import {KitPanel} from "@/fork/ui/kit/kit-panel.client";
import {KIT} from "@/fork/ui/labels";

// Recovery kit page (W14, D25/D41). System administrators only (proxy P04 hides it with a real 404; this page re-checks). The page carries state and forms — never a key.
export const dynamic = "force-dynamic";

export default async function RecoveryKitPage() {
    const mode = await currentForkMode();
    if (mode.mode === "off") notFound();
    const user = await currentUser();
    if (!user) notFound();
    const canManage = forkCan({systemRole: user.role}, "recovery.kit.manage");
    const view = canManage ? await loadKitView(await appDb()) : null;
    return (
        <Page>
            <PageHeader><PageTitle>{KIT.page.title}</PageTitle></PageHeader>
            <PageDescription>{KIT.page.intro}</PageDescription>
            <PageContent>
                {canManage && view
                    ? <KitPanel view={view} canManage lockedReason={forkBannerText(mode)}/>
                    : <p className="text-sm">{KIT.page.notAdmin}</p>}
            </PageContent>
        </Page>
    );
}
