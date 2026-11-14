import type {MirrorDetailExtras} from "@/fork/mirror/list-view";
import type {MirrorView} from "@/fork/mirror/view";
import {GATES} from "@/fork/mirror/vocab";
import {ENV_ACTION_TEXT, GATE_TEXT, MIRRORS, reasonText, type EnvActionKey} from "@/fork/ui/mirrors/labels";
import {ago} from "@/fork/ui/mirrors/model";
import {ToneBadge} from "@/fork/ui/tone-badge";

const C = MIRRORS.config;
const mem = (b: number) => (b >= 1073741824 ? `${+(b / 1073741824).toFixed(2)} GiB` : `${Math.round(b / 1048576)} MiB`);
const cpus = (n: number) => `${+(n / 1e9).toFixed(2)}`;

/** Configuration tab: value-free policy, the fixed Strict isolation profile and the isolation evidence of the ACTIVE revision. Presentational, no hooks. */
export function ConfigurationTab({view, extras, now}: {view: MirrorView; extras: MirrorDetailExtras; now: string}) {
    const cfg = extras.config;
    const at = new Date(now);
    const active = view.revisions.find((r) => r.id === view.mirror.activeRevisionId) ?? view.revisions[0];
    const iso = extras.runnerIsolation;
    return (
        <div className="space-y-6" data-testid="config-tab">
            <dl className="grid max-w-3xl gap-x-6 gap-y-3 text-sm sm:grid-cols-[14rem_1fr]">
                <dt className="font-medium">{C.access}</dt>
                <dd data-testid="config-access">{cfg.access && cfg.access.hostPort !== null ? `${cfg.access.service}:${cfg.access.target} · ${C.accessValue(cfg.access.hostPort, view.mirror.runnerName)}` : C.accessNone}</dd>
                <dt className="font-medium">{C.healthPath}</dt>
                <dd data-testid="config-health-path">{cfg.httpPath ?? C.healthPathNone}</dd>
                <dt className="font-medium">{C.limits}</dt>
                <dd>{C.limitsValue(mem(cfg.limits.memBytes), cfg.limits.pids, cpus(cfg.limits.nanoCpus))}</dd>
                <dt className="font-medium">{C.profile}</dt>
                <dd>{C.profileValue}</dd>
            </dl>

            <section aria-labelledby="cfg-evidence-h" data-testid="config-evidence">
                <h2 id="cfg-evidence-h" className="mb-1 text-lg font-semibold">{C.evidence}</h2>
                <p className="text-muted-foreground mb-2 text-sm">{C.evidenceNote}</p>
                <ul className="divide-y rounded-lg border">
                    {GATES.map((g) => {
                        const v = active?.gates[g] ?? null;
                        return (
                            <li key={g} data-testid="config-gate" className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3 text-sm">
                                <span className="min-w-0 flex-1 font-medium">{GATE_TEXT[g]}</span>
                                <ToneBadge tone={v === null ? "neutral" : v.ok ? "success" : "danger"}>{v === null ? C.notReached : v.ok ? MIRRORS.progress.gate.ok : reasonText(v.code)}</ToneBadge>
                                {active?.readiedAt && v?.ok && <span className="text-muted-foreground text-xs">{ago(active.readiedAt, at)}</span>}
                            </li>
                        );
                    })}
                </ul>
                <p className="mt-2 text-sm" data-testid="config-runner-isolation"><span className="font-medium">{C.runnerNow}: </span>
                    {iso.state === "isolated" ? C.runnerState.isolated(ago(iso.probedAt, at)) : iso.state === "not_isolated" ? C.runnerState.not_isolated : C.runnerState.unknown}</p>
            </section>

            <section aria-labelledby="cfg-env-h" data-testid="config-env">
                <h2 id="cfg-env-h" className="mb-1 text-lg font-semibold">{C.env}</h2>
                {cfg.overrides === null
                    ? <p className="text-sm">{C.envCounts(cfg.overrideCount, cfg.keptCount)}</p>
                    : cfg.overrides.length === 0 ? <p className="text-sm">{C.envNone}</p> : (
                        <div role="region" aria-label={C.envTable} tabIndex={0} className="max-w-3xl overflow-x-auto rounded-lg border">
                            <table className="w-full text-left text-sm"><thead><tr className="border-b"><th scope="col" className="px-3 py-2">Service</th><th scope="col" className="px-3 py-2">Setting</th><th scope="col" className="px-3 py-2">What happens</th></tr></thead>
                                <tbody>{cfg.overrides.map((o) => (
                                    <tr key={`${o.service}.${o.key}`} className="border-b last:border-0" data-testid="config-override"><td className="px-3 py-2">{o.service}</td><td className="px-3 py-2 break-all font-mono">{o.key}</td>
                                        <td className="px-3 py-2">{ENV_ACTION_TEXT[o.action as EnvActionKey]}{o.action === "keep_exact" ? ` (${C.envKept})` : ""}</td></tr>
                                ))}</tbody></table>
                        </div>
                    )}
                <p className="text-muted-foreground mt-2 text-sm">{C.footer}</p>
            </section>
        </div>
    );
}
