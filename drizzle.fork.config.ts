import {defineConfig} from "drizzle-kit";
import dotenv from "dotenv";

dotenv.config({quiet: true, path: ".env"});

// Fork migration lane (ADR-003). Generate:  pnpm drizzle-kit generate --config drizzle.fork.config.ts
// Applied at boot by src/fork/db/migrate.ts (NOT by `drizzle-kit migrate`), after upstream migrations.
export default defineConfig({
    out: "./src/fork/db/migrations",
    schema: "./src/fork/db/schema/index.ts",
    dialect: "postgresql",
    tablesFilter: ["fork_*"],
    migrations: {table: "__fork_migrations", schema: "drizzle"},
    dbCredentials: {url: process.env.DATABASE_URL!},
});
