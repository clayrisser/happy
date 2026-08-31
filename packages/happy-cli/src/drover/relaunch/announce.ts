/**
 * Saying a relaunch is coming, without corrupting the screen (DROVE-172).
 *
 * The claude TUI owns the pane for as long as the child runs, so the terminal
 * itself is not a surface a note may use mid-turn -- the same constraint the
 * flip controller works under. The tmux status bar is, and it is already where
 * the drover reports. Best effort throughout: no tmux, no pane, and the log
 * still has it.
 */

import { execFile } from 'node:child_process'

import { logger } from '@/ui/logger'

export function announceRelaunch(message: string): void {
    logger.debug(`[relaunch] ${message}`)

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
