/**
 * A mode pick that has been ASKED FOR and not yet confirmed by the pane
 * (DROVE-217).
 *
 * Clay, having watched effort finally start working: "It seems that the effort
 * is actually updating now but there's like a huge delay so it feels weird" —
 * and then the fix, in his own words: "have the change immediately but have the
 * colour change to like yellow or something like that while pending and then
 * white when it's done."
 *
 * HOW LONG IS THE DELAY, MEASURED. From Clay's own CLI logs for 2026-08-31,
 * timed from `app changed the model/effort — queueing X` to the pane reporting
 * back:
 *
 *   effort            0.51s, 1.73s, 2.21s, 2.49s, 3.92s, 11.0s, 65.5s
 *   model             0.50s, 0.53s, 1.13s, 1.19s, 1.44s, 1.47s, 3.40s
 *   permission mode   0.22s, 0.46s, 0.47s, 0.69s, 0.71s, 0.82s
 *
 * So the median is under two seconds and the TAIL is the problem: the 65s was
 * the pane's gate shut (a dialog up or text in the input box) with the command
 * re-tried every 2s, and there are runs in the same log where `/model` timed
 * out at the CLI's 8s outcome deadline four times running and the app was never
 * told anything at all. A 0.5s change and a 65s change look identical today,
 * which is the whole of what feels weird. The colour is the fix; a shorter poll
 * is not, because the one interval inside that window we own is 300ms and the
 * rest is Claude Code's own confirmation dialog.
 *
 * THE STATE IS THE PAIR DROVE-199 ALREADY TRACKS. `permissionMode`,
 * `modelMode` and `effortLevel` are REQUESTS; `panePermissionMode`, `paneModel`
 * and `paneEffort` are what the terminal is OBSERVED to hold. ops.ts has
 * compared them per field since DROVE-191/199 to decide whether a tap is a
 * change. Pending is the same comparison read as a question about time rather
 * than about intent, so `paneAgrees` below is the one rule and both callers use
 * it.
 *
 * WHAT A REFUSAL DOES — decided here so the colour cannot sit yellow forever.
 * Pending ends on EVIDENCE, and there are four exits:
 *
 *   confirmed    the pane reports the value we asked for. Settled, at the new
 *                value. The ordinary case.
 *   rolled back  the CLI refused it and mirrored the pane back into the
 *                request (`/effort` DROVE-164, `/model` DROVE-191, the
 *                permission ring DROVE-199). The stored request is then no
 *                longer what we asked for, which is exactly the signal, and the
 *                CLI has already put a line in the chat saying why in Claude
 *                Code's own words. The control snaps to the pane's value and
 *                goes settled; it does NOT invent a second explanation.
 *   contradicted the pane moved to some third value after we asked — a `/model`
 *                typed at the keyboard, a flip, a limit downgrade. Settled, at
 *                whatever the pane now holds.
 *   given up     nothing came back at all within AGENT_MODE_PENDING_GIVE_UP_MS.
 *                This is the one case nothing rolls back: the CLI's 8s outcome
 *                deadline expires, it writes no metadata on purpose, and the
 *                truth arrives on the next turn's transcript. Rather than claim
 *                a pick the terminal never took, the control stops claiming it
 *                and shows the pane again.
 *
 * The bound is 45 seconds. Every confirmation measured above landed inside 11s,
 * and the CLI's own budget for a single attempt is its 8s outcome deadline plus
 * a 2s gate retry, so 45s is well past "slow" and squarely in "this did not
 * happen". It is deliberately long: snapping back at 10s would have undone the
 * 65s pick in front of Clay and then re-done it, which is two surprises where
 * waiting is one.
 *
 * Device-local and deliberately not persisted. A request is a thing THIS phone
 * did a moment ago; after a relaunch the pane's own value is the only truth
 * worth drawing.
 *
 * DROVE-232 ADDS THE ONE WAIT THIS PHONE DID NOT START. A flip relaunches
 * Claude Code under another account, and the new process reads its model and
 * effort out of that account's config -- so the CLI has to carry the session's
 * picks over and re-apply anything that did not land. That is a wait of exactly
 * the shape above, started by the CLI rather than by a tap, so it cannot come
 * from the device-local map. It arrives as `modeReapplyAt` in metadata and
 * `reapplyRequest` below turns it into the same record, which means the four
 * exits, the fold and the bound are shared rather than copied. The CLI also
 * clears `paneModel` / `paneEffort` / `panePermissionMode` as it relaunches,
 * because they describe a process that has gone -- so until the new one speaks
 * there is nothing observed, the composer falls back to the request, and Clay
 * keeps looking at the effort he picked.
 *
 * Pure except for the map, so the rule can be pinned without a renderer.
 */

import { resolvePaneModelKey, toClaudePermissionMode } from '@/components/modelModeOptions';
import type { Metadata } from './storageTypes';

/** The three controls in the composer's capsule. Not `remoteControl`: it is a toggle in the settings sheet, not a value in this row. */
export const AGENT_MODE_CONTROLS = ['permissionMode', 'modelMode', 'effortLevel'] as const;
export type AgentModeControl = (typeof AGENT_MODE_CONTROLS)[number];

/** How long a pick may go unconfirmed before the control stops claiming it. */
export const AGENT_MODE_PENDING_GIVE_UP_MS = 45_000;

export interface AgentModeRequest {
    /** The key that was asked for. `null` is a real value: it means "reset". */
    value: string | null;
    /** What the pane held at the moment of the ask, so a later move reads as a contradiction rather than as silence. */
    observedWhenAsked: string | null;
    /** When the ask was made, for the give-up bound. */
    at: number;
}

export type AgentModePendingState = 'settled' | 'pending';

/**
 * What the pane is OBSERVED to hold for `field`, or null when nothing has been
 * read off it.
 *
 * Gated on `hasPane` for the same reason SessionView is: a session with no
 * terminal has no observation to wait for, so a pick there is settled the
 * moment it is made.
 */
export function paneObservedMode(
    metadata: Metadata | null | undefined,
    field: AgentModeControl,
): string | null {
    if (!metadata?.hasPane) return null;
    if (field === 'modelMode') return metadata.paneModel ?? null;
    if (field === 'permissionMode') return metadata.panePermissionMode ?? null;
    return metadata.paneEffort ?? null;
}

/**
 * Does the pane's observed value mean the same thing as `requested`?
 *
 * Three fields, three vocabularies, and this is the one place they are folded
 * (DROVE-191/199). A model is compared through `resolvePaneModelKey`, because
 * the transcript cannot tell `claude-opus-5` from `claude-opus-5[1m]`. A
 * permission mode is an APP key on the request side and a CLAUDE mode on the
 * pane's, so the request is folded forward. Effort is the same word on both
 * sides.
 */
export function paneAgrees(
    field: AgentModeControl,
    requested: string | null | undefined,
    observed: string | null | undefined,
): boolean {
    const pane = observed ?? null;
    const want = requested ?? null;
    if (field === 'modelMode') return resolvePaneModelKey(pane, want) === want;
    if (field === 'permissionMode') return pane === toClaudePermissionMode(want);
    return pane === want;
}

/**
 * The DROVE-191/199 test, kept here so ops.ts and the composer read one rule.
 *
 * A pane that has reported nothing does NOT disagree: `undefined` is not the
 * same as "the pane is on default", and treating it as one is how a mode moved
 * at the keyboard used to be reported before anything had been read.
 */
export function paneDisagreesWithRequest(
    metadata: Metadata | null | undefined,
    field: AgentModeControl,
    requested: string | null | undefined,
): boolean {
    const observed = paneObservedMode(metadata, field);
    if (!observed) return false;
    return !paneAgrees(field, requested, observed);
}

/**
 * Is the ask still outstanding?
 *
 * The clauses are the four exits in the header, in the order they are cheapest
 * to decide. Every one of them is evidence except the last, and the last is
 * bounded.
 */
export function agentModePendingState(
    field: AgentModeControl,
    input: {
        request: AgentModeRequest | undefined;
        /** The session's own request field. A CLI rollback overwrites it, which is how a refusal reaches us. */
        stored: string | null;
        /** The pane's value now. */
        observed: string | null;
        now: number;
        giveUpMs?: number;
    },
): AgentModePendingState {
    const { request, stored, observed, now } = input;
    // Nothing was asked for from this device.
    if (!request) return 'settled';
    // The ask was overwritten — by the CLI rolling a refusal back, by another
    // device, or by the pane being mirrored into the request. Either way it is
    // not ours to wait on any more.
    if (stored !== request.value) return 'settled';
    // Nothing has ever been read off the pane, so there is nothing to confirm
    // against and no wait to draw.
    if (!observed) return 'settled';
    // Confirmed.
    if (paneAgrees(field, request.value, observed)) return 'settled';
    // The pane moved, just not to where we asked. Somebody else won.
    if (observed !== request.observedWhenAsked) return 'settled';
    // Silence, bounded.
    if (now - request.at >= (input.giveUpMs ?? AGENT_MODE_PENDING_GIVE_UP_MS)) return 'settled';
    return 'pending';
}

/**
 * The CLI's own re-apply, as the request record the rule above already knows
 * how to reason about (DROVE-232).
 *
 * `value` is the STORED pick, because that is exactly what the CLI is trying to
 * put back: it chose nothing, it is defending what was already chosen. So the
 * "overwritten" exit still means what it always meant -- the CLI mirrored a
 * refusal back and the stored pick is no longer the one we are waiting on --
 * which is how a value the new account cannot honour ends the wait rather than
 * hanging it.
 *
 * `observedWhenAsked` is pinned to what the pane holds NOW, which neuters the
 * "contradicted" exit for this record, and that is deliberate. Contradiction
 * asks "did somebody else move the pane after we asked". On a re-apply the CLI
 * is the one moving it, and its own failure already has an exit of its own, so
 * leaving contradiction armed would settle the wait on the very first report
 * from the new process -- which is the report we are waiting to disagree with.
 * What is left is: confirmed, rolled back, or the 45-second bound.
 *
 * Returns undefined when no re-apply is outstanding, so an ordinary session
 * behaves exactly as it did before.
 */
export function reapplyRequest(
    metadata: Metadata | null | undefined,
    stored: string | null,
    observed: string | null,
): AgentModeRequest | undefined {
    const at = metadata?.modeReapplyAt;
    if (typeof at !== 'number') return undefined;
    return { value: stored, observedWhenAsked: observed, at };
}

const bySession = new Map<string, Map<AgentModeControl, AgentModeRequest>>();
const listeners = new Set<() => void>();

/**
 * Write down a pick this device just made, and what the pane held when it was
 * made.
 *
 * Called from `sessionSetAgentModes` for exactly the fields it decided had
 * changed, so a tap that sends nothing starts no wait.
 */
export function noteAgentModeRequest(
    sessionId: string,
    field: AgentModeControl,
    value: string | null,
    observedWhenAsked: string | null,
    now: number = Date.now(),
): void {
    let fields = bySession.get(sessionId);
    if (!fields) {
        fields = new Map();
        bySession.set(sessionId, fields);
    }
    fields.set(field, { value, observedWhenAsked, at: now });
    pruneExpired(now);
    for (const listener of listeners) listener();
}

export function getAgentModeRequest(
    sessionId: string,
    field: AgentModeControl,
): AgentModeRequest | undefined {
    return bySession.get(sessionId)?.get(field);
}

export function subscribeAgentModeRequests(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** Test seam. Nothing in the app clears these by hand — the bound does it. */
export function resetAgentModeRequests(): void {
    bySession.clear();
}

/**
 * Drop records that can no longer make anything pending, so a long session does
 * not accumulate one per pick forever. Bounded work: three fields per session,
 * only on a write.
 */
function pruneExpired(now: number): void {
    for (const [sessionId, fields] of bySession) {
        for (const [field, request] of fields) {
            if (now - request.at >= AGENT_MODE_PENDING_GIVE_UP_MS) fields.delete(field);
        }
        if (fields.size === 0) bySession.delete(sessionId);
    }
}
