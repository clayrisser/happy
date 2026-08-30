/**
 * Type a phone message straight into the local tmux pane (BASED-113).
 *
 * Happy's default is that the phone MIRRORS a local session and can only send
 * input by TAKING OVER — the message goes on the queue, local Claude is stopped,
 * and remote mode is spawned to serve it. For a session you are watching run in
 * tmux that is the wrong trade: it kills the terminal you were looking at and
 * hides whatever it was doing (subagents included) behind a fresh headless run.
 *
 * When the session IS a live Claude in a tmux pane, there is a better carrier:
 * the pane itself. `$TMUX_PANE` identifies it exactly — the same handle the flip
 * keys pass as `#{pane_id}` — so the message can be typed in as if you were at
 * the keyboard, no mode switch, no new session, and the work in flight stays on
 * screen. Remote mode remains the fallback for sessions with no pane
 * (daemon-spawned) and for a pane that is NOT currently running Claude.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { logger } from '@/ui/logger'

const run = promisify(execFile)

// Commands that mean the pane is NOT showing a Claude TUI right now, so typing
// into it would land at a shell prompt (or another tmux) rather than in the
// conversation. A parked drover session sits at exactly one of these. Matched
// against tmux's `pane_current_command`, which is the pane's foreground process.
const NOT_CLAUDE = new Set(['zsh', 'bash', 'sh', 'fish', 'tmux', 'ssh', 'login'])

/**
 * Is `pane` a live tmux pane currently running Claude (and therefore safe to
 * type into)? Returns the pane's foreground command on success, or null when
 * the pane is gone or is sitting at a shell.
 */
async function paneRunningClaude(pane: string): Promise<string | null> {
    try {
        const { stdout } = await run('tmux', [
            'display-message', '-p', '-t', pane, '#{pane_current_command}',
        ])
        const cmd = stdout.trim()
        if (!cmd) return null
        return NOT_CLAUDE.has(cmd) ? null : cmd
    } catch {
        // No such pane, or no tmux server reachable from here.
        return null
    }
}

/**
 * Type `text` into `pane` and submit it, as if the user had typed at the
 * keyboard. Returns false — caller should fall back to a remote switch — when
 * the pane is gone or is not currently running Claude.
 *
 * A paste BUFFER rather than `send-keys -l`: send-keys turns a newline into a
 * carriage return, which a TUI reads as submit, so a two-line message would
 * fire the first line as its own turn. paste-buffer sends the whole thing as
 * one bracketed paste, which Claude Code drops into the input box intact; the
 * single Enter that follows is what submits it.
 */
export async function injectIntoPane(pane: string, text: string): Promise<boolean> {
    const cmd = await paneRunningClaude(pane)
    if (!cmd) {
        logger.debug(`[paneInject] ${pane} is not running Claude — declining to inject`)
        return false
    }
    try {
        // A named buffer so this never disturbs the user's own paste buffer,
        // and `-d` on paste removes it right after.
        const buf = 'happy-inject'
        await run('tmux', ['set-buffer', '-b', buf, '--', text])
        await run('tmux', ['paste-buffer', '-d', '-b', buf, '-t', pane])
        await run('tmux', ['send-keys', '-t', pane, 'Enter'])
        logger.debug(`[paneInject] typed ${text.length} char(s) into ${pane} (running ${cmd})`)
        return true
    } catch (e) {
        logger.debug('[paneInject] failed:', e)
        return false
    }
}
