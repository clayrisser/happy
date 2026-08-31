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
import { afterEach, describe, expect, it, vi } from 'vitest'

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
/**
 * Wait for the pane's foreground process to be what the test needs (DROVE-68).
 *
 * tmux starts a pane and then execs into it, so a fresh session's
 * `pane_current_command` is whatever it happens to be for the first few
 * milliseconds. This used to be a 300 ms sleep, which on a loaded box is a
 * coin toss on a test whose whole subject is which command tmux reports.
 */
async function waitForPaneCommand(pane: string, want: (cmd: string) => boolean): Promise<void> {
    await vi.waitFor(async () => {
        const cmd = (await tmux(['display-message', '-p', '-t', pane, '#{pane_current_command}'])).trim()
        if (!want(cmd)) throw new Error(`pane is running "${cmd}"`)
    }, { timeout: 5_000, interval: 25 })
}

/** Wait for what was pasted to come back out of the pane. */
async function waitForPaneBody(pane: string, ...needles: string[]): Promise<string> {
    return await vi.waitFor(async () => {
        const body = await tmux(['capture-pane', '-p', '-t', pane])
        for (const needle of needles) {
            if (!body.includes(needle)) throw new Error(`pane has not shown "${needle}" yet:\n${body}`)
        }
        return body
    }, { timeout: 5_000, interval: 25 })
}

/** The commands paneInject treats as "not Claude", so a pane at one is refused. */
const shells = new Set(['zsh', 'bash', 'sh', 'fish'])

const maybe = (await hasTmux()) ? describe : describe.skip

maybe('injectIntoPane against real tmux', () => {
    afterEach(killSession)

    it('types a single-line message into a pane running a non-shell program', async () => {
        // `cat` echoes stdin, so a delivered inject shows up in the pane, and
        // its foreground command is "cat" — not one of the refused shells.
        await run('tmux', ['new-session', '-d', '-s', SESSION, '-x', '80', '-y', '24', 'cat'])
        const pane = (await tmux(['list-panes', '-t', SESSION, '-F', '#{pane_id}'])).trim()
        await waitForPaneCommand(pane, (cmd) => cmd === 'cat')

        const delivered = await injectIntoPane(pane, 'hello from the phone')

        expect(delivered).toBe(true)
        expect(await waitForPaneBody(pane, 'hello from the phone')).toContain('hello from the phone')
    })

    it('delivers a multi-line message as ONE paste, not a line at a time', async () => {
        await run('tmux', ['new-session', '-d', '-s', SESSION, '-x', '80', '-y', '24', 'cat'])
        const pane = (await tmux(['list-panes', '-t', SESSION, '-F', '#{pane_id}'])).trim()
        await waitForPaneCommand(pane, (cmd) => cmd === 'cat')

        const delivered = await injectIntoPane(pane, 'line-one\nline-two')

        expect(delivered).toBe(true)
        const body = await waitForPaneBody(pane, 'line-one', 'line-two')
        expect(body).toContain('line-one')
        expect(body).toContain('line-two')
    })

    it('REFUSES a pane sitting at a shell prompt, and types nothing into it', async () => {
        // `sh` by name rather than the box's default shell. The refusal is
        // about what tmux reports as `pane_current_command`, and an
        // interactive login shell reports whatever its rc happens to be
        // running for the first moment or two. On a loaded box that was
        // still true when the inject went in, so the pane was not "at a shell"
        // and nothing was refused. A pane started on sh reports sh and keeps
        // reporting it.
        await run('tmux', ['new-session', '-d', '-s', SESSION, '-x', '80', '-y', '24', 'sh'])
        const pane = (await tmux(['list-panes', '-t', SESSION, '-F', '#{pane_id}'])).trim()
        // The refusal is ABOUT this command, so waiting for it is the
        // precondition, not a delay. A sleep that came up short tested nothing
        // and still passed.
        await waitForPaneCommand(pane, (cmd) => shells.has(cmd))

        const delivered = await injectIntoPane(pane, 'should NOT be typed')

        // Nothing is in flight to wait for: a refusal returns before any
        // set-buffer or paste-buffer is issued, so the pane can be read now.
        expect(delivered).toBe(false)
        expect(await tmux(['capture-pane', '-p', '-t', pane])).not.toContain('should NOT be typed')
    })

    it('refuses a pane that does not exist rather than throwing', async () => {
        await expect(injectIntoPane('%99999', 'x')).resolves.toBe(false)
    })
})

/**
 * The GATE (BASED-113) is about what does NOT happen: no Enter while Claude is
 * mid-turn, and none while a permission dialog is up. Real tmux cannot prove a
 * negative cheaply — "the pane looks the same" is also what a broken paste
 * looks like — so these drive a stub `tmux` on PATH that records its argv, and
 * assert on the exact commands. The registry and the bus are real files and a
 * real HTTP server, because those two readers are the gate.
 */

import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach } from 'vitest'

import { interruptPane, paneIsIdle } from './paneInject'

const claudeSessionId = '9b1daf73-eae8-46d9-85a1-cef9d54d622f'
const gatePane = '%42'

describe('the idle gate decides whether Enter is pressed', () => {
    let binDir: string
    let logPath: string
    let configDir: string
    let originalPath: string | undefined
    let bus: Server
    let busUrl: string
    let pendingEvents: Array<{ origin?: { sessionId?: string | null } }> = []
    let busStatus = 200

    async function tmuxArgv(): Promise<string[]> {
        try {
            return (await readFile(logPath, 'utf8')).split('\n').filter(Boolean)
        } catch {
            return []
        }
    }

    /** Rewrite the session's registry record. `null` removes the status. */
    async function setRegistryStatus(status: string | null): Promise<void> {
        await writeFile(join(configDir, 'sessions', '4242.json'), JSON.stringify({
            pid: 4242,
            sessionId: claudeSessionId,
            cwd: '/tmp/anywhere',
            tmux: `happy:@1.${gatePane}`,
            messagingSocketPath: '/tmp/cc-socks/4242.sock',
            ...(status === null ? {} : { status }),
        }))
    }

    beforeAll(async () => {
        binDir = await mkdtemp(join(tmpdir(), 'happy-fake-tmux-'))
        logPath = join(binDir, 'argv.log')
        // `display-message` is the pane-foreground probe; anything not in
        // NOT_CLAUDE reads as "Claude is up", so the default answer is `node`.
        await writeFile(join(binDir, 'tmux'), [
            '#!/bin/sh',
            'printf \'%s\\n\' "$*" >> "$FAKE_TMUX_LOG"',
            'if [ "$1" = "display-message" ]; then',
            '  printf \'%s\\n\' "${FAKE_PANE_CMD:-node}"',
            'fi',
            'exit 0',
            '',
        ].join('\n'))
        await chmod(join(binDir, 'tmux'), 0o755)

        configDir = await mkdtemp(join(tmpdir(), 'happy-fake-claude-'))
        await mkdir(join(configDir, 'sessions'), { recursive: true })

        bus = createServer((_req, res) => {
            res.writeHead(busStatus, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ events: pendingEvents }))
        })
        await new Promise<void>((resolve) => bus.listen(0, '127.0.0.1', resolve))
        const addr = bus.address()
        busUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
    })

    afterAll(async () => {
        await new Promise<void>((resolve) => bus.close(() => resolve()))
    })

    // PATH is put back after every test rather than at the end of the suite, so
    // the stub can never shadow real tmux for a test added after this block.
    beforeEach(async () => {
        originalPath = process.env.PATH
        process.env.PATH = `${binDir}:${originalPath ?? ''}`
        process.env.FAKE_TMUX_LOG = logPath
        await writeFile(logPath, '')
        delete process.env.FAKE_PANE_CMD
        pendingEvents = []
        busStatus = 200
        await setRegistryStatus('idle')
    })

    afterEach(() => {
        if (originalPath === undefined) delete process.env.PATH
        else process.env.PATH = originalPath
        delete process.env.FAKE_TMUX_LOG
        delete process.env.FAKE_PANE_CMD
    })

    const gate = () => ({ pane: gatePane, configDir, claudeSessionId, busUrl })

    it('opens the gate when the registry says idle and the bus holds nothing', async () => {
        expect(await paneIsIdle(gate())).toBe(true)

        // What the caller does once the gate passes: type it and press Enter.
        expect(await injectIntoPane(gatePane, '/model opus')).toBe(true)
        const argv = await tmuxArgv()
        expect(argv.some((line) => line.startsWith('paste-buffer'))).toBe(true)
        expect(argv.some((line) => line.startsWith('send-keys'))).toBe(true)
    })

    it('closes the gate when Claude is mid-turn', async () => {
        await setRegistryStatus('busy')

        expect(await paneIsIdle(gate())).toBe(false)
    })

    it('closes the gate when a bus event for this session is pending', async () => {
        // A permission card or a question is on screen and would eat the
        // keystroke, answering it with whatever is highlighted.
        pendingEvents = [{ origin: { sessionId: claudeSessionId } }]

        expect(await paneIsIdle(gate())).toBe(false)
    })

    it('ignores a pending event that belongs to another session', async () => {
        pendingEvents = [{ origin: { sessionId: 'someone-else' } }]

        expect(await paneIsIdle(gate())).toBe(true)
    })

    it('closes the gate when the registry has no record for the session', async () => {
        expect(await paneIsIdle({ ...gate(), claudeSessionId: 'never-registered' })).toBe(false)
    })

    it('closes the gate when the bus cannot be reached', async () => {
        // Nothing is listening on this port, so the fetch rejects. Unknown is
        // not idle.
        expect(await paneIsIdle({ ...gate(), busUrl: 'http://127.0.0.1:1' })).toBe(false)
    })

    it('closes the gate when the bus answers with an error', async () => {
        busStatus = 500
        expect(await paneIsIdle(gate())).toBe(false)
    })

    it('refuses outright when the pane has fallen back to a shell', async () => {
        process.env.FAKE_PANE_CMD = 'zsh'

        expect(await paneIsIdle(gate())).toBe(false)
        expect(await injectIntoPane(gatePane, 'nope')).toBe(false)
        expect((await tmuxArgv()).some((line) => line.startsWith('paste-buffer'))).toBe(false)
    })

    it('submits by default on the two-argument call', async () => {
        expect(await injectIntoPane(gatePane, 'legacy call')).toBe(true)
        expect((await tmuxArgv()).some((line) => line.startsWith('send-keys'))).toBe(true)
    })

    it('honours an explicit submit:false without consulting the gate', async () => {
        expect(await injectIntoPane(gatePane, 'draft me', { submit: false })).toBe(true)
        const argv = await tmuxArgv()
        expect(argv.some((line) => line.startsWith('paste-buffer'))).toBe(true)
        expect(argv.some((line) => line.startsWith('send-keys'))).toBe(false)
    })

    /**
     * DROVE-13: Stop on the phone must cancel the turn the way a person at the
     * keyboard does — one Escape — and leave the TUI standing. These assert on
     * the exact keystroke, because the failure mode this replaces (SIGTERM the
     * child) also "looks like" a stopped turn from the outside.
     */
    describe('interruptPane cancels the turn without killing the TUI', () => {
        it('sends exactly one Escape while a turn is running', async () => {
            await setRegistryStatus('busy')

            expect(await interruptPane(gate())).toBe('cancelled')

            const argv = await tmuxArgv()
            const keys = argv.filter((line) => line.startsWith('send-keys'))
            expect(keys).toEqual([`send-keys -t ${gatePane} Escape`])
            // Nothing is typed INTO the conversation: this is a cancel, not a message.
            expect(argv.some((line) => line.startsWith('paste-buffer'))).toBe(false)
        })

        it('sends NOTHING when Claude is idle, because Escape there eats a half-typed line', async () => {
            await setRegistryStatus('idle')

            expect(await interruptPane(gate())).toBe('idle')
            expect((await tmuxArgv()).some((line) => line.startsWith('send-keys'))).toBe(false)
        })

        it('still cancels when the registry has no record for the session', async () => {
            // An older Claude, or a record that aged out. Stop is only offered
            // while a turn is running, so unknown is treated as mid-turn.
            expect(await interruptPane({ ...gate(), claudeSessionId: 'never-registered' })).toBe('cancelled')
            expect((await tmuxArgv()).some((line) => line.endsWith('Escape'))).toBe(true)
        })

        it('reports unavailable, and sends nothing, when the pane is back at a shell', async () => {
            process.env.FAKE_PANE_CMD = 'zsh'

            expect(await interruptPane(gate())).toBe('unavailable')
            expect((await tmuxArgv()).some((line) => line.startsWith('send-keys'))).toBe(false)
        })
    })
})
