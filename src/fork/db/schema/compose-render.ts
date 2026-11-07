import {check, index, jsonb, pgTable, text, timestamp, uuid} from "drizzle-orm/pg-core";
import {sql} from "drizzle-orm";
import {agent} from "@/db/schema/08_agent";
import {forkAgentTask} from "./agent-channel";

/**
 * W17-ii (ADR-007 A14): the POLICY VIEW of a rendered compose document, uploaded by the restore-target agent on its own route (results are capped at
 * 8 KiB and key-fragment-redacted, so they cannot carry a render). `policy_view` has every secret-bearing value blanked by the AGENT and re-checked by
 * the dashboard (`isPolicyView`) before it is stored. One row per `compose_render` task; `rendered_sha256 = sha256(policy_view bytes)`.
 */
export const forkComposeRender = pgTable("fork_compose_render", {
    taskId: uuid("task_id").primaryKey().references(() => forkAgentTask.id, {onDelete: "cascade"}),
    agentId: uuid("agent_id").references(() => agent.id, {onDelete: "set null"}),
    restoreId: uuid("restore_id").notNull(),
    policyView: text("policy_view").notNull(),
    renderedSha256: text("rendered_sha256").notNull(),
    raw: jsonb("raw").notNull(),
    roots: jsonb("roots").notNull(),
    files: jsonb("files").notNull(),
    composeVersion: text("compose_version"),
    agentRulesSha256: text("agent_rules_sha256"),
    createdAt: timestamp("created_at", {withTimezone: true}).notNull().defaultNow(),
}, (t) => [
    index("fork_compose_render_restore_idx").on(t.restoreId, t.createdAt),
    check("fork_compose_render_size", sql`octet_length(${t.policyView}) <= 2097152`),
    check("fork_compose_render_sha", sql`${t.renderedSha256} ~ '^[0-9a-f]{64}$'`),
]);
