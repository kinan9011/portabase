import {notFound} from "next/navigation";
import {Page, PageContent, PageDescription, PageHeader, PageTitle} from "@/features/layout/components/page";
import {currentUser} from "@/lib/auth/current-user";
import {forkCan} from "@/fork/acl";
import {checkChannelTransport} from "@/fork/agent-channel/transport-policy";
import {loadAgentChannelView} from "@/fork/agent-channel/view";
import {appDb} from "@/fork/db/handle";
import {forkEnv} from "@/fork/env";
import {fileKeyProvider} from "@/fork/keys";
import {currentForkMode} from "@/fork/mode";
import {forkBannerText} from "@/fork/self-check";
import {AgentChannelPanel} from "@/fork/ui/agent-channel/agent-channel-panel.client";
import {AGENT_CHANNEL} from "@/fork/ui/agent-channel/labels";
import {getServerUrl} from "@/utils/get-server-url";

// Agent channel page (W15b, ADR-007). System administrators only (proxy P04 hides it with a real 404 under /dashboard/integrations; this page re-checks).
// The page carries state and forms — never a credential, a task key or a bundle (strict view model).
export const dynamic = "force-dynamic";

export default async function AgentChannelPage() {
    const mode = await currentForkMode();
    if (mode.mode === "off") notFound();
    const user = await currentUser();
    if (!user) notFound();
    const canManage = forkCan({systemRole: user.role}, "agents.channel.manage");
    const lockedReason = forkBannerText(mode);
    let view = null;
    if (canManage) {
        let signingPublicKeyPem: string | null = null;
        try { signingPublicKeyPem = (await fileKeyProvider.signing()).publicKeyPem; } catch { /* no signing key yet: the page still renders, key rotation shows no "current" key */ }
        view = await loadAgentChannelView(await appDb(), {signingPublicKeyPem});
    }
    const transport = checkChannelTransport(getServerUrl(), forkEnv());
    return (
        <Page>
            <PageHeader><PageTitle>{AGENT_CHANNEL.page.title}</PageTitle></PageHeader>
            <PageDescription>{AGENT_CHANNEL.page.intro}</PageDescription>
            <PageContent>
                {canManage && view ? <AgentChannelPanel view={view} lockedReason={lockedReason} transport={transport}/> : <p className="text-sm">{AGENT_CHANNEL.page.notAdmin}</p>}
            </PageContent>
        </Page>
    );
}
