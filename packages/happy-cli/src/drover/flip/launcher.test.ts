/**
 * The flip through the REAL launcher loop (BASED-98).
 *
 * flip.test.ts proves the decisions — does this text mean a limit, which
 * account has headroom, what does the arrival prompt resolve to. None of it
 * touches `claudeLocalLauncher`, and the launcher is where the flip has
 * actually broken twice:
 *
 *   1. an interactive child killed mid-turn comes back through the CATCH
 *      branch as an ExitCodeError, not the tidy success path, so a flip
 *      checked only after a clean return was swallowed and the session ended;
 *   2. the AbortController stays aborted once aborted, so reusing it kills the
 *      replacement child the instant it spawns.
 *
 * Both are loop mechanics, invisible to a unit test of the pure functions and
 * expensive to reproduce live (a real limit arrives when it arrives). So this
 * drives the real loop with a scripted child.
 *
 * What is faked: the `claude` child process and the Happy client. What is
 * real: the launcher, the FlipController, the account registry, the cooldown
 * ledger on disk, and the transcript copy.
 */

import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let root: string

/** Each spawn of the fake child, in order, with what it was told. */
interface Spawn {
    configDir: string | undefined
    account: string | undefined
    sessionId: string | null
    initialPrompt: string | undefined
}
let spawns: Spawn[] = []
/** How the NEXT child ends: 'abort' waits for the abort signal, 'exit' returns. */
let childScript: ('abort' | 'exit')[] = []

vi.mock('@/claude/claudeLocal', () => {
    class ExitCodeError extends Error {
        constructor(public exitCode: number) {
            super(`exit ${exitCode}`)
        }
    }
    return {
        ExitCodeError,
        claudeLocal: vi.fn(async (opts: any) => {
            spawns.push({
                configDir: opts.claudeEnvVars?.CLAUDE_CONFIG_DIR,
                account: opts.claudeEnvVars?.DROVER_ACCOUNT,
                sessionId: opts.sessionId,
                initialPrompt: opts.initialPrompt,
            })
            const mode = childScript.shift() ?? 'exit'
            if (mode === 'exit') return
            // An interactive TUI killed mid-turn: the abort lands and claude
            // dies with a non-zero code. This is the path that swallowed the
            // first live flip.
            await new Promise<void>((resolve) => {
                if (opts.abort.aborted) return resolve()
                opts.abort.addEventListener('abort', () => resolve(), { once: true })
            })
            throw new ExitCodeError(143)
        }),
    }
})

vi.mock('@/claude/utils/sessionScanner', () => ({
    createSessionScanner: vi.fn(async () => ({
        onNewSession: vi.fn(),
        cleanup: vi.fn(async () => {}),
    })),
}))

function writeAccounts(accounts: unknown[]): void {
    writeFileSync(process.env.DROVER_ACCOUNTS!, JSON.stringify(accounts))
}

/** A transcript in `from`'s config dir, so the flip has something to carry. */
function writeTranscript(configDir: string, cwd: string, sessionId: string): void {
    const projectId = cwd.replace(/[^a-zA-Z0-9-]/g, '-')
    const dir = join(configDir, 'projects', projectId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${sessionId}.jsonl`), '{"type":"user"}\n')
}

interface Harness {
    session: any
    events: string[]
    /** A function, not a value: the launcher rewrites metadata mid-run. */
    metadata: () => Record<string, unknown>
}

function makeSession(opts: { cwd: string; sessionId: string; flip: any; account: string; configDir: string }): Harness {
    const events: string[] = []
    let metadata: Record<string, unknown> = { path: opts.cwd }
    const session: any = {
        path: opts.cwd,
        sessionId: opts.sessionId,
        flip: opts.flip,
        claudeEnvVars: { CLAUDE_CONFIG_DIR: opts.configDir, DROVER_ACCOUNT: opts.account },
        claudeArgs: [],
        pendingInitialPrompt: undefined,
        onThinkingChange: vi.fn(),
        onAbort: vi.fn(),
        onSessionFound: vi.fn(),
        addSessionFoundCallback: vi.fn(),
        removeSessionFoundCallback: vi.fn(),
        consumeOneTimeFlags: vi.fn(),
        clearSessionId: vi.fn(() => {
            session.sessionId = null
        }),
        queue: { size: () => 0, reset: vi.fn(), setOnMessage: vi.fn() },
        client: {
            rpcHandlerManager: { registerHandler: vi.fn() },
            sendSessionEvent: vi.fn(({ message }: { message: string }) => events.push(message)),
            closeClaudeSessionTurn: vi.fn(),
            updateMetadata: vi.fn((fn: (m: any) => any) => {
                metadata = fn(metadata)
            }),
            sendClaudeSessionMessageFromLocalTranscript: vi.fn(async () => {}),
        },
    }
    return { session, events, metadata: () => metadata }
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'drover-launcher-'))
    process.env.XDG_STATE_HOME = join(root, 'state')
    process.env.DROVER_ACCOUNTS = join(root, 'accounts.json')
    delete process.env.DROVER_ACCOUNT
    delete process.env.CLAUDE_CONFIG_DIR
    delete process.env.DROVER_FLIP_PROMPT
    spawns = []
    childScript = []
    vi.resetModules()
})

afterEach(() => {
    rmSync(root, { recursive: true, force: true })
})

async function build(opts: { cooldowns?: Record<string, number> } = {}) {
    const mainDir = join(root, 'main')
    const altDir = join(root, 'alt')
    const cwd = join(root, 'project')
    mkdirSync(cwd, { recursive: true })
    writeAccounts([
        { name: 'main', configDir: mainDir },
        { name: 'alt', configDir: altDir },
    ])

    const { FlipController } = await import('./controller')
    const accounts = await import('./accounts')
    if (opts.cooldowns) {
        for (const [name, until] of Object.entries(opts.cooldowns)) {
            accounts.setCooldown(name, until, 'test')
        }
    }

    const said: string[] = []
    const flip = new FlipController(cwd, (m: string) => said.push(m))
    // Same seeding runClaude does: say where the session started rather than
    // letting the controller read an environment that goes stale on flip 1.
    flip.startedOn('main')
    const harness = makeSession({ cwd, sessionId: 'sess-1', flip, account: 'main', configDir: mainDir })
    writeTranscript(mainDir, cwd, 'sess-1')

    const { claudeLocalLauncher } = await import('@/claude/claudeLocalLauncher')
    return { ...harness, flip, said, cwd, mainDir, altDir, claudeLocalLauncher, accounts }
}

describe('a flip through the launcher loop', () => {
    it('stops the child, moves account, and relaunches --resume with the SAME session id', async () => {
        const h = await build()
        // First child waits to be aborted; the replacement exits cleanly.
        childScript = ['abort', 'exit']

        const run = h.claudeLocalLauncher(h.session)
        // Let the first child get as far as waiting on the abort signal.
        await new Promise((r) => setTimeout(r, 20))
        h.flip.request({ account: 'alt', reason: 'manual', by: 'test' })
        const result = await run

        expect(spawns).toHaveLength(2)
        expect(spawns[0].account).toBe('main')
        expect(spawns[1].account).toBe('alt')
        expect(spawns[1].configDir).toBe(h.altDir)
        // The whole point: the id the app is watching does not change.
        expect(spawns[1].sessionId).toBe('sess-1')
        expect(spawns[1].initialPrompt).toContain('Pick up where we left off')
        expect(result).toEqual({ type: 'exit', code: 0 })
    })

    it('carries the transcript into the target account before resuming there', async () => {
        const h = await build()
        childScript = ['abort', 'exit']
        const projectId = h.cwd.replace(/[^a-zA-Z0-9-]/g, '-')
        const landing = join(h.altDir, 'projects', projectId, 'sess-1.jsonl')
        expect(existsSync(landing)).toBe(false)

        const run = h.claudeLocalLauncher(h.session)
        await new Promise((r) => setTimeout(r, 20))
        h.flip.request({ account: 'alt', reason: 'manual', by: 'test' })
        await run

        expect(existsSync(landing)).toBe(true)
        expect(readFileSync(landing, 'utf8')).toContain('"type":"user"')
    })

    it('re-arms the abort controller, so the replacement child is not killed on spawn', async () => {
        const h = await build()
        // BOTH children wait on abort. If the controller were reused, the
        // second would see an already-aborted signal and die immediately
        // without ever waiting — and the loop would spin.
        childScript = ['abort', 'abort']

        const run = h.claudeLocalLauncher(h.session)
        await new Promise((r) => setTimeout(r, 20))
        h.flip.request({ account: 'alt', reason: 'manual', by: 'test' })
        await new Promise((r) => setTimeout(r, 40))
        // The replacement is alive and waiting: exactly two spawns so far.
        expect(spawns).toHaveLength(2)
        // Aborting again ends it, proving the second child owned a LIVE signal.
        h.session.flip.setAbortHandler(h.session.flip['abortChild'])
        h.flip.request({ account: 'main', reason: 'back', by: 'test' })
        await new Promise((r) => setTimeout(r, 40))
        expect(spawns.length).toBeGreaterThanOrEqual(3)
        h.flip.stop()
    })

    it('announces a refused flip and keeps the session alive rather than exiting', async () => {
        const h = await build()
        childScript = ['abort', 'exit']

        const run = h.claudeLocalLauncher(h.session)
        await new Promise((r) => setTimeout(r, 20))
        h.flip.request({ account: 'nosuch', reason: 'manual', by: 'test' })
        const result = await run

        expect(h.events.join('\n')).toContain('no account named "nosuch"')
        // Relaunched on the SAME account, not exited.
        expect(spawns).toHaveLength(2)
        expect(spawns[1].account).toBe('main')
        expect(result).toEqual({ type: 'exit', code: 0 })
    })

    it('flips TWICE in one session — the second knows it is no longer on main', async () => {
        // The regression this pins: the controller used to re-read
        // DROVER_ACCOUNT from the process env, which the wrapper stamps once
        // and a flip never updates. So flip 2 believed it was still on `main`,
        // "moved" to alt while already on alt, and carried main's stale
        // transcript over the newer one.
        const h = await build()
        childScript = ['abort', 'abort', 'exit']

        const run = h.claudeLocalLauncher(h.session)
        await new Promise((r) => setTimeout(r, 20))
        h.flip.request({ account: 'alt', reason: 'first', by: 'test' })
        await new Promise((r) => setTimeout(r, 40))
        expect(spawns[1].account).toBe('alt')

        // Now flip back with no account named: "next one with headroom" must
        // resolve to main, because we are on alt.
        h.flip.request({ account: null, reason: 'second', by: 'test' })
        await run

        expect(spawns).toHaveLength(3)
        expect(spawns[2].account).toBe('main')
        expect(spawns[2].configDir).toBe(h.mainDir)
        expect(h.events.join('\n')).toContain('alt → main')
    })

    it('records an auto-flip cooldown against the account it is ACTUALLY on', async () => {
        // Same staleness, worse consequence: a limit hit after one flip used
        // to cool the account the session had already left, leaving the one
        // that actually ran out looking fresh.
        const h = await build()
        childScript = ['abort', 'abort', 'exit']

        const run = h.claudeLocalLauncher(h.session)
        await new Promise((r) => setTimeout(r, 20))
        h.flip.request({ account: 'alt', reason: 'first', by: 'test' })
        await new Promise((r) => setTimeout(r, 40))

        h.flip.noteTranscriptMessage({
            type: 'assistant',
            message: { role: 'assistant', model: '<synthetic>', content: 'Claude usage limit reached.' },
        })
        await run

        expect(h.accounts.isCooling('alt')).toBe(true)
        expect(h.accounts.isCooling('main')).toBe(false)
    })

    it('stamps the new account on the metadata the app renders', async () => {
        const h = await build()
        childScript = ['abort', 'exit']
        const run = h.claudeLocalLauncher(h.session)
        await new Promise((r) => setTimeout(r, 20))
        h.flip.request({ account: 'alt', reason: 'manual', by: 'test' })
        await run
        expect(h.metadata().droverAccount).toBe('alt')
        expect(String(h.metadata().name)).toContain('[alt]')
    })
})

describe('park and self-resume', () => {
    it('parks when every account is cooling, then resumes itself onto the first to reset', async () => {
        const now = Date.now()
        // main resets soonest; alt is out for much longer. main's window has
        // to still be OPEN when the flip is requested a moment from now, or
        // there is nothing to park for.
        const h = await build({ cooldowns: { main: now + 600, alt: now + 60_000 } })
        childScript = ['abort', 'exit']

        const run = h.claudeLocalLauncher(h.session)
        await new Promise((r) => setTimeout(r, 20))
        // No account named: this is the auto path, which must consult the ledger.
        h.flip.request({ account: null, reason: 'usage limit', by: 'auto' })
        const result = await run

        const said = h.events.join('\n')
        expect(said).toContain('every account is out of headroom')
        expect(said).toContain('Parked until')
        // It woke by ITSELF — nothing else requested a flip — and carried on
        // once main's window reopened. Before the livelock fix this never
        // returned: the park deadline was already past on wake, pickTarget
        // handed back the same expired park, and the loop spun.
        expect(said).toContain('main has headroom again')
        // Exactly two: the child that hit the wall, and the one that came back
        // after the park. A third would mean the park had left a flip queued
        // for the next conversation to trip over.
        expect(spawns).toHaveLength(2)
        expect(spawns[1].account).toBe('main')
        expect(result).toEqual({ type: 'exit', code: 0 })
    })

    it('leaves nothing queued after a park, so the session can actually exit', async () => {
        const h = await build({ cooldowns: { main: Date.now() + 400, alt: Date.now() + 60_000 } })
        childScript = ['abort', 'exit']
        const run = h.claudeLocalLauncher(h.session)
        await new Promise((r) => setTimeout(r, 20))
        h.flip.request({ account: null, reason: 'usage limit', by: 'auto' })
        await run
        expect(h.flip.take()).toBeNull()
    })

    it('does not park when one account still has headroom', async () => {
        const h = await build({ cooldowns: { main: Date.now() + 60_000 } })
        childScript = ['abort', 'exit']
        const run = h.claudeLocalLauncher(h.session)
        await new Promise((r) => setTimeout(r, 20))
        h.flip.request({ account: null, reason: 'usage limit', by: 'auto' })
        await run
        expect(h.events.join('\n')).not.toContain('Parked until')
        expect(spawns[1].account).toBe('alt')
    })
})

describe('the auto-flip trigger', () => {
    it('a synthetic limit message in the transcript flips and records the cooldown', async () => {
        process.env.DROVER_ACCOUNT = 'main'
        const h = await build()
        childScript = ['abort', 'exit']

        const run = h.claudeLocalLauncher(h.session)
        await new Promise((r) => setTimeout(r, 20))
        // Exactly what Claude Code writes when the plan window closes.
        h.flip.noteTranscriptMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                model: '<synthetic>',
                content: "Claude usage limit reached. Resets at 3pm.",
            },
        })
        await run

        expect(spawns[1].account).toBe('alt')
        expect(h.accounts.isCooling('main')).toBe(true)
        expect(h.accounts.readLedger()['main'].reason).toContain('usage limit reached')
    })

    it('Claude merely TALKING about a usage limit does not move the session', async () => {
        process.env.DROVER_ACCOUNT = 'main'
        const h = await build()
        childScript = ['exit']

        await h.claudeLocalLauncher(h.session)
        h.flip.noteTranscriptMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                model: 'claude-opus-4',
                content: 'The usage limit reached branch is the one to test here.',
            },
        })
        expect(h.flip.take()).toBeNull()
        expect(h.accounts.isCooling('main')).toBe(false)
    })
})
