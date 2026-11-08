// @vitest-environment jsdom
import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import * as React from "react";
import {afterEach, describe, expect, it, vi} from "vitest";
import {axeViolations} from "@/fork/__tests__/axe";
import {DangerousActionConfirm} from "@/fork/ui/dangerous-action-confirm";

afterEach(cleanup);

function Host(p: {typed?: boolean; onConfirm: (t?: string) => void}) {
    const [open, setOpen] = React.useState(false);
    return (
        <>
            <button type="button" data-testid="opener" onClick={() => setOpen(true)}>Restore to notes-host…</button>
            <DangerousActionConfirm open={open} onOpenChange={setOpen} title="Restore to a production machine?" description={<p>Type <code>RESTORE notes</code> to confirm.</p>} confirmLabel="Restore to notes-host" onConfirm={p.onConfirm}
                {...(p.typed === false ? {} : {typedPhrase: "RESTORE notes", inputLabel: "Confirmation", typedReason: "Type the phrase exactly as shown"})}/>
        </>
    );
}
const openIt = () => { const o = screen.getByTestId("opener"); o.focus(); fireEvent.click(o); return o; };
const confirmBtn = () => screen.getByRole("button", {name: "Restore to notes-host"});

describe("W18b B5 DangerousActionConfirm typed mode", () => {
    it("Cancel is focused first; the input follows it in DOM (tab) order with no positive tabindex; the input has the §8.2 secret-input attributes and a label", async () => {
        render(<Host onConfirm={vi.fn()}/>); openIt();
        await waitFor(() => expect(document.activeElement?.textContent).toBe("Cancel"));
        const input = screen.getByLabelText("Confirmation") as HTMLInputElement;
        expect(input.getAttribute("spellcheck")).toBe("false");
        expect(input.getAttribute("autocomplete")).toBe("off");
        expect(input.getAttribute("data-gramm")).toBe("false");
        expect(input.hasAttribute("data-1p-ignore")).toBe(true);
        const dialog = screen.getByRole("alertdialog");
        const order = [...dialog.querySelectorAll("input, button")].map((e) => e.tagName === "INPUT" ? "input" : e.textContent);
        expect(order).toEqual(["input", "Cancel", "Restore to notes-host"]); // Radix focuses Cancel first explicitly; DOM order is input → Cancel → confirm
        expect([...dialog.querySelectorAll("[tabindex]")].filter((e) => Number(e.getAttribute("tabindex")) > 0)).toEqual([]);
    });

    it("D3b the confirm button meets AA in both themes: fork-local #b91c1c (not the upstream destructive token, 2.89:1 in dark), white text >= 4.5:1", () => {
        render(<Host onConfirm={vi.fn()}/>); openIt();
        const cls = confirmBtn().className;
        expect(cls).toContain("bg-[#b91c1c]");
        expect(cls).not.toContain("bg-destructive");
        expect(cls).not.toContain("bg-primary"); // tailwind-merge removed the upstream default-variant background
        const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
        const lum = (n: number) => 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
        expect((lum(0xffffff) + 0.05) / (lum(0xb91c1c) + 0.05)).toBeGreaterThanOrEqual(4.5);
    });

    it("confirm is aria-disabled until the exact phrase; a click while mismatched does NOT confirm and keeps the dialog open; a visible reason is shown", () => {
        const onConfirm = vi.fn();
        render(<Host onConfirm={onConfirm}/>); openIt();
        expect(confirmBtn().getAttribute("aria-disabled")).toBe("true");
        expect(screen.getByText("Type the phrase exactly as shown")).toBeTruthy();
        fireEvent.change(screen.getByLabelText("Confirmation"), {target: {value: "restore notes"}});
        fireEvent.click(confirmBtn());
        expect(onConfirm).not.toHaveBeenCalled();
        expect(screen.queryByRole("alertdialog")).not.toBeNull();
    });

    it("the exact phrase (surrounding spaces trimmed) confirms with the TYPED text, not the constant", () => {
        const onConfirm = vi.fn();
        render(<Host onConfirm={onConfirm}/>); openIt();
        fireEvent.change(screen.getByLabelText("Confirmation"), {target: {value: "  RESTORE notes  "}});
        expect(confirmBtn().getAttribute("aria-disabled")).toBe("false");
        fireEvent.click(confirmBtn());
        expect(onConfirm).toHaveBeenCalledTimes(1);
        expect(onConfirm).toHaveBeenCalledWith("RESTORE notes");
    });

    it("Escape closes and focus returns to the opener; reopening shows an empty input", async () => {
        render(<Host onConfirm={vi.fn()}/>); const opener = openIt();
        fireEvent.change(screen.getByLabelText("Confirmation"), {target: {value: "RESTORE no"}});
        fireEvent.keyDown(screen.getByRole("alertdialog"), {key: "Escape"});
        await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
        await waitFor(() => expect(document.activeElement).toBe(opener));
        openIt();
        expect((screen.getByLabelText("Confirmation") as HTMLInputElement).value).toBe("");
    });

    it("plain mode is unchanged: no input, confirm is not aria-disabled and calls onConfirm", () => {
        const onConfirm = vi.fn();
        render(<Host typed={false} onConfirm={onConfirm}/>); openIt();
        expect(screen.queryByLabelText("Confirmation")).toBeNull();
        expect(confirmBtn().hasAttribute("aria-disabled")).toBe(false);
        fireEvent.click(confirmBtn());
        expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it("axe: no violations in typed mode (open, mismatched)", async () => {
        const {baseElement} = render(<Host onConfirm={vi.fn()}/>); openIt();
        expect(await axeViolations(baseElement)).toEqual([]);
    });
});
