/**
 * Putting the session's own model and effort back after a flip (DROVE-272).
 *
 * Clay: "when I switch accounts it doesn't flip back to whatever the model and
 * effort I had originally had, so you need to remember what was the model and
 * effort I had already set in the mobile app and you probably have to
 * explicitly flip it if it's not matching when you go to it."
 *
 * MOST OF THAT IS ALREADY BUILT, and it is important to know which part, or
 * this file grows a second copy of it. DROVE-232 remembers and re-applies:
 * `modeCarryArgs` puts `modelMode` and `effortLevel` on the replacement child's
 * argv so the process BOOTS on them, and `modeReconcileCommands` types whatever
 * the argv did not land once the pane has said what it is actually running.
 * The confirmation Claude Code raises for a model switch is read and answered
 * by `applyPaneSelectionCommand` (DROVE-164), so a restore cannot strand an
 * unattended terminal on "Switch model?".
 *
 * WHAT WAS MISSING IS THE ONE CASE THE CARRY CANNOT DO SAFELY: the account
 * being flipped TO cannot run the remembered model. modeCarry's own header
 * says why it assumed that never happens --
 *
 *   "A flip only lands on an account `pickTarget` believes can run the current
 *    family, and when nothing can, DROVE-187 downgrades and REWRITES
 *    `modelMode` before the relaunch."
 *
 * -- and there are three holes in that belief, all reachable:
 *
 *   an explicit flip     `/flip alt` from the phone takes pickTarget's `wanted`
 *                        branch, which overrides the cooldown ledger on purpose
 *                        (a human overruling a heuristic) and never computes
 *                        `withoutModel` at all. This is Clay's own sentence:
 *                        "when I SWITCH ACCOUNTS".
 *   Account switching:   `flip-only` and `nothing` skip the downgrade, so
 *   not downgrade        `withoutModel` is reported and the model stands.
 *   no rung with room    `planDowngrade` returns null when nothing below the
 *                        family has headroom either.
 *
 * In every one of those the carry faithfully passes `--model claude-fable-5` to
 * a child on an account whose Fable week is spent, which is the thing the
 * ticket forbids in as many words: never pin a session to the one model its
 * account cannot run. The first turn then hits the same wall it just flipped to
 * escape, and the flip that was supposed to rescue the session bought nothing.
 *
 * So this file answers one question -- given what the session was set to and
 * the account it is landing on, what must it come up on -- and it answers it
 * the way the ticket says: KEEP THE EFFORT, take the account's best model, and
 * SAY SO. Never substitute silently; a model Clay did not choose that he cannot
 * see is worse than the wall, because the wall at least announces itself.
 *
 * It reuses `downgrade.ts` for the ladder, the `[1m]` bracket and the effort
 * clamp rather than growing a second set. A restore-substitution and a
 * downgrade are the same arithmetic reached by different roads, and only the
 * sentence they print differs.
 */

import { familyLabel, familyOf } from './limits'
import { ladderFor, modelIdFor, nearestEffort } from './downgrade'

/** What the session was set to before the flip tore it down. */
export interface SessionChoice {
    model?: string | null
    effort?: string | null
}

export interface RestorePlan {
    /** The model the relaunched session must come up on. Null: none remembered. */
    model: string | null
    /**
     * The effort to TYPE, and null means leave effort alone -- the same meaning
     * `DowngradePlan.effort` carries, because the same launcher code consumes
     * both. Non-null only when the model taken cannot hold the one we were on.
     */
    effort: string | null
    /** The effort the session was set to, kept across the restore. For the sentence. */
    keptEffort: string | null
    /**
     * Does the app's stored request have to be rewritten, and the pane retyped?
     *
     * False for a plain restore: the request already holds what Clay picked and
     * DROVE-232's carry already puts it on the child's argv. Touching metadata
     * there would only rewrite a value to itself and re-type a `/model` at a
     * terminal that is already on it.
     */
    rewrite: boolean
    /** Set only when the remembered model was NOT the one taken. */
    substitution?: RestoreSubstitution
}

export interface RestoreSubstitution {
    /** The model that was remembered and not taken. */
    instead: string
    /** The family the target account is out of. */
    withoutModel: string
    /**
     * The remembered model STANDS, because nothing better was available. The
     * restore then changes nothing and only says what is about to happen.
     */
    stood?: 'no lower model' | 'policy'
}

export interface RestoreOptions {
    /** What the session was set to, read at the moment of the flip. */
    remembered: SessionChoice
    /**
     * Can the account being flipped TO run this family right now? Asked of that
     * one account, never of the registry: "somewhere has Opus" is not an answer
     * to "does the machine I am about to land on have Opus".
     */
    runnable: (family: string) => boolean
    /** The store's chain, when the bus answered. Falls back to the built-in ladder. */
    familyFallback?: Record<string, string[]> | null
    /**
     * May the model be changed at all? `Account switching: flip only` and
     * `nothing` say no, and a restore is not the place to overrule a setting
     * Clay moved on purpose. It still gets SAID -- that is the half the setting
     * does not govern.
     */
    mayChangeModel?: boolean
}

/**
 * What the relaunch must come up on, or null when there is nothing to put back.
 *
 * Null means the session had picked nothing: no model and no effort, so a fresh
 * child on the target's own default is exactly as right as anything else and
 * there is no memory to honour.
 */
export function planRestore(opts: RestoreOptions): RestorePlan | null {
    const wanted = text(opts.remembered.model)
    const keptEffort = text(opts.remembered.effort)
    if (wanted === null && keptEffort === null) return null

    const family = familyOf(wanted)
    // No family means no claim either way: an id this CLI cannot reduce is not
    // an id it may declare unrunnable. Keep it, the way every other unknown in
    // this system is kept rather than guessed at.
    if (wanted === null || family === undefined || opts.runnable(family)) {
        return {
            model: wanted,
            effort: null,
            keptEffort,
            rewrite: false,
        }
    }

    if (opts.mayChangeModel === false) {
        return {
            model: wanted,
            effort: null,
            keptEffort,
            rewrite: false,
            substitution: { instead: wanted, withoutModel: family, stood: 'policy' },
        }
    }

    for (const to of ladderFor(family, opts.familyFallback)) {
        if (!opts.runnable(to)) continue
        const id = modelIdFor(to, wanted)
        if (!id) continue
        // The effort is what is being KEPT here, so it is only touched when the
        // model taken genuinely cannot hold it -- `nearestEffort` steps down,
        // never up, so this can only ever return a level Clay would have been
        // dropped to by Claude Code itself a moment later, silently.
        const allowed = nearestEffort(id, keptEffort)
        return {
            model: id,
            effort: allowed !== null && allowed !== keptEffort ? allowed : null,
            keptEffort,
            rewrite: true,
            substitution: { instead: wanted, withoutModel: family },
        }
    }

    return {
        model: wanted,
        effort: null,
        keptEffort,
        rewrite: false,
        substitution: { instead: wanted, withoutModel: family, stood: 'no lower model' },
    }
}

/**
 * What the arrival prompt says about the restore, or null when there is nothing
 * worth saying.
 *
 * Nothing worth saying is the ordinary case, and deliberately so: a plain
 * restore puts the session back on exactly what Clay picked, which is what he
 * expects to happen and does not need telling. The prompt speaks up only when
 * the session is coming up on something OTHER than what he set.
 *
 * Second person, and it never calls the substitution a downgrade: from the
 * session's side this is the model it is being handed, and the word for the
 * rung-dropping decision belongs to `downgradeNote`.
 */
export function restoreNote(plan: RestorePlan | null | undefined, account: string): string | null {
    const swap = plan?.substitution
    if (!plan || !swap) return null

    const out = familyLabel(swap.withoutModel)
    if (swap.stood) {
        const why =
            swap.stood === 'policy'
                ? 'the model was left alone because that is what Account switching is set to'
                : 'no lower model has headroom there either'
        return (
            `\n\nCattle Drover: ${account} is out of ${out} and ${why}, so you are still on ` +
            `${swap.instead} and the next turn will hit the same wall. Switch models with ` +
            '`/model`, or flip somewhere with headroom.'
        )
    }

    const parts = [
        `\n\nCattle Drover: ${account} is out of ${out}, so this session came up on ${plan.model} ` +
            `rather than the ${swap.instead} it was set to.`,
    ]
    if (plan.effort) {
        parts.push(
            ` The effort you had set (${plan.keptEffort}) is not one ${plan.model} takes, so it is ` +
                `${plan.effort} — the nearest it accepts.`,
        )
    } else if (plan.keptEffort) {
        parts.push(` Your effort (${plan.keptEffort}) was kept.`)
    }
    parts.push(
        ` Nothing else was reset. Put the model back with \`/model\` once ${out} resets.`,
    )
    return parts.join('')
}

/** A pick worth carrying, or null. Empty strings are "never picked", not a value. */
function text(value: string | null | undefined): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null
}
