import {check, jsonb, pgTable, text, timestamp, uuid} from "drizzle-orm/pg-core";
import {sql} from "drizzle-orm";
import {agent} from "@/db/schema/08_agent";
import {forkAgentTask} from "./agent-channel";

const ts = (name: string) => timestamp(name, {withTimezone: true});

/**
 * W21 (ADR-008, D48): the mirror RUNNER designation, an AGENT-level fact (not a third `host_role` value: `fork_arcane_environment.host_role` stays production|test).
 * One row per designated agent. An agent is an eligible runner only with this row AND an active enrolment reporting `runner.v1` AND no Arcane environment AND no upstream
 * databases (see `runner/service.ts`). Cascade is deliberate: a designation means nothing without its agent, and the audit log keeps the history.
 * `last_probe_*` binds the most recent isolation probe (task id, the RESOLVED target list with ids/classes/labels, and the sha of the pre-resolution config) so the
 * verdict can detect `targets_changed`. No hosts-as-secrets: these are operator-chosen network targets (database/SMTP/webhook IPs), never credentials.
 */
export const forkRunner = pgTable(
    "fork_runner",
    {
        agentId: uuid("agent_id").primaryKey().references(() => agent.id, {onDelete: "cascade"}),
        designatedBy: text("designated_by").notNull(),
        designatedAt: ts("designated_at").notNull(),
        probeTargets: jsonb("probe_targets").notNull().default(sql`'[]'::jsonb`),
        lastProbeTaskId: uuid("last_probe_task_id").references(() => forkAgentTask.id, {onDelete: "set null"}),
        lastProbeTargets: jsonb("last_probe_targets"),
        lastProbeConfigSha256: text("last_probe_config_sha256"),
        lastProbeRequestedAt: ts("last_probe_requested_at"),
        updatedAt: ts("updated_at").notNull().defaultNow(),
    },
    (t) => [
        check("fork_runner_targets_ck", sql`octet_length(${t.probeTargets}::text) <= 16384 AND jsonb_typeof(${t.probeTargets}) = 'array'`),
        check("fork_runner_last_targets_ck", sql`${t.lastProbeTargets} IS NULL OR octet_length(${t.lastProbeTargets}::text) <= 16384`),
        check("fork_runner_sha_ck", sql`${t.lastProbeConfigSha256} IS NULL OR ${t.lastProbeConfigSha256} ~ '^[0-9a-f]{64}$'`),
    ],
);
