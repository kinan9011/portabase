import Link from "next/link";
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from "@/components/ui/table";
import type {ArtifactView, BackupRow, BackupsView} from "@/fork/stacks/backups-view";
import {BACKUPS, RP_STATUS_LABELS} from "@/fork/ui/labels";
import {ReasonButton} from "@/fork/ui/disabled-reason";
import {fmtBytes, fmtDuration, fmtZoned, stackHref} from "@/fork/ui/stacks/format";
import {ScrollRegion} from "@/fork/ui/stacks/scroll-region";
import {StateNotice} from "@/fork/ui/stacks/stack-empty-states";
import {RpStatusBadge} from "@/fork/ui/stacks/stack-status-badges";
import {RunNowButton} from "@/fork/ui/stacks/run-controls.client";

const B = BACKUPS;
const href = (stackId: string, seq: number | null) => `${stackHref(stackId, "backups")}${seq === null ? "" : `&rp=${seq}`}`;

/** The verification cell: only a `verified` recovery point says "Verified" (D43); everything else says plainly that it is not. */
export function verificationText(r: Pick<BackupRow, "status" | "verifiedAt">, tz: string): string {
    return r.status === "verified" ? B.verification.verified(fmtZoned(r.verifiedAt, tz)) : B.verification[r.status];
}

function Detail({stackId, row, artifacts, tz}: {stackId: string; row: BackupRow; artifacts: ArtifactView[]; tz: string}) {
    const D = B.detail;
    const archives = artifacts.filter((a) => a.kind !== "restic_snapshot");
    return (
        <section aria-labelledby="rp-detail-heading" data-testid="rp-detail" data-sequence={row.sequence} className="flex flex-col gap-4 rounded-xl border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id="rp-detail-heading" className="text-lg font-semibold">{D.heading(row.sequence)}</h3>
                <Link href={href(stackId, null)} className="text-sm font-medium underline underline-offset-4" data-testid="rp-detail-close">{D.close}</Link>
            </div>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[12rem_1fr]">
                <dt className="text-muted-foreground">{B.columns.status}</dt>
                <dd className="flex flex-wrap items-center gap-2"><RpStatusBadge status={row.status}/><span className="text-muted-foreground">{RP_STATUS_LABELS[row.status].description}</span></dd>
                <dt className="text-muted-foreground">{B.columns.verification}</dt><dd data-testid="rp-detail-verification">{verificationText(row, tz)}</dd>
                <dt className="text-muted-foreground">{D.coverage}</dt><dd>{D.coverageValue(row.present, row.required)}</dd>
                <dt className="text-muted-foreground">{D.inventory}</dt><dd>{row.inventoryVersion ?? "—"}</dd>
                <dt className="text-muted-foreground">{B.columns.consistency}</dt><dd>{B.consistency[row.consistency]}</dd>
                {row.trigger && <><dt className="text-muted-foreground">{B.columns.time}</dt><dd>{fmtZoned(row.createdAt, tz)} · {B.trigger[row.trigger]}</dd></>}
                <dt className="text-muted-foreground">{D.warnings}</dt><dd data-testid="rp-detail-warnings">{row.reason ? B.reasons[row.reason] : D.noWarnings}</dd>
            </dl>
            <div className="flex flex-col gap-2">
                <h4 className="font-medium">{D.artifacts}</h4>
                {artifacts.length === 0 ? <p className="text-muted-foreground text-sm">{D.noArtifacts}</p> : (
                    <ScrollRegion label={`${D.artifacts} table`}>
                        <Table>
                            <TableHeader><TableRow>{Object.values(D.artifactColumns).map((c) => <TableHead key={c}>{c}</TableHead>)}</TableRow></TableHeader>
                            <TableBody>
                                {artifacts.map((a) => (
                                    <TableRow key={`${a.source}:${a.kind}:${a.destination ?? "-"}`} data-testid="artifact-row">
                                        <TableCell className="font-medium">{a.source}</TableCell>
                                        <TableCell>{D.kind[a.kind]}</TableCell>
                                        <TableCell>{a.destination ?? "—"}</TableCell>
                                        <TableCell>{fmtBytes(a.sizeBytes) ?? "—"}</TableCell>
                                        <TableCell>{a.encrypted ? D.yes : D.no}</TableCell>
                                        <TableCell className="font-mono text-xs">{a.checksum.short ? `${a.checksum.short}…` : D.checksumNone}</TableCell>
                                        <TableCell>{D.presence[a.presence]}</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </ScrollRegion>
                )}
            </div>
            <div className="flex flex-col gap-1" data-testid="rp-integrity">
                <h4 className="font-medium">{D.integrity}</h4>
                <ul className="list-disc pl-5 text-sm">
                    <li>{D.integrityRows.encrypted(artifacts.length > 0 && artifacts.every((a) => a.encrypted))}</li>
                    <li>{D.integrityRows.checksum(archives.filter((a) => a.checksum.recorded).length, archives.length)}</li>
                    <li>{D.integrityRows.presence(artifacts.filter((a) => a.presence === "present").length, artifacts.length)}</li>
                    <li>{D.integrityRows.signature}</li>
                </ul>
            </div>
        </section>
    );
}

/**
 * Backups tab (W13): the recovery points with their honest status ("Backed up · verifying" until the W14 verify job passes), the selected point's artifacts
 * and integrity facts, and the actions: Back up now (real, `backup.run`), Verify / Restore / Mirror visibly disabled with the reason as text.
 */
export function BackupsTab({stackId, view, runReason}: {stackId: string; view: BackupsView | null; runReason: string | null}) {
    const actions = (
        <div className="flex flex-wrap items-start gap-3" data-testid="backups-actions">
            <RunNowButton stackId={stackId} label={B.runNow} reason={runReason} testId="backups-run-now"/>
            <ReasonButton type="button" variant="outline" reason={B.verify.reason} data-testid="backups-verify">{B.verify.label}</ReasonButton>
            <ReasonButton type="button" variant="outline" reason={B.restore.reason} data-testid="backups-restore">{B.restore.label}</ReasonButton>
            <ReasonButton type="button" variant="outline" reason={B.mirror.reason} data-testid="backups-mirror">{B.mirror.label}</ReasonButton>
        </div>
    );
    if (!view) return <StateNotice testId="backups-error" tone="warning" title="Recovery points are not available" body="They could not be loaded for this stack."/>;
    const tz = view.timezone;
    return (
        <section aria-labelledby="backups-heading" data-testid="backups-tab" className="flex flex-col gap-4">
            <h2 id="backups-heading" className="text-lg font-semibold">{B.heading}</h2>
            {actions}
            {view.rows.length === 0 ? <StateNotice testId="backups-none" title={B.none.title} body={B.none.body}/> : (
                <>
                    <p className="text-muted-foreground text-sm" data-testid="backups-count">{B.count(view.shown, view.total)}</p>
                    <ScrollRegion label={`${B.heading} table`}>
                        <Table data-testid="rp-table">
                            <TableHeader><TableRow>{Object.values(B.columns).map((c) => <TableHead key={c}>{c}</TableHead>)}</TableRow></TableHeader>
                            <TableBody>
                                {view.rows.map((r) => {
                                    const selected = view.detail?.row.sequence === r.sequence;
                                    return (
                                        <TableRow key={r.sequence} data-testid="rp-row" data-sequence={r.sequence} data-status={r.status} aria-selected={selected || undefined}>
                                            <TableCell className="font-medium"><Link href={href(stackId, r.sequence)} aria-current={selected ? "true" : undefined} className="underline underline-offset-4" aria-label={`${B.detail.open}: #${r.sequence}`}>#{r.sequence}</Link></TableCell>
                                            <TableCell className="whitespace-nowrap">{fmtZoned(r.createdAt, tz)}</TableCell>
                                            <TableCell>{B.consistency[r.consistency]}</TableCell>
                                            <TableCell>{r.destinations.length > 0 ? r.destinations.join(", ") : "—"}</TableCell>
                                            <TableCell>{fmtBytes(r.sizeBytes) ?? "—"}</TableCell>
                                            <TableCell>{fmtDuration(r.durationSeconds) ?? "—"}</TableCell>
                                            <TableCell data-testid="rp-verification">{verificationText(r, tz)}</TableCell>
                                            <TableCell>
                                                <span className="flex flex-col items-start gap-1">
                                                    <RpStatusBadge status={r.status}/>
                                                    {r.reason && <span className="text-muted-foreground max-w-56 text-xs">{B.reasons[r.reason]}</span>}
                                                </span>
                                            </TableCell>
                                        </TableRow>
                                    );
                                })}
                            </TableBody>
                        </Table>
                    </ScrollRegion>
                </>
            )}
            {view.detail && <Detail stackId={stackId} row={view.detail.row} artifacts={view.detail.artifacts} tz={tz}/>}
        </section>
    );
}
