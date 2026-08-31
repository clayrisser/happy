/**
 * Saying a relaunch is coming, where Clay will actually see it (DROVE-172,
 * DROVE-220).
 *
 * The claude TUI owns the pane for as long as the child runs, so the terminal
 * itself is not a surface a note may use mid-turn -- the same constraint the
 * flip controller works under. The tmux status bar is, and it is already where
 * the drover reports.
 *
 * BUT THE TMUX BAR IS ON A MAC CLAY IS NOT LOOKING AT. That is the whole of
 * DROVE-220: on 2026-08-31 three CLI fixes shipped, the session stayed on the
 * eight-hour-old bundle, and every notice about it went to a status line and a
 * debug log while Clay was on his phone reporting all three as still broken.
 * A notice that only reaches the machine nobody is watching is the same as no
 * notice. So the session says it in the conversation too, which is the surface
 * the phone renders -- the same `sendSessionEvent({ type: 'message' })` a held
 * prompt already uses to say it is waiting.
 *
 * Best effort throughout, and in that order: the phone first, because it is
 * the one that matters, and because a socket that is down must not cost the
 * tmux line as well. Nothing here may throw -- the caller is a poll timer
 * deciding whether to hand a live session over, and a failed announcement is
 * never a reason to abandon that.
 */

import { execFile } from 'node:child_process'

import { logger } from '@/ui/logger'

/** Where a notice goes so the phone renders it. Null when there is no session yet. */
export type RelaunchPhoneSink = ((message: string) => void) | null | undefined

export function announceRelaunch(message: string, toPhone?: RelaunchPhoneSink): void {
    logger.debug(`[relaunch] ${message}`)

    if (toPhone) {
        try {
            toPhone(message)
        } catch (e) {
            logger.debug('[relaunch] could not reach the phone', e)
        }
    }

    const pane = process.env.TMUX_PANE
    if (!pane || !process.env.TMUX) return
    // tmux reads the string as a FORMAT, so a literal # has to be doubled or
    // it is eaten as the start of #{...}.
    const line = message.replace(/\s+/g, ' ').trim().replace(/#/g, '##')
    execFile('tmux', ['display-message', '-d', '10000', '-t', pane, line], (err) => {
        if (!err) return
        // tmux before 3.2 has no -d and answers with a usage error.
        execFile('tmux', ['display-message', '-t', pane, line], (err2) => {
            if (err2) logger.debug('[relaunch] could not reach the tmux status line', err2)
        })
    })
}
