/**
 * Integration test for pane injection (BASED-113) against a REAL tmux server.
 *
 * The whole point of this code is the tmux mechanics — set-buffer, paste-buffer
 * as one bracketed paste, the shell guard — none of which a mock proves. So this
 * drives an actual detached tmux session and reads the pane back. Skipped
 * cleanly when tmux is not on PATH, so it never fails a box without tmux.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import { injectIntoPane } from './paneInject'

const run = promisify(execFile)
const SESSION = 'happy-inject-itest'

async function tmux(args: string[]): Promise<string> {
    return (await run('tmux', args)).stdout
}
async function hasTmux(): Promise<boolean> {
    try { await run('tmux', ['-V']); return true } catch { return false }
}
async function killSession(): Promise<void> {
    try { await run('tmux', ['kill-session', '-t', SESSION]) } catch { /* not there */ }
}
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms))

const maybe = (await hasTmux()) ? describe : describe.skip

maybe('injectIntoPane against real tmux', () => {
    afterEach(killSession)

    it('types a single-line message into a pane running a non-shell program', async () => {
        // `cat` echoes stdin, so a delivered inject shows up in the pane, and
        // its foreground command is "cat" — not one of the refused shells.
        await run('tmux', ['new-session', '-d', '-s', SESSION, '-x', '80', '-y', '24', 'cat'])
        await settle()
        const pane = (await tmux(['list-panes', '-t', SESSION, '-F', '#{pane_id}'])).trim()

        const delivered = await injectIntoPane(pane, 'hello from the phone')
        await settle()

        expect(delivered).toBe(true)
        expect(await tmux(['capture-pane', '-p', '-t', pane])).toContain('hello from the phone')
    })

    it('delivers a multi-line message as ONE paste, not a line at a time', async () => {
        await run('tmux', ['new-session', '-d', '-s', SESSION, '-x', '80', '-y', '24', 'cat'])
        await settle()
        const pane = (await tmux(['list-panes', '-t', SESSION, '-F', '#{pane_id}'])).trim()

        const delivered = await injectIntoPane(pane, 'line-one\nline-two')
        await settle()

        expect(delivered).toBe(true)
        const body = await tmux(['capture-pane', '-p', '-t', pane])
        expect(body).toContain('line-one')
        expect(body).toContain('line-two')
    })

    it('REFUSES a pane sitting at a shell prompt, and types nothing into it', async () => {
        await run('tmux', ['new-session', '-d', '-s', SESSION, '-x', '80', '-y', '24']) // default shell
        await settle(400)
        const pane = (await tmux(['list-panes', '-t', SESSION, '-F', '#{pane_id}'])).trim()

        const delivered = await injectIntoPane(pane, 'should NOT be typed')
        await settle()

        expect(delivered).toBe(false)
        expect(await tmux(['capture-pane', '-p', '-t', pane])).not.toContain('should NOT be typed')
    })

    it('refuses a pane that does not exist rather than throwing', async () => {
        await expect(injectIntoPane('%99999', 'x')).resolves.toBe(false)
    })
})
