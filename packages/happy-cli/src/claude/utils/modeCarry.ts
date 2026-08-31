/**
 * Carrying the session's model, effort and permission mode across a relaunch
 * (DROVE-232).
 *
 * Clay, after his session hit main's weekly wall and moved to jamrizzi: "And
 * damn it did flip but it reset my effort." The flip half worked. He had effort
 * on `max`; the pane came back on the middle stop reading `High`.
 *
 * WHERE IT WENT. A relaunch is a FRESH Claude Code process, and a fresh process
 * reads its model and effort out of the config dir it was pointed at, not out
 * of the session it is continuing. Two relaunches do this:
 *
 *   a flip          claudeLocalLauncher's loop respawns the child with a new
 *                   CLAUDE_CONFIG_DIR (drover/flip/apply.ts). Same launcher,
 *                   same process, new account.
 *   a CLI rebuild   DROVE-220. The whole node process exits 75 and
 *                   `bin/drover.mjs` starts the new bundle in the same pane.
 *
 * Neither put the session's picks anywhere the new child could read them, so
 * both landed on whatever the config said. The flip is the one that hurt,
 * because the config it landed on belonged to a DIFFERENT account.
 *
 * AND THEN IT ERASED THE EVIDENCE, which is the half that made it permanent.
 * `mirrorPaneIntoRequest` exists to keep the app's stored request honest when
 * the pane moves under it (DROVE-191/199) — Clay types `/effort high` at his
 * keyboard and the phone's slider follows. It cannot tell that move apart from
 * a relaunch landing on a default, so the first turn on the new account
 * mirrored `high` straight over `effortLevel: max`. The request was gone, not
 * merely unapplied, which is why re-picking felt like the only way back.
 *
 * TWO HALVES, AND THE ORDER MATTERS.
 *
 *   modeCarryArgs        puts the picks on the child's argv, so the process
 *                        BOOTS on them. This is the half that beats the first
 *                        turn: a flip's arrival prompt is a positional argument
 *                        to that same spawn, so anything applied after the
 *                        child is up has already lost a turn to the wrong
 *                        effort — which is most of what the ticket was about.
 *   modeReconcileCommands  the backstop, for a value the argv did not land.
 *                        Compares the request against what the pane is OBSERVED
 *                        to hold and produces the same pane commands a phone
 *                        pick produces. A refusal there is Claude Code's own
 *                        sentence in the chat, and the existing mirror rolls the
 *                        request back to what the pane actually took — which is
 *                        DROVE-199's visible rollback, not a silent landing
 *                        somewhere else.
 *
 * WHAT EACH FLAG ACTUALLY DOES, measured against 2.1.251 rather than assumed,
 * because the three do not fail alike and one of them fails fatally:
 *
 *   --effort bogus              `Warning: Unknown --effort value 'bogus' —
 *                               ignoring it and using the default effort.`
 *                               exit 0, session runs. Safe to pass anything.
 *   --effort ultracode          accepted silently, though the warning above
 *                               lists only low/medium/high/xhigh/max. So the
 *                               printed list is not the accepted list and this
 *                               file does not filter against it.
 *   --permission-mode bogus     `error: option '--permission-mode <mode>'
 *                               argument 'bogus' is invalid.` THE PROCESS NEVER
 *                               STARTS. A mode from a newer app spelled a way
 *                               this Claude does not know would not reset the
 *                               session, it would end it. Hence the allow-list
 *                               below, and hence permission mode is the one
 *                               field here that is filtered rather than passed.
 *   --model bogus-model-xyz     starts, then every turn fails with "There's an
 *                               issue with the selected model". Bad, but a live
 *                               session that says so, and the reconcile below
 *                               is what gets it back.
 *
 * WHY PASSING THE MODEL IS NOT THE GAMBLE IT LOOKS LIKE. A flip only lands on
 * an account `pickTarget` believes can run the current family, and when nothing
 * can, DROVE-187 downgrades and REWRITES `modelMode` before the relaunch. So by
 * the time this runs, the model in metadata is one the target is already
 * believed to hold; passing it is exactly as safe as the flip decision itself,
 * and the reconcile covers the case where that belief was wrong.
 *
 * THE PERMISSION MODE HAS TO EVICT A FLAG TO BE HEARD. cattle-drover's `bin/drover`
 * prepends `--dangerously-skip-permissions` to every session start, and that
 * flag beats `--permission-mode` — measured, `--dangerously-skip-permissions
 * --permission-mode plan` answers "No" to whether it is in plan mode, while
 * `--permission-mode plan` alone answers "Yes". The CLI's own
 * `resolveInitialClaudePermissionMode` reads it the same way. So carrying a
 * request NARROWER than bypass means dropping the skip flag for that spawn.
 * Leaving both on would relaunch a session Clay had put in plan mode straight
 * back into bypass, which is the wrong direction to be wrong in.
 */

import { logger } from '@/ui/logger'

import { mapToClaudeMode, isPermissionMode } from './permissionMode'
import { paneModelAsRequest } from './paneModelSync'

/** The three picks, as the app stores them in session metadata. */
export interface ModeRequest {
    /** Full model id, e.g. `claude-opus-5`. Null is an explicit reset. */
    modelMode?: string | null
    /** `low` | `medium` | `high` | `xhigh` | `max` | `ultracode`. */
    effortLevel?: string | null
    /** An APP permission key — `yolo` and friends included. Folded here. */
    permissionMode?: string | null
}

/** What the pane is observed to hold. `undefined` is "nothing read yet". */
export interface ModeObservation {
    model?: string | null
    effort?: string | null
    /** Already a Claude mode, as read off the footer. */
    permissionMode?: string | undefined
}

/**
 * The values `--permission-mode` accepts, from the parser's own error message
 * in 2.1.251, plus `default` which it takes but does not list.
 *
 * This is an allow-list rather than a sanity check because the failure is
 * fatal: commander rejects an unknown value before Claude Code starts, so a
 * mode this CLI does not recognise must never reach the argv. A dropped flag
 * costs one reconcile through the pane; a bad one costs the session.
 */
const permissionModeFlagValues = new Set([
    'acceptEdits',
    'auto',
    'bypassPermissions',
    'default',
    'dontAsk',
    'manual',
    'plan',
])

/**
 * A value safe to hand to a spawn as an argument. Model ids carry dots, colons,
 * slashes and the `[1m]` bracket variant, so those are in. Nothing that could
 * be read as a second flag is: a leading `-` would make `--effort` swallow the
 * next token as its value and turn the rest of the argv into positional prompt
 * text.
 */
const safeArgument = /^[A-Za-z0-9._:/[\]][A-Za-z0-9._:/[\]-]*$/

function usable(value: string | null | undefined): value is string {
    // Null is a real value meaning "reset", but a reset is what a fresh process
    // already does, so there is nothing to carry.
    return typeof value === 'string' && value.length > 0 && safeArgument.test(value)
}

/**
 * Does this argv already say something about `flag`? Whatever Clay typed on the
 * command line outranks a stored pick — he is looking at the terminal he typed
 * it into.
 */
function names(argv: readonly string[], flag: string): boolean {
    return argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`))
}

/**
 * The child's argv for a spawn that must come up on `request`.
 *
 * Returns a new array; `existing` is never mutated. `session.claudeArgs` is
 * long-lived and shared across every spawn of the session, and a permission
 * mode evicted for ONE relaunch must not stay evicted for the next.
 */
export function modeCarryArgs(
    existing: readonly string[] | undefined,
    request: ModeRequest,
): string[] {
    let argv = [...(existing ?? [])]
    const add: string[] = []

    if (usable(request.modelMode) && !names(argv, '--model')) {
        add.push('--model', request.modelMode)
    }
    if (usable(request.effortLevel) && !names(argv, '--effort')) {
        add.push('--effort', request.effortLevel)
    }

    const mode = permissionModeFlagArgument(request.permissionMode)
    if (mode !== null && !names(argv, '--permission-mode')) {
        if (mode === 'bypassPermissions') {
            // Already what the skip flag says, and the skip flag is what the
            // rest of the CLI reads for this (resolveInitialClaudePermissionMode).
            // Saying it twice, in two vocabularies, is how they drift.
            if (!argv.includes('--dangerously-skip-permissions')) add.push('--permission-mode', mode)
        } else {
            // See the header: the skip flag wins, so a narrower request only
            // lands once it is out of the way. For this spawn only.
            argv = argv.filter((arg) => arg !== '--dangerously-skip-permissions')
            add.push('--permission-mode', mode)
        }
    }

    return [...argv, ...add]
}

/**
 * The request's permission mode as an argument `--permission-mode` will take,
 * or null when it must not go on the argv at all.
 */
export function permissionModeFlagArgument(picked: string | null | undefined): string | null {
    if (picked === undefined || picked === null || picked === '') return null
    if (!isPermissionMode(picked)) {
        logger.debug(`[modeCarry] not carrying permission mode ${picked}: this CLI does not know it`)
        return null
    }
    const mode = mapToClaudeMode(picked)
    if (!permissionModeFlagValues.has(mode)) {
        // Fatal if passed. See permissionModeFlagValues.
        logger.debug(`[modeCarry] not carrying permission mode ${mode}: --permission-mode would refuse it`)
        return null
    }
    return mode
}

/**
 * Does the pane hold what was requested for this field?
 *
 * The three vocabularies are folded here exactly as the app's `paneAgrees`
 * folds them, and for the same reason. The model one is the subtle one: the
 * transcript reports `claude-opus-5` whether or not the pane is on the
 * `claude-opus-5[1m]` variant, so taking it literally would call every launch a
 * disagreement and retype `/model` forever. `paneModelAsRequest` is the
 * existing answer to that and this reuses it rather than growing a second.
 */
export function paneHoldsRequest(
    field: 'model' | 'effort' | 'permissionMode',
    request: ModeRequest,
    observed: ModeObservation,
): boolean {
    if (field === 'model') {
        const want = request.modelMode ?? null
        return paneModelAsRequest(observed.model ?? null, want) === want
    }
    if (field === 'effort') {
        return (observed.effort ?? null) === (request.effortLevel ?? null)
    }
    const want = request.permissionMode === undefined || request.permissionMode === null
        ? 'default'
        : isPermissionMode(request.permissionMode)
            ? mapToClaudeMode(request.permissionMode)
            : undefined
    if (want === undefined) return true
    return observed.permissionMode === want
}

/**
 * The pane commands that would put the pane back on `request`, for the fields
 * the pane has actually reported and does not already agree with.
 *
 * Same spellings and same order as `paneCommandsForSelection`: permission mode
 * first because its carrier is a shift+tab loop that needs the prompt looking
 * the way it found it, then model, then effort, because effort is capped by the
 * model and the other order silently keeps the old one.
 *
 * A field with no observation yet produces nothing. That is not caution, it is
 * the DROVE-199 rule: `undefined` is not "the pane is on default", and treating
 * it as one is how a mode gets retyped before anything has been read.
 */
export function modeReconcileCommands(
    request: ModeRequest,
    observed: ModeObservation,
): string[] {
    const out: string[] = []

    if (observed.permissionMode !== undefined && !paneHoldsRequest('permissionMode', request, observed)) {
        const mode = request.permissionMode === undefined || request.permissionMode === null
            ? 'default'
            : isPermissionMode(request.permissionMode)
                ? mapToClaudeMode(request.permissionMode)
                : null
        if (mode !== null) out.push(`#permission-mode ${mode}`)
    }
    if (observed.model !== undefined && usable(request.modelMode) && !paneHoldsRequest('model', request, observed)) {
        out.push(`/model ${request.modelMode}`)
    }
    if (observed.effort !== undefined && usable(request.effortLevel) && !paneHoldsRequest('effort', request, observed)) {
        out.push(`/effort ${request.effortLevel}`)
    }

    return out
}
