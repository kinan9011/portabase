import {rmSync} from "node:fs";
import type {Pool} from "pg";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {loadPlanRow} from "@/fork/restore/service";
import {buildApplyPayload, buildDbPayload, buildComposeRef, type BuildInput} from "@/fork/restore-tasks/build";
import {freshForkDb, seedOrg, type W04Db} from "@/fork/__tests__/w04-helpers";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";
import {adminUser, createRestorePlan, newKek, P, req, seedW17World, type ExtraSource} from "@/fork/__tests__/w17-world";

let t: W04Db; let pool: Pool; let kek: string; let org: string; let admin: string;
const key = testKeypair();
beforeAll(async () => { t = await freshForkDb(); pool = t.pool; kek = newKek(); org = await seedOrg(pool); admin = await adminUser(pool); });
afterAll(async () => { await t?.drop(); rmSync(kek, {recursive: true, force: true}); });

/** the W17-live lab world: the three standard sources + a -Fd database, a second volume and a sqlite file inside it (no docker; the lab file seeds the same shape) */
const LIVE_EXTRA: ExtraSource[] = [
    {role: "db", key: "db:db2", dbms: "postgresql", member: "db_db2", engine: "postgresql"},
    {role: "volume", key: "volume:app_kumadata", dbms: "docker-volume", member: "volume_app_kumadata", engine: "docker-volume"},
    {role: "db", key: "db:kuma", dbms: "sqlite", member: "db_kuma", engine: "sqlite"},
];

describe("W17-live world: the extended seed plans `ready` and the builders emit the two dumps and the sqlite entry", () => {
    it("plan ready; restore_db_dump x2, restore_volume x2, restore_sqlite_file into the second volume; payloads in manifest order", async () => {
        const w = await seedW17World(t, kek, key, admin, {org, hostRole: "test", roots: ["/srv"], caps: ["channel.v1", "noop.v1", "restore.target.v1", "compose.render.v1"], extra: LIVE_EXTRA,
            plain: {db_db2: {sha: "e".repeat(64), size: 1, dump: "pg_directory"}}});
        const c = await createRestorePlan({db: t.db, principal: P(admin, "user", [org, "admin"]), configAllowed: async () => true},
            req(w, {mode: "new_stack", mappings: {target_project: null, restore_root: "/srv/restore", volumes: null, sqlite: {kuma: {volume: "app_kumadata", relative_path: "kuma.db"}},
                select: ["dir:/srv/app", "volume:app_data", "db:db", "db:db2", "volume:app_kumadata", "db:kuma"]}}));
        if (!c.ok) throw new Error(`plan refused: ${c.code}`);
        const l = await loadPlanRow({db: t.db}, c.planId, c.planHash);
        if (!l.ok) throw new Error(l.code);
        const {plan, row} = l;
        if (plan.outcome !== "ready") console.log(JSON.stringify({blockers: plan.blockers, decisions: plan.decisions}, null, 1));
        expect(plan.outcome).toBe("ready");
        const kinds = plan.actions.filter((a) => a.op !== "skip").map((a) => `${a.kind}:${a.destination.name ?? a.destination.path ?? ""}`).sort();
        expect(kinds.filter((k) => k.startsWith("restore_db_dump:")).sort()).toEqual(["restore_db_dump:db", "restore_db_dump:db2"]);
        expect(kinds.filter((k) => k.startsWith("restore_volume:")).sort()).toEqual(["restore_volume:app_data", "restore_volume:app_kumadata"]);
        const sq = plan.actions.find((a) => a.kind === "restore_sqlite_file")!;
        expect(sq.destination).toMatchObject({kind: "volume", name: "app_kumadata", relative_path: "kuma.db"});
        const arts = (await pool.query("select id, source_name from fork_recovery_point_artifact where rp_id=$1 order by source_name", [w.rp])).rows as {id: string; source_name: string}[];
        const bi: BuildInput = {restoreId: "00000000-0000-4000-8000-000000000001", planId: row.id, planHash: row.planHash, plan, approvals: [], indexOf: new Map(arts.map((a, i) => [a.id, i]))};
        const apply = buildApplyPayload(bi, w.manifestSha);
        expect(apply.sqlite).toEqual([{index: arts.findIndex((a) => a.source_name === "db_kuma"), volume: "app_kumadata", relative_path: "kuma.db"}]);
        expect(apply.volumes.map((v) => v.name).sort()).toEqual(["app_data", "app_kumadata"]);
        const ref = buildComposeRef(bi, null);
        const dbs = buildDbPayload(bi, w.manifestSha, ref, "0".repeat(64), null).dbs;
        expect(dbs).toEqual([{index: arts.findIndex((a) => a.source_name === "db_db"), service: "db"}, {index: arts.findIndex((a) => a.source_name === "db_db2"), service: "db2"}]);
        expect(arts.map((a) => a.source_name)).toEqual(["compose_app", "db_db", "db_db2", "db_kuma", "volume_app_data", "volume_app_kumadata"]);
    });
});
