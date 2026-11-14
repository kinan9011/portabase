import {planInput} from "@/fork/__tests__/w16-fixtures";
import type {PlanInputV1} from "@/fork/restore/schema";

export const MIRROR_ROOT = "/srv/portabase-mirrors";

/** Valid mirror planner input: a designated runner (no environment, runner.v1 + mirror.v1), purpose mirror / new_stack, project pbm-*, personal data declared false. */
export function mirrorInput(mut?: (i: PlanInputV1) => void, o: {project?: string; root?: string} = {}): PlanInputV1 {
    return planInput((i) => {
        i.purpose = "mirror";
        i.mode = "new_stack";
        i.mappings = {target_project: o.project ?? "pbm-demo-r1", restore_root: o.root ?? MIRROR_ROOT, volumes: null, select: null, sqlite: null};
        i.stack.contains_personal_data = false;
        i.target.runner_eligible = true;
        i.target.environments = [];
        i.target.enrollment = {enabled: true, revoked: false, capabilities: ["channel.v1", "noop.v1", "channel-maint.v1", "runner.v1", "mirror.v1"]};
        mut?.(i);
    });
}
