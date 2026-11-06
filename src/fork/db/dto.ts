import {randomUUID} from "node:crypto";
import {and, eq} from "drizzle-orm";
import {z} from "zod";
import type {ForkDb} from "@/fork/db/handle";
import {forkArcaneConnection} from "@/fork/db/schema/arcane";
import {decryptForkSecret, encryptForkSecret} from "@/fork/kek";
import {HEALTH_STATUSES} from "@/fork/db/enums";

/**
 * Explicit column allowlist for `fork_arcane_connection` (W04 security check: `api_key_enc` is never selected into a DTO).
 * `schema-dto.test.ts` fails when a column is added to the table without being classified here or as secret.
 */
export const CONNECTION_PUBLIC_COLUMNS = {
    id: forkArcaneConnection.id,
    organizationId: forkArcaneConnection.organizationId,
    name: forkArcaneConnection.name,
    baseUrl: forkArcaneConnection.baseUrl,
    pinnedApiVersion: forkArcaneConnection.pinnedApiVersion,
    healthStatus: forkArcaneConnection.healthStatus,
    lastErrorClass: forkArcaneConnection.lastErrorClass,
    createdAt: forkArcaneConnection.createdAt,
    updatedAt: forkArcaneConnection.updatedAt,
} as const;
export const CONNECTION_SECRET_COLUMNS = ["apiKeyEnc"] as const;

export const ConnectionDtoSchema = z.strictObject({
    id: z.uuid(),
    organizationId: z.uuid(),
    name: z.string(),
    baseUrl: z.string(),
    pinnedApiVersion: z.string().nullable(),
    healthStatus: z.enum(HEALTH_STATUSES),
    lastErrorClass: z.string().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
});
export type ConnectionDto = z.infer<typeof ConnectionDtoSchema>;

/** Picks the allowlisted keys only; anything else on `row` (e.g. a stray `apiKeyEnc`) is dropped. */
export function toConnectionDto(row: Record<string, unknown>): ConnectionDto {
    const picked: Record<string, unknown> = {};
    for (const k of Object.keys(CONNECTION_PUBLIC_COLUMNS)) picked[k] = row[k];
    return ConnectionDtoSchema.parse(picked);
}

export const connectionAad = (id: string) => ({table: "fork_arcane_connection", rowId: id, column: "api_key_enc"});

export async function listConnectionDtos(db: ForkDb, organizationId: string): Promise<ConnectionDto[]> {
    const rows = await db.select(CONNECTION_PUBLIC_COLUMNS).from(forkArcaneConnection).where(eq(forkArcaneConnection.organizationId, organizationId));
    return rows.map(toConnectionDto);
}

/** Row id is generated first so the ciphertext is bound to it (AAD) before the INSERT. Returns the DTO, never the key. */
export async function insertConnectionWithSecret(
    db: ForkDb,
    input: {organizationId: string; name: string; baseUrl: string; apiKey: string; pinnedApiVersion?: string},
    kekDir?: string,
): Promise<ConnectionDto> {
    const id = randomUUID();
    const apiKeyEnc = await encryptForkSecret(input.apiKey, connectionAad(id), kekDir);
    const [row] = await db
        .insert(forkArcaneConnection)
        .values({id, organizationId: input.organizationId, name: input.name, baseUrl: input.baseUrl, apiKeyEnc, pinnedApiVersion: input.pinnedApiVersion ?? null})
        .returning(CONNECTION_PUBLIC_COLUMNS);
    return toConnectionDto(row);
}

/** The ONLY reader of `api_key_enc`. Server-side use by the Arcane client (W05) — never return the result to a browser. */
export async function readConnectionApiKey(db: ForkDb, organizationId: string, id: string, kekDir?: string): Promise<string> {
    const [row] = await db
        .select({id: forkArcaneConnection.id, apiKeyEnc: forkArcaneConnection.apiKeyEnc})
        .from(forkArcaneConnection)
        .where(and(eq(forkArcaneConnection.id, id), eq(forkArcaneConnection.organizationId, organizationId)));
    if (!row) throw new Error("connection not found");
    return decryptForkSecret(row.apiKeyEnc, connectionAad(row.id), kekDir);
}
