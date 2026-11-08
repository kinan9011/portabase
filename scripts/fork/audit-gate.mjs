#!/usr/bin/env node
// Fork audit gate (W27a F-05, OD-W27-9). Reads `pnpm audit --prod --json` on stdin. FAILS (exit 1) only for high/critical advisories whose package, or any hop of any finding path,
// is a dependency THIS FORK added; upstream-owned paths stay informational (the existing `audit` job is unchanged). A gated advisory can be ACCEPTED here with a written reason
// (dev-only, no fix inside the pinned major) — an accepted id is printed, never silent.
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";

export const FORK_DIRECT = ["yaml", "vitest", "vitest-axe", "axe-core", "jsdom", "@testing-library/react", "@testing-library/dom"];
export const GATED_SEVERITIES = ["high", "critical"];
/** advisory id (GHSA) → reason. tinypool 1.x (pulled by vitest 3.x) has no fix inside vitest 3; vitest is a devDependency that reaches the `--prod` graph only as better-auth's optional peer (OD-W27-7, plan R-4). */
export const ACCEPTED = {
    "GHSA-5gmw-xhrv-c9v3": "tinypool<=2.1.0 via vitest 3.x (dev-only test runner, never shipped: standalone build has no vitest; no fix in the 3.x line) — OD-W27-7",
    "GHSA-85c8-ppgw-ccpr": "tinypool<2.1.2 via vitest 3.x (dev-only test runner, never shipped; no fix in the 3.x line) — OD-W27-7",
};

export function evaluate(report) {
    const gated = [], accepted = [];
    let informational = 0;
    for (const adv of Object.values(report?.advisories ?? {})) {
        const hops = new Set([adv.module_name]);
        for (const f of adv.findings ?? []) for (const p of f.paths ?? []) for (const h of String(p).split(">")) hops.add(h);
        const forkOwned = FORK_DIRECT.some((m) => hops.has(m));
        if (!GATED_SEVERITIES.includes(adv.severity) || !forkOwned) { informational++; continue; }
        const id = adv.github_advisory_id;
        (Object.hasOwn(ACCEPTED, id) ? accepted : gated).push(`${adv.severity} ${adv.module_name} ${id} (${adv.vulnerable_versions} -> ${adv.patched_versions})`);
    }
    return {gated, accepted, informational};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    let report;
    try { report = JSON.parse(readFileSync(0, "utf8")); } catch { console.error("audit-gate: stdin is not `pnpm audit --json` output"); process.exit(2); }
    const r = evaluate(report);
    for (const a of r.accepted) console.log(`accepted: ${a} — ${ACCEPTED[a.split(" ")[2]]}`);
    for (const g of r.gated) console.log(`GATED: ${g}`);
    if (r.gated.length) process.exit(1);
    console.log(`OK (${r.informational} upstream-only or non-gated advisories, informational; ${r.accepted.length} accepted)`);
}
