// Integration/e2e tiers need a real Postgres. Fail LOUDLY, never skip silently.
if (!process.env.FORK_TEST_DATABASE_URL) {
    throw new Error(
        "FORK_TEST_DATABASE_URL is not set. Point it at a throw-away Postgres superuser URL, e.g. " +
            "postgres://user:pass@127.0.0.1:5433/postgres (see vitest.config.ts).",
    );
}
