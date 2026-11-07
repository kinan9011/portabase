import {z} from "zod";

export const S3ChannelConfigSchema = z.object({
    // fork: host only. A scheme/port/path here is prepended again by the agent ("http://http://host") and every upload dies on DNS.
    endPointUrl: z.string().trim().min(1, "Endpoint URL is required")
        .refine((v) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(v) && !/[/:]/.test(v.replace(/^\[.*\]$/, "")),
            "Host only (e.g. s3.example.com): no http://, port or path. Use the Port field and the SSL switch."),
    region: z.string().optional(),
    accessKey: z.string().min(1, "Access Key is required"),
    secretKey: z.string().min(1, "Secret Key is required"),
    bucketName: z.string().min(1, "Bucket name is required"),
    port: z.union([
        z.literal("").transform(() => ""),
        z.literal("").transform(() => ""),
        z.coerce.number()
    ]).optional(),
    ssl: z.boolean().optional().default(true),
});
