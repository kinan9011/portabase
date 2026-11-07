"use client";

import * as React from "react";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {RadioGroup, RadioGroupItem} from "@/components/ui/radio-group";
import {CONFIGURE} from "@/fork/ui/labels";
import {SecretInput, type SecretHandle} from "@/fork/ui/secret-input";
import type {ConfigureView} from "@/fork/stack-policy/configure-view";
import type {PreviewView} from "@/fork/stack-policy/preview";
import type {DbFieldError, DbForm, WizardState} from "./model";
import type {ServerIssue} from "./resources-section";

const C = CONFIGURE.consistency;

function DbBlock({db, f, st, set, errors, serverIssues, secretRefs, secretPresent, setPresent, storedCredential}: {
    db: ConfigureView["databases"][number]; f: DbForm; st: WizardState; set: (p: Partial<WizardState>) => void; errors: readonly DbFieldError[]; serverIssues: readonly ServerIssue[];
    secretRefs: React.RefObject<Record<string, SecretHandle | null>>; secretPresent: Record<string, boolean>; setPresent: (service: string, has: boolean) => void; storedCredential: boolean;
}) {
    const id = React.useId();
    const patch = (p: Partial<DbForm>) => set({databases: {...st.databases, [db.service]: {...f, ...p}}});
    const err = (field: DbFieldError["field"]) => errors.some((e) => e.service === db.service && e.field === field);
    const server = serverIssues.filter((i) => i.field === `databases:${db.service}`);
    const modeLabel = (m: DbForm["mode"]) => (m === "files" ? C.files : m === "sqlite" ? C.sqlite : C.dump);
    const modes: DbForm["mode"][] = db.mode === "unsupported" ? ["files"] : [db.mode, "files"];
    const field = (k: "host" | "port" | "username" | "database", type = "text") => (
        <div className="flex flex-col gap-1.5" key={k}>
            <Label htmlFor={`${id}-${k}`}>{C.fields[k]}<span aria-hidden="true"> *</span></Label>
            <Input id={`${id}-${k}`} type={type} inputMode={k === "port" ? "numeric" : undefined} value={f[k]} aria-invalid={err(k) ? true : undefined} aria-describedby={k === "host" ? `${id}-host-hint` : undefined} onChange={(e) => patch({[k]: e.target.value})}/>
        </div>
    );
    return (
        <fieldset className="flex flex-col gap-3 rounded-lg border p-3" data-testid="db-block" data-service={db.service}>
            <legend className="px-1 text-sm font-medium">{db.service} <span className="text-muted-foreground font-normal">({db.engine})</span></legend>
            <RadioGroup value={f.mode} onValueChange={(v) => patch({mode: v as DbForm["mode"]})} aria-label={`${db.service}: ${C.dump}`}>
                {modes.map((m) => (
                    <div key={m} className="flex items-center gap-2">
                        <RadioGroupItem id={`${id}-${m}`} value={m}/><Label htmlFor={`${id}-${m}`}>{modeLabel(m)}</Label>
                    </div>
                ))}
            </RadioGroup>
            {db.mode === "unsupported" && <p className="text-muted-foreground text-sm">{C.unsupported(db.engine)}</p>}
            {f.mode === "files" && db.mode !== "unsupported" && <p role="note" className="text-sm">{C.filesWarning}</p>}
            {f.mode === "dump" && (
                <div className="grid gap-3 sm:grid-cols-2">
                    <div className="sm:col-span-2 flex flex-col gap-1">{field("host")}<p id={`${id}-host-hint`} className="text-muted-foreground text-xs">{C.hostHint}</p></div>
                    {db.fields.filter((x) => x !== "host").map((x) => field(x, x === "port" ? "number" : "text"))}
                    {db.secret && (
                        <div className="sm:col-span-2 flex flex-col gap-1">
                            <SecretInput ref={(h) => { secretRefs.current[db.service] = h; }} label={C.fields.password} name={`db-password-${db.service}`} required={!storedCredential} describedBy={`${id}-pw`} onPresenceChange={(has) => { if (secretPresent[db.service] !== has) setPresent(db.service, has); }}/>
                            <p id={`${id}-pw`} className="text-muted-foreground text-xs">{C.passwordStored}</p>
                        </div>
                    )}
                </div>
            )}
            {f.mode === "sqlite" && (
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${id}-path`}>{C.sqlitePath}<span aria-hidden="true"> *</span></Label>
                    <Input id={`${id}-path`} className="font-mono" value={f.path} aria-invalid={err("path") ? true : undefined} onChange={(e) => patch({path: e.target.value})} placeholder="/srv/app/data/app.db"/>
                </div>
            )}
            {server.map((e) => <p key={e.code} role="alert" className="text-destructive text-sm">{CONFIGURE.fieldErrors[e.code]}</p>)}
        </fieldset>
    );
}

export function ConsistencySection({view, st, set, preview, dbErrors, serverIssues, secretRefs, secretPresent, setPresent}: {
    view: ConfigureView; st: WizardState; set: (p: Partial<WizardState>) => void; preview: PreviewView; dbErrors: readonly DbFieldError[]; serverIssues: readonly ServerIssue[];
    secretRefs: React.RefObject<Record<string, SecretHandle | null>>; secretPresent: Record<string, boolean>; setPresent: (service: string, has: boolean) => void;
}) {
    return (
        <div className="flex flex-col gap-4">
            <p className="text-muted-foreground text-sm">{C.intro}</p>
            {preview.stopHints.length > 0 && (
                <p role="note" data-testid="stop-label-note" className="rounded-md border p-3 text-sm">{C.stopLabel} {C.stopFor(preview.stopHints.join(", "))}</p>
            )}
            {view.databases.length === 0 ? <p className="text-sm">{C.none}</p> : view.databases.map((d) => (
                <DbBlock key={d.service} db={d} f={st.databases[d.service]} st={st} set={set} errors={dbErrors} serverIssues={serverIssues} secretRefs={secretRefs} secretPresent={secretPresent} setPresent={setPresent}
                    storedCredential={view.existing.active && view.existing.selection.databases[d.service]?.kind === "dump"}/>
            ))}
        </div>
    );
}
