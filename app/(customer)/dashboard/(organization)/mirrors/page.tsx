import {notFound, redirect} from "next/navigation";
import {currentForkMode} from "@/fork/mode";
import {getForkPrincipal} from "@/fork/principal";

// Breadcrumb target (W22b, like the W27a recovery index): the layout's breadcrumb links every path segment, but only /mirrors/new and /mirrors/[id] exist until W23 adds the list.
// Same real-404 gate as the other fork pages (mode off / no usable principal → 404); the stack list is the entry point of "Create test mirror".
export const dynamic = "force-dynamic";

export default async function MirrorsIndexPage() {
    if ((await currentForkMode()).mode === "off") notFound();
    if (!(await getForkPrincipal())) notFound();
    redirect("/dashboard/stacks");
}
