import {configureAxe} from "vitest-axe";

/**
 * axe lane for every UI wave (CH-28, §8.2). jsdom has no layout/canvas, so `color-contrast` can't run here:
 * contrast is checked in the browser (W27 audit). Returns violation ids, minus explicitly allowed ones.
 */
const axe = configureAxe({rules: {"color-contrast": {enabled: false}}});

export async function axeViolations(container: Element, allow: string[] = []): Promise<string[]> {
    const res = await axe(container);
    return res.violations.map((v) => v.id).filter((id) => !allow.includes(id));
}
