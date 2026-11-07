"use client";

import {Layers, LifeBuoy, Plug} from "lucide-react";
import {type SidebarGroupItem, SidebarMenuCustomBase } from "@/features/layout/components/menu-sidebar";
import type {ForkNavGroup} from "@/fork/nav";

const ICONS = {plug: Plug, layers: Layers, "life-buoy": LifeBuoy} as const;

/** Reuses upstream `SidebarMenuCustomBase` (no copy, no type change, no badge). */
export function ForkSidebarNav({groups}: { groups: ForkNavGroup[] }) {
    const items: SidebarGroupItem[] = groups.map((g) => ({
        label: g.label,
        type: "list",
        group_content: g.items.map((i) => ({title: i.title, url: i.url, icon: ICONS[i.iconKey], type: "item" as const})),
    }));
    return <SidebarMenuCustomBase baseUrl="/dashboard" items={items}/>;
}
