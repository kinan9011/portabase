import type {NodePgDatabase} from "drizzle-orm/node-postgres";

/** Query-builder handle (the app's `db` or a transaction). Fork modules take it as a parameter so tests can inject a throw-away DB. */
// biome-ignore lint/suspicious/noExplicitAny: upstream `db` is typed with its full schema map; the fork only uses the query builder + execute
export type ForkDb = NodePgDatabase<any>;

/** The app's own handle, imported lazily so unit tests that never touch the DB do not load `@/db` (and its env validation). */
export async function appDb(): Promise<ForkDb> {
    return (await import("@/db")).db as ForkDb;
}
