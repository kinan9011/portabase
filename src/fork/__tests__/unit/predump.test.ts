import {mkdtemp, readdir, stat, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {dumpArgsFromUrl, preMigrationDump} from "@/fork/db/predump";

describe("pre-migration dump", () => {
    it("never puts the password in argv; passes it via PGPASSWORD", () => {
        const {args, env} = dumpArgsFromUrl("postgres://us%40er:p%40ss%3Aw0rd@db.local:5433/portabase?sslmode=require", "/x/f.dump");
        expect(args.join(" ")).not.toMatch(/p@ss|p%40ss|w0rd/);
        expect(env.PGPASSWORD).toBe("p@ss:w0rd");
        expect(env.PGSSLMODE).toBe("require");
        expect(args).toEqual(expect.arrayContaining(["--host", "db.local", "--port", "5433", "--username", "us@er", "--dbname", "portabase"]));
    });
    it("creates a 0700 dir, 0600 file, keeps the newest N, propagates failure", async () => {
        const dir = path.join(await mkdtemp(path.join(os.tmpdir(), "w01-dump-")), "fork-predump");
        let n = 0;
        const exec = async (_b: string, a: string[]) => { await writeFile(a[a.indexOf("--file") + 1], "PGDMP"); };
        for (let i = 0; i < 5; i++) {
            await preMigrationDump({databaseUrl: "postgres://u:p@h/d", dir, keep: 3, exec, now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, n++))});
        }
        const files = await readdir(dir);
        expect(files).toHaveLength(3);
        expect((await stat(dir)).mode & 0o777).toBe(0o700);
        expect((await stat(path.join(dir, files[0]))).mode & 0o777).toBe(0o600);
        expect(files.sort()[2]).toContain("2026-01-01T00-00-04");
        await expect(preMigrationDump({databaseUrl: "postgres://u:p@h/d", dir, exec: async () => { throw new Error("pg_dump failed: nope"); }})).rejects.toThrow(/nope/);
    });
});
