import {currentUser} from "@/lib/auth/current-user";
import {currentForkMode} from "@/fork/mode";
import {buildForkNav} from "@/fork/nav";
import {ForkSidebarNav} from "@/fork/ui/fork-sidebar-groups.client";

/**
 * Server component rendered as a SIBLING of upstream's `<SidebarMenuCustomMain/>` (hook P05).
 * Flags off ⇒ returns null before touching the session: rendered HTML is identical to upstream.
 */
export async function ForkSidebarGroups() {
    const mode = await currentForkMode();
    if (mode.mode !== "on") return null;
    const user = await currentUser();
    if (!user) return null;
    const groups = buildForkNav(mode.mode, {systemRole: user.role});
    if (groups.length === 0) return null;
    return <ForkSidebarNav groups={groups}/>;
}
