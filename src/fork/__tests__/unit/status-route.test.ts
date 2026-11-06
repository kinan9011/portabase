import {beforeEach, describe, expect, it, vi} from "vitest";

const user = vi.hoisted(() => ({current: null as null | { role: string }}));
vi.mock("@/lib/auth/current-user", () => ({currentUser: async () => user.current}));

import {GET} from "../../../../app/api/fork/status/route";
import {registerActivePolicyProbe, setLaneStatus} from "@/fork/mode";

describe("GET /api/fork/status", () => {
    beforeEach(() => { user.current = {role: "admin"}; });

    it("flags off → 404 JSON (parity with an unknown route)", async () => {
        const r = await GET();
        expect(r.status).toBe(404);
        expect(await r.json()).toEqual({message: "This API route does not exist.", status: 404});
    });
    it("flag on: anonymous / user / pending → 404 (no information leak)", async () => {
        process.env.FORK_STACKS_ENABLED = "true";
        for (const u of [null, {role: "user"}, {role: "pending"}]) {
            user.current = u;
            expect((await GET()).status).toBe(404);
        }
    });
    it("flag on + system admin → mode, lock reason, lane state, flag booleans only", async () => {
        process.env.FORK_STACKS_ENABLED = "true";
        setLaneStatus({state: "applied", detail: "postgres://u:secret@h/d"});
        const r = await GET();
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body).toEqual({mode: "on", lockReason: null, lane: "applied", flags: {stacks: true, arcane: false, mirrors: false}});
        expect(JSON.stringify(body)).not.toContain("secret");
    });
    it("locked mode is reported to system admins (flags off + active policy)", async () => {
        registerActivePolicyProbe(async () => 1);
        const body = await (await GET()).json();
        expect(body).toMatchObject({mode: "locked", lockReason: "flags-off"});
    });
});
