import {afterEach} from "vitest";
import {cleanup} from "@testing-library/react";
import {resetForkState} from "@/fork/mode";
import {clearForkRuntimeTasks} from "@/fork/runtime";

// jsdom polyfills used by shadcn's sidebar (only matter in jsdom tests).
if (typeof window !== "undefined" && !window.matchMedia) {
    window.matchMedia = ((q: string) => ({
        matches: false, media: q, onchange: null,
        addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
    if (typeof document !== "undefined") cleanup();
    resetForkState();
    clearForkRuntimeTasks();
    for (const k of Object.keys(process.env)) if (k.startsWith("FORK_")) delete process.env[k];
});
