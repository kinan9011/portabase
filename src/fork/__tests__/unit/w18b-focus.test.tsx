// @vitest-environment jsdom
import {act, cleanup, fireEvent, render, screen} from "@testing-library/react";
import {afterEach, describe, expect, it, vi} from "vitest";

const h = vi.hoisted(() => ({refresh: vi.fn()}));
vi.mock("next/navigation", () => ({useRouter: () => ({refresh: h.refresh, push: vi.fn()})}));
vi.mock("@/fork/actions/restore-plan.action", () => ({approveRestorePlanAction: vi.fn(), createRestorePlanAction: vi.fn()}));
vi.mock("@/fork/actions/restore-run.action", () => ({listRestoreRunsAction: vi.fn(), startRestoreRunAction: vi.fn()}));
// the embedded W16b panel is replaced by one button that reports a change, exactly what a save does
vi.mock("@/fork/ui/stacks/config/restore-overrides-panel.client", () => ({RestoreOverridesPanel: ({onChanged}: {onChanged: () => void}) => <button type="button" data-testid="fake-save" onClick={() => onChanged()}>Save overrides</button>}));

import {PlanValues} from "@/fork/ui/recovery/go.client";

afterEach(cleanup);
describe("W18b-f2 K1: focus after a values save", () => {
    it("after the page refresh the focus is on the 'Values for this restore' toggle, not on <body>", async () => {
        render(<PlanValues planId="p" planHash="h" view={{} as never} canEdit={true} rateLimited={false}/>);
        fireEvent.click(screen.getByTestId("values-toggle"));
        const save = screen.getByTestId("fake-save"); save.focus();
        await act(async () => { fireEvent.click(save); });
        expect(h.refresh).toHaveBeenCalled();
        expect(document.activeElement).toBe(screen.getByTestId("values-toggle"));
    });
});
