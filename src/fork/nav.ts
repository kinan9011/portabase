import {forkCan, type ForkActor, type ForkCapability} from "@/fork/acl";
import type {ForkMode} from "@/fork/mode";

/** Serialisable nav model (server → client: icons travel as keys, never as component functions). */
export type ForkNavItem = { title: string; url: string; iconKey: "plug" | "layers" | "life-buoy" | "radio" | "flask" };
export type ForkNavGroup = { label: string; items: ForkNavItem[] };

type Def = ForkNavItem & {
    capability: ForkCapability;
    /** Wave that ships the page. Items of unshipped waves are never rendered (no dead links). */
    wave: string;
    shipped: boolean;
    /** Item only shown while this feature flag is on (W23: Test Mirrors needs `FORK_MIRRORS_ENABLED`). */
    flag?: NavFlag;
};
export type NavFlag = "mirrors";
export type NavFlags = Record<NavFlag, boolean>;

export const FORK_NAV_DEFS: readonly Def[] = [
    {title: "Integrations", url: "/integrations", iconKey: "plug", capability: "arcane.manage", wave: "W01", shipped: true},
    {title: "Agent channel", url: "/integrations/agent-channel", iconKey: "radio", capability: "agents.channel.manage", wave: "W15b", shipped: true},
    {title: "Docker Stacks", url: "/stacks", iconKey: "layers", capability: "stacks.view", wave: "W08", shipped: true},
    // Recovery shipped in W18b (R2, D13): shown for `recovery.view` holders in mode `on` only (flags off / locked ⇒ no fork nav at all).
    {title: "Recovery", url: "/recovery", iconKey: "life-buoy", capability: "recovery.view", wave: "W18b", shipped: true},
    // Test Mirrors shipped in W23 (R3): `mirrors.view` holders, only while the mirror feature flag is on (no badge, ARCH-15/UX-14).
    {title: "Test Mirrors", url: "/mirrors", iconKey: "flask", capability: "mirrors.view", wave: "W23", shipped: true, flag: "mirrors"},
];

export const FORK_NAV_LABEL = "Stack Recovery";

/** Pure: nothing unless mode is "on" (locked/off render no navigation in W01). */
export function buildForkNav(mode: ForkMode, actor: ForkActor | null, flags: NavFlags = {mirrors: false}): ForkNavGroup[] {
    if (mode !== "on" || !actor) return [];
    const items = FORK_NAV_DEFS.filter((d) => d.shipped && (!d.flag || flags[d.flag]) && forkCan(actor, d.capability)).map(({title, url, iconKey}) => ({title, url, iconKey}));
    return items.length ? [{label: FORK_NAV_LABEL, items}] : [];
}
