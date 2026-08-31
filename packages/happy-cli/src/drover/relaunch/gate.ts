/**
 * When a rebuilt bundle is allowed to take the session over (DROVE-172).
 *
 * The watcher says the code changed. This says whether now is a moment we may
 * act on it, and the answer is only ever "the child is between turns".
 *
 * Restarting mid-turn would be worse than the bug it fixes. Stopping the child
 * is a SIGTERM, async subagents live INSIDE that process, and Clay runs 4-12 at
 * a time -- the whole reason BASED-135 exists.
 *
 * THE FIRST VERSION OF THIS GATE GOT IT WRONG, and it took a live run to see
 * it. It asked `thinking`, which comes from the child's fd3 fetch counter, and
 * treated three quiet polls as the end of a turn. But a turn spends most of a
 * long tool call with NO fetch in flight: the model has already emitted the
 * tool use and is waiting on the result. Measured on 2026-08-31 with a
 * `sleep 150` running in the pane -- `thinking` read false for the whole of it,
 * the streak filled in fifteen seconds, and the relaunch killed a bash tool
 * mid-run. A streak of a signal that is blind to tool calls is still blind.
 *
 * So the authority is Claude Code's OWN answer: the record it keeps for the
 * session in `<config dir>/sessions/`, whose `status` reads `idle` at the
 * prompt and `busy`/`shell` inside a turn. That is the same record `paneIsIdle`
 * has gated pane injection on since BASED-98, and it saw the `sleep 150` for
 * what it was. `thinking` and the subagent count stay as a cheap pre-filter
 * ahead of it, not as the decision.
 *
 * QUIET IS STILL A STREAK. The registry is a file the child rewrites, so one
 * sample can catch a gap between two records. Three in a row, five seconds
 * apart, is fifteen seconds of continuous idle.
 *
 * THERE IS NO TIMEOUT AND NO OVERRIDE. A stale session that stays busy stays
 * stale, however long that takes. Everything unknown -- no registry record, a
 * tmux that will not answer -- reads as busy, so the failure mode is a session
 * that keeps running the old bundle and is NAMED as such by
 * `drover stale-sessions`, never a session interrupted on a guess.
 *
 * BACKGROUND SHELLS ARE COVERED, and that was not a decision so much as a
 * measurement. A relaunch stops the child, so anything the session put in the
 * background dies with it exactly as it dies on a `/flip`. Claude reports a
 * live background shell as `shell` rather than `idle`, so the gate waits for
 * that too -- a stricter guarantee than a flip gives. The cost is a session
 * holding a long-lived background process that never picks a build up on its
 * own. `drover stale-sessions` names it, which is the right end of that trade:
 * a report Clay has to read beats a `sleep 200` killed at the fourteen-second
 * mark, which is what the first version of this did.
 *
 * It also refuses to act at all unless two things are true:
 *
 *   a wrapper is supervising us   `bin/drover.mjs` sets DROVER_RELAUNCH_FILE
 *                                 before it spawns the bundle. Without it,
 *                                 exiting ends the session instead of
 *                                 continuing it, so we only say so.
 *   the transcript has an id      `--resume <id>` is the entire mechanism for
 *                                 keeping the conversation. Before the
 *                                 SessionStart hook fires there is nothing to
 *                                 resume onto, and a relaunch would start an
 *                                 empty session in place of a real one.
 */

import { logger } from '@/ui/logger'

import { relaunchIsSupervised } from './handover'
import type { StaleWatcher } from './staleWatcher'

export interface RelaunchGateDeps {
    watcher: StaleWatcher
    /** The Claude transcript id, null until the SessionStart hook names it. */
    claudeSessionId: () => string | null
    /**
     * Cheap pre-filter: a fetch is in flight, or subagents are still running.
     * True is conclusive; false proves nothing on its own, which is exactly the
     * mistake the header describes.
     */
    isBusy: () => boolean
    /**
     * Claude Code's own word for "sitting at the prompt". Anything it cannot
     * answer must come back false.
     */
    turnIsOver: () => Promise<boolean>
    /** Is a child in the pane right now? Nothing to stop between spawns. */
    childAlive: () => boolean
    /** Stop the child, which ends the launcher run. */
    abortChild: () => void
    /** Say it where Clay can see it. */
    announce: (line: string) => void
    pollMs?: number
    /** Consecutive quiet polls required before the child is stopped. */
    quietPolls?: number
    supervised?: boolean
}

export interface RelaunchGate {
    /** Has this gate asked for the relaunch? Read when the child exits. */
    requested(): boolean
    /** One poll. Exposed for tests; the timer calls it. */
    poll(): Promise<void>
    stop(): void
}

export const defaultPollMs = 5000

/**
 * Three polls at 5s is fifteen seconds of continuous idle. Long enough that no
 * gap between two of the child's registry writes covers it, short enough that
 * Clay is not sitting in front of a session he was just told would pick the
 * build up.
 */
export const defaultQuietPolls = 3

export function startRelaunchGate(deps: RelaunchGateDeps): RelaunchGate {
    const supervised = deps.supervised ?? relaunchIsSupervised()
    const quietPolls = deps.quietPolls ?? defaultQuietPolls
    let requested = false
    let saidStale = false
    let saidWaiting = false
    let quietStreak = 0
    let polling = false
    let timer: NodeJS.Timeout | null = null

    function waiting(): void {
        quietStreak = 0
        if (saidWaiting) return
        saidWaiting = true
        deps.announce(
            'Cattle Drover: a newer CLI has been built. This session will pick it up as soon as the current turn ends.'
        )
    }

    async function poll(): Promise<void> {
        if (requested) return
        // The idle probe reads files and shells out to tmux, so a poll can
        // outlive its interval. Overlapping polls would double-count the streak
        // and turn fifteen seconds of required quiet into five.
        if (polling) return
        polling = true
        try {
            if (!deps.watcher.stale() && !deps.watcher.tick()) return

            if (!saidStale) {
                saidStale = true
                logger.debug('[relaunch] the CLI bundle under this session was rebuilt')
                if (!supervised) {
                    // Honest rather than silent. This is the case the ticket was
                    // filed for: nothing here can fix it, so say so instead of
                    // letting the session look current.
                    deps.announce(
                        'Cattle Drover: this session is running an older build of the CLI. ' +
                        'It was not started through the drover wrapper, so it cannot pick the new one up on its own — restart it when convenient.'
                    )
                }
            }
            if (!supervised) {
                stop()
                return
            }

            const claudeSessionId = deps.claudeSessionId()
            if (claudeSessionId === null) {
                quietStreak = 0
                if (!saidWaiting) {
                    saidWaiting = true
                    logger.debug('[relaunch] no transcript id yet — waiting before relaunching')
                }
                return
            }
            if (deps.isBusy() || !deps.childAlive()) {
                waiting()
                return
            }

            let over = false
            try {
                over = await deps.turnIsOver()
            } catch (e) {
                // Unknown is busy. A probe that threw is not permission to stop
                // a child that may be halfway through a tool call.
                logger.debug('[relaunch] could not read the turn state — treating as busy', e)
                over = false
            }
            // Another poll may have fired while that was in flight, and the
            // child may have gone away underneath it.
            if (requested) return
            if (!over || !deps.childAlive()) {
                waiting()
                return
            }

            quietStreak += 1
            if (quietStreak < quietPolls) {
                logger.debug(`[relaunch] idle ${quietStreak}/${quietPolls} — waiting to be sure the turn is over`)
                return
            }

            requested = true
            logger.debug('[relaunch] idle — stopping the child so the new bundle can take over')
            deps.announce('Cattle Drover: picking up the CLI that was just built. The conversation is resumed, not restarted.')
            stop()
            deps.abortChild()
        } finally {
            polling = false
        }
    }

    function stop(): void {
        if (timer !== null) {
            clearInterval(timer)
            timer = null
        }
    }

    timer = setInterval(() => { void poll() }, deps.pollMs ?? defaultPollMs)
    timer.unref?.()

    return { requested: () => requested, poll, stop }
}
