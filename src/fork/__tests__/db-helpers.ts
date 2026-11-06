import {randomBytes} from "node:crypto";
import {Pool} from "pg";
import {drizzle} from "drizzle-orm/node-postgres";
import {migrate} from "drizzle-orm/node-postgres/migrator";
import path from "node:path";

const adminUrl = () => process.env.FORK_TEST_DATABASE_URL!;

export type TestDb = { url: string; name: string; pool: Pool; drop: () => Promise<void> };

/** Creates an isolated, empty database and returns its URL. */
export async function createTestDb(): Promise<TestDb> {
    const name = `w01_${randomBytes(6).toString("hex")}`;
    const admin = new Pool({connectionString: adminUrl(), max: 1});
    await admin.query(`create database ${name}`);
    await admin.end();
    const u = new URL(adminUrl());
    u.pathname = `/${name}`;
    const url = u.toString();
    const pool = new Pool({connectionString: url, max: 4});
    return {
        url, name, pool,
        drop: async () => {
            await pool.end();
            const a = new Pool({connectionString: adminUrl(), max: 1});
            await a.query(`drop database if exists ${name} with (force)`);
            await a.end();
        },
    };
}

/** Applies the REAL upstream migrations (src/db/migrations), like upstream's makeMigration()/drizzle-kit do. */
export async function applyUpstreamMigrations(pool: Pool) {
    await migrate(drizzle({client: pool}), {migrationsFolder: path.join(process.cwd(), "src/db/migrations")});
}
