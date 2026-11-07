"use client";

import {useMutation} from "@tanstack/react-query";
import {useRouter} from "next/navigation";
import type * as React from "react";
import {disconnectArcaneAction, rotateArcaneKeyAction, saveArcaneConnectionAction, testArcaneConnectionAction} from "@/fork/actions/arcane-connection.action";
import {updateArcaneEnvironmentAction} from "@/fork/actions/arcane-environment.action";
import {syncArcaneNowAction} from "@/fork/actions/sync.action";
import type {Outcome} from "@/fork/arcane/connection-service";
import type {EnvironmentOutcome} from "@/fork/arcane/environment-service";
import type {SyncNowOutcome} from "@/fork/discovery/sync";
import type {SecretKeyHandle} from "@/fork/ui/integrations/secret-key-input";
import {GENERIC_FAILURE, REFUSAL_COPY} from "@/fork/ui/labels";

/** What a mutation resolves to: never throws for server answers, never carries the key (Outcome has none). */
export type UiResult<T> = {kind: "ok"; outcome: T} | {kind: "refused"; code: string; message: string; outcome: Extract<T, {ok: false}>} | {kind: "error"; message: string};

type SafeActionResult<T> = {data?: T; serverError?: unknown; validationErrors?: unknown} | undefined;
export function normalise<T extends {ok: boolean}>(r: SafeActionResult<T>): UiResult<T> {
    if (!r || r.serverError || r.validationErrors || !r.data) return {kind: "error", message: r?.validationErrors ? REFUSAL_COPY.invalid_input : GENERIC_FAILURE};
    const o = r.data as T & {ok: boolean; code?: string; message?: string};
    if (o.ok) return {kind: "ok", outcome: r.data};
    return {kind: "refused", code: o.code ?? "refused", message: o.message || REFUSAL_COPY[o.code ?? "refused"] || GENERIC_FAILURE, outcome: r.data as Extract<T, {ok: false}>};
}

export type SaveVars = {connectionId?: string; name: string; baseUrl: string; tlsInsecure: boolean; allowProjectsRead: boolean};
export type EnvVars = {environmentId: string; enabled?: boolean; agentId?: string | null; hostRole?: "production" | "test"};

/**
 * The page's mutations (W06 step 2: `useMutation`, secret never in the query cache). The API key is NOT a mutation variable
 * (variables are stored in React Query's mutation cache): `mutationFn` takes it from the uncontrolled input at call time,
 * which clears the field in the same breath — so it is cleared after every submit, success or failure.
 * After a server answer the page re-reads server state with `router.refresh()`; nothing is rendered as success on its own.
 */
export function useIntegrationsActions(keyField: React.RefObject<SecretKeyHandle | null>, onResult: (r: UiResult<Outcome | EnvironmentOutcome | SyncNowOutcome>, what: string) => void) {
    const router = useRouter();
    const done = (what: string) => ({
        onSuccess: (r: UiResult<Outcome | EnvironmentOutcome | SyncNowOutcome>) => { onResult(r, what); router.refresh(); },
        onError: () => onResult({kind: "error", message: GENERIC_FAILURE}, what), // transport failure: say so, change nothing on screen
    });
    const key = () => keyField.current?.take();
    return {
        save: useMutation({mutationFn: async (v: SaveVars) => normalise<Outcome>(await saveArcaneConnectionAction({...v, apiKey: key()})), ...done("save")}),
        test: useMutation({mutationFn: async (v: {connectionId: string}) => normalise<Outcome>(await testArcaneConnectionAction(v)), ...done("test")}),
        rotate: useMutation({
            mutationFn: async (v: {connectionId: string}): Promise<UiResult<Outcome>> => {
                const apiKey = key();
                if (!apiKey) return {kind: "refused", code: "invalid_input", message: "Enter the new key first.", outcome: {ok: false, code: "invalid_input", message: "Enter the new key first."}};
                return normalise<Outcome>(await rotateArcaneKeyAction({...v, apiKey}));
            },
            ...done("rotate"),
        }),
        disconnect: useMutation({mutationFn: async (v: {connectionId: string}) => normalise<Outcome>(await disconnectArcaneAction(v)), ...done("disconnect")}),
        sync: useMutation({mutationFn: async (v: {connectionId: string}) => normalise<SyncNowOutcome>(await syncArcaneNowAction(v)), ...done("sync")}),
        environment: useMutation({mutationFn: async (v: EnvVars) => normalise<EnvironmentOutcome>(await updateArcaneEnvironmentAction(v)), ...done("environment")}),
    };
}
