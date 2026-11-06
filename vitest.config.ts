import path from "node:path";
import {defineConfig} from "vitest/config";

// Fork-scoped test lane (ADR-003 / W01, ARCH-18). Only `src/fork/**` is collected.
//   pnpm test:fork               all tiers
//   pnpm test:fork:unit          no services
//   pnpm test:fork:integration   needs FORK_TEST_DATABASE_URL (Postgres superuser URL; each test creates its own database)
//   pnpm test:fork:e2e           needs a production build (`pnpm build`) + FORK_TEST_DATABASE_URL
const alias = {
    "@": path.resolve(__dirname, "src"),
    "@app": path.resolve(__dirname, "app"),
    "server-only": path.resolve(__dirname, "src/fork/__tests__/stubs/server-only.ts"),
};

export default defineConfig({
    resolve: {alias},
    esbuild: {jsx: "automatic"},
    test: {
        passWithNoTests: false,
        projects: [
            {
                extends: true,
                test: {
                    name: "unit",
                    include: ["src/fork/**/__tests__/unit/**/*.test.{ts,tsx}"],
                    environment: "node",
                    setupFiles: ["src/fork/__tests__/setup-unit.ts"],
                },
            },
            {
                extends: true,
                test: {
                    name: "integration",
                    include: ["src/fork/**/__tests__/integration/**/*.test.ts"],
                    environment: "node",
                    testTimeout: 60_000,
                    hookTimeout: 60_000,
                    fileParallelism: false,
                    setupFiles: ["src/fork/__tests__/setup-db.ts"],
                },
            },
            {
                extends: true,
                test: {
                    name: "e2e",
                    include: ["src/fork/**/__tests__/e2e/**/*.test.ts"],
                    environment: "node",
                    testTimeout: 240_000,
                    hookTimeout: 240_000,
                    fileParallelism: false,
                    setupFiles: ["src/fork/__tests__/setup-db.ts"],
                },
            },
        ],
    },
});
