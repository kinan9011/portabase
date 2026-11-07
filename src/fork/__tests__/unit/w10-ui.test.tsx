// @vitest-environment jsdom
import {render, screen, within} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {ITEM_KINDS, REASON_CODES} from "@/fork/completeness/types";
import {SOURCE_DRIFT_REASONS, SOURCE_ORIGINS, SOURCE_PROBES, SOURCE_ROLES, SOURCE_STATUSES} from "@/fork/materialize/vocab";
import type {SourceView} from "@/fork/completeness/view";
import {axeViolations} from "@/fork/__tests__/axe";
import {ITEM_KIND_LABELS, REASON_COPY, SOURCES_COPY as S} from "@/fork/ui/labels";
import {SourcesTable} from "@/fork/ui/stacks/config-tab/sources-table";

const src = (o: Partial<SourceView> = {}): SourceView => ({name: "compose: /srv/app", role: "compose", origin: "discovered", status: "active", probe: "readable", reason: null, ...o});

describe("W10 labels: every closed vocabulary has copy", () => {
    it("sources: roles, origins, statuses, probes and drift reasons", () => {
        for (const r of SOURCE_ROLES) expect(S.role[r], r).toMatch(/\S/);
        for (const o of SOURCE_ORIGINS) expect(typeof S.origin[o]).toBe("string");
        for (const s of SOURCE_STATUSES) { expect(S.status[s].label, s).toMatch(/\S/); expect(S.status[s].description.length, s).toBeGreaterThan(20); }
        for (const p of [...SOURCE_PROBES, "none"] as const) expect(S.probe[p], p).toMatch(/\S/);
        for (const r of SOURCE_DRIFT_REASONS) expect(S.reason[r], r).toMatch(/\S/);
    });
    it("completeness kinds and reasons added by the materializer", () => {
        for (const k of ITEM_KINDS) expect(ITEM_KIND_LABELS[k], k).toMatch(/\S/);
        for (const r of REASON_CODES) expect(REASON_COPY[r].length, r).toBeGreaterThan(15);
        expect(REASON_COPY.agent_poll_failing).toMatch(/^Agent poll failing/);
    });
});

describe("W10 Backup sources table", () => {
    it("empty state says nothing was created", () => {
        render(<SourcesTable sources={[]}/>);
        expect(screen.getByText(S.none)).toBeTruthy();
    });
    it("every status renders its label and its reason INLINE (never hover-only); probe text; origin suffix for manual sources", async () => {
        const rows = SOURCE_STATUSES.map((status, i) => src({name: `member ${i}`, status, role: SOURCE_ROLES[i % SOURCE_ROLES.length], origin: i === 1 ? "manual" : "discovered", probe: i % 2 ? "unreadable" : null, reason: status === "drifted" ? "config_changed" : status === "blocked" ? "agent_poll_failing" : null}));
        const {container} = render(<SourcesTable sources={rows}/>);
        const trs = screen.getAllByTestId("source-row");
        expect(trs).toHaveLength(SOURCE_STATUSES.length);
        for (const [i, status] of SOURCE_STATUSES.entries()) {
            expect(within(trs[i]).getByText(S.status[status].label)).toBeTruthy();
            const why = rows[i].reason ? S.reason[rows[i].reason as keyof typeof S.reason] : S.status[status].description;
            expect(trs[i].textContent).toContain(why);
        }
        expect(trs[1].textContent).toContain("(added by hand)");
        expect(container.textContent).toContain(S.probe.unreadable);
        expect(container.textContent).toContain(S.probe.none);
        expect(container.querySelector("[title]")).toBeNull();
        expect(await axeViolations(container)).toEqual([]);
    });
    it("renders names as text only (a hostile name is never interpreted)", () => {
        const {container} = render(<SourcesTable sources={[src({name: "<img src=x onerror=alert(1)>"})]}/>);
        expect(container.querySelector("img")).toBeNull();
        expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    });
});
