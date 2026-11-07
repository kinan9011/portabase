"use client";

import * as React from "react";
import {Button} from "@/components/ui/button";
import {Checkbox} from "@/components/ui/checkbox";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {ReasonButton} from "@/fork/ui/disabled-reason";
import {CONFIGURE, ITEM_KIND_LABELS, REASON_COPY} from "@/fork/ui/labels";
import {TONE_MAP, type Tone} from "@/fork/ui/tone";
import {ToneBadge} from "@/fork/ui/tone-badge";
import type {ConfigureView} from "@/fork/stack-policy/configure-view";
import type {PreviewView} from "@/fork/stack-policy/preview";
import {composeKey, itemToggleKey, KIND_ORDER, REQUIRED_KINDS, volumeNameError, type WizardState} from "./model";

const R = CONFIGURE.resources;
type Item = PreviewView["items"][number];
const PLAN_TONE: Record<Item["plan"], Tone> = {backed_up: "success", not_backed_up: "warning", external: "neutral", excluded: "neutral", accepted: "neutral"};

export type ServerIssue = {field: string; key: string; code: string};
const issuesFor = (all: readonly ServerIssue[], prefix: string) => all.filter((i) => i.field === prefix || i.field.startsWith(`${prefix}:`));

function GapNotice({item, label, st, set}: {item: Item; label: string; st: WizardState; set: (p: Partial<WizardState>) => void}) {
    const id = React.useId();
    const accepted = st.accepted.includes(item.key);
    return (
        <div className={`rounded-md border p-2 text-sm ${TONE_MAP.warning.panel}`} data-testid="gap-notice">
            <p>{R.notRecoverable}</p>
            <p className="text-muted-foreground text-xs">{REASON_COPY[item.reason] ?? ""}</p>
            <div className="mt-2 flex items-center gap-2">
                <Checkbox id={`${id}-acc`} checked={accepted} onCheckedChange={(v) => set({accepted: v === true ? [...new Set([...st.accepted, item.key])] : st.accepted.filter((k) => k !== item.key)})}/>
                <Label htmlFor={`${id}-acc`} className="text-sm">{R.accept(label)}</Label>
            </div>
        </div>
    );
}

function Row({item, view, st, set}: {item: Item; view: ConfigureView; st: WizardState; set: (p: Partial<WizardState>) => void}) {
    const id = React.useId();
    const toggle = itemToggleKey(item, view);
    const isFile = item.kind === "compose_file" || item.kind === "env_file";
    const required = REQUIRED_KINDS.has(item.kind);
    const included = toggle ? !st.excluded.includes(toggle) : true;
    const gap = item.gap && required;
    const accepted = st.accepted.includes(item.key);
    const label = item.name || ITEM_KIND_LABELS[item.kind] || item.key;
    return (
        <li className="flex flex-col gap-2 rounded-lg border p-3" data-testid="resource-row" data-key={item.key} data-plan={item.plan}>
            <div className="flex flex-wrap items-start gap-3">
                {toggle && !isFile && <Checkbox id={`${id}-in`} checked={included} onCheckedChange={(v) => set({excluded: v === true ? st.excluded.filter((k) => k !== toggle) : [...new Set([...st.excluded, toggle])]})} aria-label={R.include(label)} className="mt-0.5"/>}
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="font-mono text-sm break-all">{label}</span>
                    <span className="text-muted-foreground text-xs">{ITEM_KIND_LABELS[item.kind]}{item.consumers.length > 0 ? ` · ${item.consumers.slice(0, 3).join(", ")}` : ""}</span>
                </div>
                <span className="flex flex-wrap items-center gap-2">
                    <span className="text-muted-foreground text-xs">{required ? R.roleRequired : R.roleOptional}</span>
                    <ToneBadge tone={PLAN_TONE[item.plan]}>{R.plan[item.plan]}</ToneBadge>
                    {item.plan === "excluded" && <ToneBadge tone="active">{R.fromLabel}</ToneBadge>}
                </span>
            </div>
            {item.plan === "excluded" && <p className="text-muted-foreground text-xs">{R.fromLabelNote}</p>}
            {gap && <GapNotice item={item} label={label} st={st} set={set}/>}
            {!gap && item.plan === "accepted" && (
                <div className="flex items-center gap-2 text-sm">
                    <Checkbox id={`${id}-acc`} checked={accepted} onCheckedChange={(v) => set({accepted: v === true ? [...new Set([...st.accepted, item.key])] : st.accepted.filter((k) => k !== item.key)})}/>
                    <Label htmlFor={`${id}-acc`}>{R.accept(label)}</Label>
                </div>
            )}
        </li>
    );
}

export function ResourcesSection({view, st, set, preview, serverIssues}: {view: ConfigureView; st: WizardState; set: (p: Partial<WizardState>) => void; preview: PreviewView; serverIssues: readonly ServerIssue[]}) {
    const id = React.useId();
    const cKey = composeKey(view);
    const files = preview.items.filter((i) => i.kind === "compose_file" || i.kind === "env_file");
    const rest = preview.items.filter((i) => i.kind !== "compose_file" && i.kind !== "env_file");
    const sorted = [...rest].sort((a, b) => KIND_ORDER.indexOf(a.kind as (typeof KIND_ORDER)[number]) - KIND_ORDER.indexOf(b.kind as (typeof KIND_ORDER)[number]));

    // add path / source (D19)
    const [mPath, setMPath] = React.useState("");
    const [mCovers, setMCovers] = React.useState("");
    const coverable = preview.items.filter((i) => i.resolvable && i.gap && !st.manual.some((m) => m.covers.includes(i.key)));
    const addManual = () => {
        if (!mPath.trim().startsWith("/") || !mCovers) return;
        set({manual: [...st.manual, {path: mPath.trim(), covers: [mCovers]}]});
        setMPath(""); setMCovers("");
    };
    const manualReason = !view.rootsConfigured ? R.manual.noRoots : coverable.length === 0 ? R.manual.coversNone : !mPath.trim().startsWith("/") ? null : null;

    // add docker volume by name (SEC-24, field-level, plain words)
    const [vName, setVName] = React.useState("");
    const [vTouched, setVTouched] = React.useState(false);
    const vErr = vTouched && vName.trim() !== "" ? volumeNameError(vName, view, st.includedVolumes, st.excluded) : null;
    const vServer = issuesFor(serverIssues, "volumes");
    const addVolume = () => {
        setVTouched(true);
        const err = volumeNameError(vName, view, st.includedVolumes, st.excluded);
        if (err) return;
        const key = `volume:${vName.trim()}`;
        set({includedVolumes: [...st.includedVolumes, key], excluded: st.excluded.filter((k) => k !== key)});
        setVName(""); setVTouched(false);
    };

    return (
        <div className="flex flex-col gap-5">
            <p className="text-muted-foreground text-sm">{R.intro}</p>
            {preview.items.length === 0 ? <p className="text-sm">{R.none}</p> : (
                <ul aria-label={R.listLabel} className="flex flex-col gap-2" data-testid="resource-list">
                    {cKey && (
                        <li className="flex flex-col gap-2 rounded-lg border p-3" data-testid="compose-folder-row">
                            <div className="flex flex-wrap items-start gap-3">
                                <Checkbox id={`${id}-dir`} checked={!st.excluded.includes(cKey)} onCheckedChange={(v) => set({excluded: v === true ? st.excluded.filter((k) => k !== cKey) : [...st.excluded, cKey]})} aria-label={R.include(view.composeDir ?? "")} className="mt-0.5"/>
                                <div className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="text-sm font-medium">{R.composeDir}</span><span className="font-mono text-xs break-all">{view.composeDir}</span></div>
                                <span className="text-muted-foreground text-xs">{R.roleRequired}</span>
                            </div>
                            <ul className="ml-7 flex flex-col gap-1">
                                {files.map((f) => (
                                    <li key={f.key} className="flex flex-wrap items-center gap-2 text-xs" data-testid="resource-row" data-key={f.key} data-plan={f.plan}>
                                        <span className="min-w-0 flex-1 font-mono break-all">{f.name || ITEM_KIND_LABELS[f.kind]}</span>
                                        <ToneBadge tone={PLAN_TONE[f.plan]}>{R.plan[f.plan]}</ToneBadge>
                                        {f.gap && <div className="w-full"><GapNotice item={f} label={f.name || ITEM_KIND_LABELS[f.kind]} st={st} set={set}/></div>}
                                    </li>
                                ))}
                            </ul>
                        </li>
                    )}
                    {!cKey && files.map((f) => <Row key={f.key} item={f} view={view} st={st} set={set}/>)}
                    {sorted.map((i) => <Row key={i.key} item={i} view={view} st={st} set={set}/>)}
                </ul>
            )}

            <section aria-labelledby={`${id}-manual`} className="flex flex-col gap-3 rounded-lg border p-3" data-testid="manual-sources">
                <h3 id={`${id}-manual`} className="font-medium">{R.manual.heading}</h3>
                <p className="text-muted-foreground text-xs">{R.manual.intro}</p>
                {st.manual.length > 0 && (
                    <ul className="flex flex-col gap-1">
                        {st.manual.map((m, i) => (
                            <li key={m.path} className="flex flex-wrap items-center gap-2 text-sm">
                                <span className="font-mono break-all">{m.path}</span><span className="text-muted-foreground text-xs">{R.manual.addedByYou}</span>
                                <Button type="button" variant="outline" size="sm" onClick={() => set({manual: st.manual.filter((_, j) => j !== i)})}>{R.manual.remove(m.path)}</Button>
                                {issuesFor([...preview.issues, ...serverIssues], `manual:${i}`).map((e) => <span key={e.code} role="alert" className="text-destructive w-full text-sm">{CONFIGURE.fieldErrors[e.code]}</span>)}
                            </li>
                        ))}
                    </ul>
                )}
                <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                    <div className="flex flex-col gap-1.5"><Label htmlFor={`${id}-mp`}>{R.manual.path}</Label><Input id={`${id}-mp`} className="font-mono" value={mPath} onChange={(e) => setMPath(e.target.value)} placeholder="/srv/app/config"/></div>
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor={`${id}-mc`}>{R.manual.covers}</Label>
                        <select id={`${id}-mc`} className="border-input bg-background h-9 rounded-md border px-3 text-sm" value={mCovers} onChange={(e) => setMCovers(e.target.value)}>
                            <option value="">{coverable.length === 0 ? R.manual.coversNone : "—"}</option>
                            {coverable.map((i) => <option key={i.key} value={i.key}>{i.name || ITEM_KIND_LABELS[i.kind]}</option>)}
                        </select>
                    </div>
                    <ReasonButton type="button" variant="outline" reason={manualReason} onClick={addManual}>{R.manual.add}</ReasonButton>
                </div>
            </section>

            <section aria-labelledby={`${id}-vol`} className="flex flex-col gap-3 rounded-lg border p-3" data-testid="add-volume">
                <h3 id={`${id}-vol`} className="font-medium">{R.volume.heading}</h3>
                <p id={`${id}-vol-hint`} className="text-muted-foreground text-xs">{R.volume.intro}</p>
                <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor={`${id}-vn`}>{R.volume.name}</Label>
                        <Input id={`${id}-vn`} className="font-mono" value={vName} aria-invalid={vErr !== null && vErr !== "already" ? true : undefined} aria-describedby={`${id}-vol-hint${vErr || vServer.length ? ` ${id}-vol-err` : ""}`}
                            onChange={(e) => { setVName(e.target.value); setVTouched(true); }}/>
                    </div>
                    <Button type="button" variant="outline" onClick={addVolume}>{R.volume.add}</Button>
                </div>
                {(vErr || vServer.length > 0) && (
                    <p id={`${id}-vol-err`} role="alert" className="text-destructive text-sm" data-testid="volume-error">
                        {vErr === "already" ? R.volume.already : vErr ? CONFIGURE.fieldErrors[vErr] : CONFIGURE.fieldErrors[vServer[0].code]}
                    </p>
                )}
                {st.includedVolumes.length > 0 && <ul className="text-sm">{st.includedVolumes.map((k) => <li key={k}>{R.volume.added(k.slice("volume:".length))}</li>)}</ul>}
            </section>
        </div>
    );
}
