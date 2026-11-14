import type {MirrorView} from "@/fork/mirror/view";
import {MIRRORS, reasonText} from "@/fork/ui/mirrors/labels";
import {isActiveRevision} from "@/fork/ui/mirrors/model";

const H = MIRRORS.history;
const when = (iso: string) => iso.replace("T", " ").slice(0, 16);
const dur = (s: number | null) => (s === null ? "" : s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`);

/** Refresh History tab: every revision, newest first (no Refresh / Rollback controls until W24 / W25). */
export function HistoryTab({view, rpDates}: {view: MirrorView; rpDates: Record<string, string>}) {
    if (view.revisions.length === 0) return <p className="text-sm">{H.empty}</p>;
    return (
        <div className="space-y-3" data-testid="history-tab">
            <div role="region" aria-label={H.region} tabIndex={0} className="overflow-x-auto rounded-lg border">
                <table className="w-full text-left text-sm">
                    <caption className="sr-only">{H.title}</caption>
                    <thead><tr className="border-b">{(["rev", "rp", "created", "outcome", "duration", "wipe"] as const).map((k) => <th key={k} scope="col" className="px-3 py-2 font-semibold whitespace-nowrap">{H.cols[k]}</th>)}</tr></thead>
                    <tbody>{view.revisions.map((r) => {
                        const isActive = r.id === view.mirror.activeRevisionId;
                        const outcome = r.state === "ready" ? H.ready : r.state === "cancelled" ? H.cancelled : isActiveRevision(r.state) ? H.inProgress : reasonText(r.reason);
                        const wipe = r.state === "ready" ? (r.wipeState ? H.wipe[r.wipeState as keyof typeof H.wipe] ?? H.wipe.none : H.wipe.kept)
                            : r.wipeState ? H.wipe[r.wipeState as keyof typeof H.wipe] ?? "" : isActiveRevision(r.state) ? "" : H.wipe.running;
                        return (
                            <tr key={r.id} data-testid="history-row" data-active={isActive} className="border-b align-top last:border-0">
                                <th scope="row" className="px-3 py-2 font-medium whitespace-nowrap">#{r.seq}{isActive && <span className="ml-2 rounded border px-1.5 py-0.5 text-xs" data-testid="history-active">{H.active}</span>}</th>
                                <td className="px-3 py-2 whitespace-nowrap">#{r.rpSequence}{rpDates[String(r.rpSequence)] ? ` · ${rpDates[String(r.rpSequence)]?.slice(0, 10)}` : ""}</td>
                                <td className="px-3 py-2 whitespace-nowrap">{when(r.createdAt)} UTC</td>
                                <td className="px-3 py-2">{outcome}</td>
                                <td className="px-3 py-2 whitespace-nowrap">{dur(r.readiedAt ? Math.max(0, Math.round((new Date(r.readiedAt).getTime() - new Date(r.createdAt).getTime()) / 1000)) : null)}</td>
                                <td className="px-3 py-2">{wipe}</td>
                            </tr>
                        );
                    })}</tbody>
                </table>
            </div>
            <p className="text-muted-foreground text-sm">{H.note}</p>
        </div>
    );
}
