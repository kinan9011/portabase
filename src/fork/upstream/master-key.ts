/**
 * The ONE upstream function the adapter calls that is not a table: the instance master key (`master_key.bin`), which encrypts
 * database credentials in `databases.config` exactly as `upsertDatabaseConfigAction` does. Imported lazily (it pulls `@/env.mjs`
 * validation) and injectable (`MaterializeDeps.masterKey`) so tests never need the real key file. Pinned by the contract test.
 */
export async function upstreamMasterKey(): Promise<Buffer> {
    return (await import("@/features/agents/utils/keys.server")).getMasterServerKeyContent();
}
