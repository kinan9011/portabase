import {dispatchNotification} from "@/features/notifications/utils/notifications.dispatch";
import type {DefaultChannel} from "./notification-channel";

/** Sender half of the notification adapter (kept apart from the lookup: the upstream dispatcher pulls the dashboard env, the lookup is plain SQL). */
export type UpstreamMessage = {title: string; message: string; level: "critical" | "warning" | "info"; event: "error_backup" | "error_backup_missing" | "success_backup_recovered"};

/** True only when the upstream provider reported success. The provider's message is deliberately dropped (it can carry URLs/credentials). */
export async function sendViaUpstreamChannel(channel: DefaultChannel, m: UpstreamMessage): Promise<boolean> {
    const r = await dispatchNotification({title: m.title, message: m.message, level: m.level, event: m.event}, undefined, channel.id, channel.organizationId ?? undefined);
    return r.success === true;
}
