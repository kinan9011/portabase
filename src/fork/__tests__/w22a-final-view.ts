import {ACCESS, CLEAN_RAW, labViewJson, PROJECT, WS} from "@/fork/__tests__/fixtures/compose-compiler/lab";
import {compileMirror, type MirrorSpecV1} from "@/fork/compose-compiler/compile";
import {blankPolicyView} from "@/fork/restore-tasks/view";

type Doc = Record<string, any>; // biome-ignore lint/suspicious/noExplicitAny: compose JSON
export const LIMITS = {mem_bytes: 1073741824, pids: 512, nano_cpus: 1_000_000_000};
const OWNER = (rid: string) => ({"com.portabase.fork.restore_id": rid, "com.portabase.fork.agent_id": "11111111-1111-4111-8111-111111111111"});

export function compiledLab(): {spec: MirrorSpecV1; specSha: string; sourceText: string} {
    const c = compileMirror({view: labViewJson(), raw: CLEAN_RAW, options: {project: PROJECT, workspace: WS, access: ACCESS}});
    if (!c.ok) throw new Error(`lab does not compile: ${JSON.stringify(c.refusals)}`);
    return {spec: c.spec, specSha: c.spec_sha256, sourceText: labViewJson()};
}

/** What the runner's `mirror_finalize` would upload (policy view of `compose config` of out.json): the spec skeleton + owner labels + limits. Test-only emulation. */
export function finalViewOf(spec: MirrorSpecV1, restoreId: string, over?: (v: Doc) => void): Doc {
    const full = JSON.parse(JSON.stringify(spec.view)) as Doc;
    const v = full;
    for (const s of Object.values(v.services ?? {}) as Doc[]) {
        s.labels = {...(s.labels ?? {}), ...OWNER(restoreId)};
        s.mem_limit = LIMITS.mem_bytes; s.pids_limit = LIMITS.pids; s.cpus = LIMITS.nano_cpus / 1e9;
    }
    for (const section of ["networks", "volumes"]) for (const d of Object.values(v[section] ?? {}) as Doc[]) d.labels = {...(d.labels ?? {}), ...OWNER(restoreId)};
    const blanked = blankPolicyView(v) as Doc; // the runner uploads the BLANKED view (service labels lose their values)
    over?.(blanked);
    return blanked;
}
