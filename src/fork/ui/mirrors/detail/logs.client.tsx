"use client";

import {useRouter} from "next/navigation";
import {Button} from "@/components/ui/button";
import type {MirrorLogEntry} from "@/fork/mirror/list-view";
import {MIRRORS, reasonText} from "@/fork/ui/mirrors/labels";

const G = MIRRORS.logs;
const when = (iso: string) => `${iso.replace("T", " ").slice(0, 19)} UTC`;

/** Logs tab: server-built timeline (events + step journal), redacted by construction. No polling: Reload re-reads the server state. */
export function LogsTab({entries}: {entries: MirrorLogEntry[]}) {
    const router = useRouter();
    return (
        <div className="space-y-3" data-testid="logs-tab">
            <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">{G.title}</h2>
                <Button type="button" variant="outline" size="sm" onClick={() => router.refresh()} data-testid="logs-reload">{G.reload}</Button></div>
            {entries.length === 0 ? <p className="text-sm">{G.empty}</p> : (
                <div role="region" aria-label={G.region} tabIndex={0} className="overflow-x-auto rounded-lg border">
                    <table className="w-full text-left text-sm">
                        <thead><tr className="border-b">{(["when", "what", "result"] as const).map((k) => <th key={k} scope="col" className="px-3 py-2 font-semibold whitespace-nowrap">{G.cols[k]}</th>)}</tr></thead>
                        <tbody>{entries.map((e, i) => (
                            <tr key={`${e.at}-${i}`} data-testid="log-row" data-kind={e.kind} className="border-b align-top last:border-0">
                                <td className="px-3 py-2 whitespace-nowrap">{when(e.at)}</td>
                                <td className="px-3 py-2">{e.title}{e.actor ? <span className="text-muted-foreground"> · {G.actor[e.actor]}</span> : null}</td>
                                <td className="px-3 py-2">{e.kind === "task" ? <>{G.status[e.status ?? ""] ?? e.status}{e.durationSeconds !== null ? ` · ${e.durationSeconds} s` : ""}{e.code ? ` · ${reasonText(e.code)}` : ""}</> : e.code ? reasonText(e.code) : ""}</td>
                            </tr>
                        ))}</tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
