import { ReactNode } from "react";
import {
    Sidebar,
    SidebarContent,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuItem
} from "@/components/ui/sidebar";
import {SidebarLogo} from "@/features/layout/components/logo-sidebar";
import {SidebarMenuCustomMain} from "@/features/layout/components/menu-sidebar-main";
import {SideBarFooterCredit} from "@/features/layout/components/side-bar-footer-credit";
import {OrganizationCombobox} from "@/features/organizations/components/organization-combobox";
import {env} from "@/env.mjs";
import {LoggedInButton} from "@/features/layout/components/logged-in-button.server";
// FORK(stack-recovery): P05 sibling sidebar groups (import)
import {ForkSidebarGroups} from "@/fork/ui/fork-sidebar-groups";

export function AppSidebar({ updateNotification }: { updateNotification?: ReactNode } = {}) {
    const projectName = env.PROJECT_NAME;
    return (
        <Sidebar collapsible="icon">
            <SidebarHeader>
                <SidebarMenu>
                    <SidebarMenuItem>
                        <SidebarLogo projectName={projectName ?? "Portabase"}/>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                        <OrganizationCombobox/>
                    </SidebarMenuItem>
                </SidebarMenu>
            </SidebarHeader>
            <SidebarContent>
                <SidebarMenuCustomMain/>
                <ForkSidebarGroups/>{/* FORK(stack-recovery): P05 sibling, null when flags off */}
            </SidebarContent>
            {updateNotification}
            <SidebarMenu className="mb-2">
                <SidebarMenuItem className="p-2">
                    <LoggedInButton/>
                </SidebarMenuItem>
            </SidebarMenu>
            <SideBarFooterCredit/>
        </Sidebar>
    );
}