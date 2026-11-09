import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import path from "node:path";
import {getTableColumns} from "drizzle-orm";
import {describe, expect, it} from "vitest";
import {notificationChannel} from "@/db/schema/09_notification-channel";
import {notificationLog} from "@/db/schema/11_notification-log";
import {setting} from "@/db/schema/01_setting";

/**
 * D31 CONTRACT TESTS for `src/fork/upstream/notification-channel.ts` (W13) — run on EVERY W-SYNC. A failure after an upstream merge means:
 * re-diff the upstream file against how the adapter uses it, adapt the adapter in the SAME sync PR, then update the pinned hash.
 */
const root = process.cwd();
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const sha = (p: string) => createHash("sha256").update(readFileSync(path.join(root, p))).digest("hex");

describe("pinned upstream sources behind the notification adapter (re-review on change)", () => {
    const PINS: [string, string, string][] = [
        ["src/features/notifications/utils/notifications.dispatch.ts", "48f5095d128027ecd4a968f983a6c9913452bda4692fe5a8f902dbfe9c641bce", "dispatchNotification(payload, policyId, channelId, organizationId): resolves the channel by id, calls the provider, writes notification_log"],
        ["src/features/notifications/types/index.ts", "aeb536c037fe76de0a9cd2793e4b22b90fe1d1e7ac448b7dbfd3321c244f058d", "EventPayload / EventKind (the existing event kinds the fork maps onto)"],
        ["src/db/schema/09_notification-channel.ts", "c311f64d6cc9f898156b2d521da3d7bfa8f1caa37fc34c8a17caf06d553f1009", "notification_channel columns read by defaultNotificationChannel"],
        ["src/db/schema/11_notification-log.ts", "9d238b266c465ec107f56e6736c830abf9da4c8e318903d7bd88a036255471aa", "notification_log.event is text (no enum edit needed)"],
    ];
    it.each(PINS)("%s unchanged since the adapter was written (%s)", (file, hash, why) => {
        expect(sha(file), `upstream ${file} changed: re-diff ${why}, adapt the adapter, then update this pin`).toBe(hash);
    });
});

describe("what the adapter assumes", () => {
    it("the instance default channel is setting.default_notification_channel_id on the `system` row", () => {
        expect(Object.keys(getTableColumns(setting))).toEqual(expect.arrayContaining(["name", "defaultNotificationChannelId"]));
        expect(Object.keys(getTableColumns(notificationChannel))).toEqual(expect.arrayContaining(["id", "organizationId", "enabled", "provider", "config"]));
        const adapter = read("src/fork/upstream/notification-channel.ts");
        expect(adapter).toMatch(/from settings s/);
        expect(adapter).toMatch(/s\.name = 'system'/);
        expect(adapter).toMatch(/default_notification_channel_id/);
    });
    it("notification_log.event stays a free text column and the fork only uses EXISTING event kinds", () => {
        expect(getTableColumns(notificationLog).event.dataType).toBe("string");
        const types = read("src/features/notifications/types/index.ts");
        for (const k of ["error_backup", "error_backup_missing", "success_backup_recovered"]) expect(types).toContain(`"${k}"`);
    });
    it("the adapter never touches the channel config", () => {
        expect(read("src/fork/upstream/notification-channel.ts") + read("src/fork/upstream/notification-send.ts")).toBeTruthy();
        expect((read("src/fork/upstream/notification-channel.ts") + read("src/fork/upstream/notification-send.ts")).replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/\.config\b|c\.config/);
    });
});
