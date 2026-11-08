/** W17b alert condition (D15): "stopped since HH:MM — Start now". Pure; `now` is injected. */
import {ALERT_GRACE_MS, type QuiesceState} from "./vocab";

export type QuiesceAlertInput = {state: QuiesceState | null; stoppedAt: Date | null; maxStopSeconds: number};

export function quiesceAlert(r: QuiesceAlertInput | null, now: Date): {active: boolean; since: Date | null} {
    if (!r?.state) return {active: false, since: null};
    if (r.state === "restart_failed" || r.state === "unconfirmed") return {active: true, since: r.stoppedAt};
    if (r.state === "stopped" && r.stoppedAt && now.getTime() > r.stoppedAt.getTime() + r.maxStopSeconds * 1000 + ALERT_GRACE_MS) return {active: true, since: r.stoppedAt};
    return {active: false, since: null};
}
