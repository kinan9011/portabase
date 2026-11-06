import {NextResponse} from "next/server";
import {currentUser} from "@/lib/auth/current-user";
import {forkCan} from "@/fork/acl";
import {forkEnv} from "@/fork/env";
import {currentForkMode, getLaneStatus} from "@/fork/mode";
import {forkBannerText} from "@/fork/self-check";

// Fork diagnostic (W01): proves the proxy allowlist + server-side ACL wiring. Booleans/enums only, no secrets.
export const dynamic = "force-dynamic";

const notFound = () => NextResponse.json({message: "This API route does not exist.", status: 404}, {status: 404});

export async function GET() {
    const mode = await currentForkMode();
    if (mode.mode === "off") return notFound();
    const user = await currentUser();
    if (!user || !forkCan({systemRole: user.role}, "arcane.manage")) return notFound();
    const e = forkEnv();
    return NextResponse.json({
        mode: mode.mode,
        lockReason: mode.lockReason ?? null,
        // Fixed strings built from stable codes (no names/ids). `warnings` = advisory codes (e.g. mcp-enabled), never a lock.
        banner: forkBannerText(mode),
        warnings: mode.warnings ?? [],
        lane: getLaneStatus().state,
        flags: {stacks: e.FORK_STACKS_ENABLED, arcane: e.FORK_ARCANE_ENABLED, mirrors: e.FORK_MIRRORS_ENABLED},
    });
}
