import {pgTable, text, timestamp} from "drizzle-orm/pg-core";

/** Trivial fork-owned table: proves the fork migration lane end to end (W01). */
export const forkMeta = pgTable("fork_meta", {
    key: text("key").primaryKey(),
    value: text("value").notNull(),
    updatedAt: timestamp("updated_at", {withTimezone: true}).notNull().defaultNow(),
});
