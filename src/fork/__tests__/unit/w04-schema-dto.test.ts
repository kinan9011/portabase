import {getTableColumns} from "drizzle-orm";
import {describe, expect, it} from "vitest";
import {CONNECTION_PUBLIC_COLUMNS, CONNECTION_SECRET_COLUMNS, toConnectionDto} from "@/fork/db/dto";
import {forkArcaneConnection} from "@/fork/db/schema/arcane";

describe("api_key_enc never reaches a DTO (explicit column allowlist)", () => {
    it("every table column is classified: public allowlist ∪ secret list == all columns, disjoint", () => {
        const all = Object.keys(getTableColumns(forkArcaneConnection)).sort();
        const pub = Object.keys(CONNECTION_PUBLIC_COLUMNS);
        expect([...pub, ...CONNECTION_SECRET_COLUMNS].sort()).toEqual(all);
        expect(pub.filter((c) => (CONNECTION_SECRET_COLUMNS as readonly string[]).includes(c))).toEqual([]);
        expect(pub).not.toContain("apiKeyEnc");
    });
    it("toConnectionDto drops a stray apiKeyEnc and rejects malformed rows", () => {
        const row = {
            id: "11111111-1111-4111-8111-111111111111", organizationId: "22222222-2222-4222-8222-222222222222", name: "arcane", baseUrl: "https://a.test",
            pinnedApiVersion: null, healthStatus: "unknown", lastErrorClass: null, tlsInsecure: false, allowProjectsRead: false, keyId: null, lastCheckedAt: null, createdAt: new Date(), updatedAt: new Date(),
            apiKeyEnc: {kid: "k1", iv: "x", ct: "canary", tag: "t"},
        };
        const dto = toConnectionDto(row);
        expect(JSON.stringify(dto)).not.toMatch(/apiKeyEnc|canary/);
        expect(() => toConnectionDto({...row, healthStatus: "bogus"})).toThrow();
    });
});
