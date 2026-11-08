import {notFound, redirect} from "next/navigation";
import {currentForkMode} from "@/fork/mode";
import {getForkPrincipal} from "@/fork/principal";

// Breadcrumb target (W27a P0): the layout's breadcrumb links every path segment, but only /recovery/plans/[id] exists. Same real-404 gate as the recovery home (mode off / no usable principal → 404, never a redirect that reveals the route); the home applies the role gate.
export const dynamic = "force-dynamic";

export default async function RecoveryPlansIndexPage() {
    if ((await currentForkMode()).mode === "off") notFound();
    if (!(await getForkPrincipal())) notFound();
    redirect("/dashboard/recovery");
}
