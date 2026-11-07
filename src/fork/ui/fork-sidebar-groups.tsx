import {actorIn} from "@/fork/acl";
import {soleOrganization} from "@/fork/arcane/connection-service";
import {appDb} from "@/fork/db/handle";
import {currentForkMode} from "@/fork/mode";
import {buildForkNav} from "@/fork/nav";
import {getForkPrincipal} from "@/fork/principal";
import {ForkSidebarNav} from "@/fork/ui/fork-sidebar-groups.client";

/**
 * Server component rendered as a SIBLING of upstream's `<SidebarMenuCustomMain/>` (hook P05).
 * Flags off ⇒ returns null before touching the session: rendered HTML is identical to upstream.
 * W08: org members see "Docker Stacks" (stacks.view), so the actor carries the membership role in the single organization;
 * pending/banned accounts resolve to no principal and see nothing.
 */
export async function ForkSidebarGroups() {
    const mode = await currentForkMode();
    if (mode.mode !== "on") return null;
    const principal = await getForkPrincipal();
    if (!principal) return null;
    const organizationId = await soleOrganization(await appDb());
    const actor = organizationId ? actorIn(principal, organizationId) : {systemRole: principal.systemRole ?? null, orgRole: null};
    const groups = buildForkNav(mode.mode, actor);
    if (groups.length === 0) return null;
    return <ForkSidebarNav groups={groups}/>;
}
