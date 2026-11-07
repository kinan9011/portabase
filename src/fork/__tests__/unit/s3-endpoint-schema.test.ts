import {describe, expect, it} from "vitest";
import {S3ChannelConfigSchema} from "@/features/channel/components/storages/s3/s3.schema";

const parse = (endPointUrl: string) =>
    S3ChannelConfigSchema.safeParse({endPointUrl, accessKey: "a", secretKey: "b", bucketName: "c", port: 9230, ssl: false});

describe("S3 channel endpoint is host-only", () => {
    it.each(["http://192.168.8.31", "https://s3.example.com", "192.168.8.31:9230", "s3.example.com/path"])("rejects %s", (v) => {
        expect(parse(v).success).toBe(false);
    });
    it.each(["192.168.8.31", "s3.amazonaws.com", "  minio.lan  "])("accepts %s", (v) => {
        expect(parse(v).success).toBe(true);
    });
});
