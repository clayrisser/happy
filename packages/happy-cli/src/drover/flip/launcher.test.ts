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
        setClaudeConfigDir: vi.fn(),
        cleanup: vi.fn(async () => {}),
    })),
}))

/**
 * Write the registry AND log every account in.
 *
 * An account with no credential is not a flip candidate at all — flipping
 * there lands in Claude Code's first-run wizard — so a fixture that writes
 * only accounts.json describes a machine with nowhere to flip to, and every
 * test here answers "no other LOGGED-IN account".
 */
function writeAccounts(accounts: { name: string; configDir: string }[]): void {
    writeFileSync(process.env.DROVER_ACCOUNTS!, JSON.stringify(accounts))
    for (const a of accounts) {
        mkdirSync(a.configDir, { recursive: true })
        writeFileSync(
            join(a.configDir, '.claude.json'),
            JSON.stringify({ oauthAccount: { emailAddress: `${a.name}@example.com` } }),
        )
    }
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
            // A real client is an EventEmitter that also hands out the
            // session's metadata; the pane launcher reads both to route a
            // model or effort pick made on the phone (DROVE-45).
            getMetadata: () => metadata,
            on: vi.fn(),
            off: vi.fn(),
        },
    }
    return { session, events, metadata: () => metadata }
}

beforeEach(() => {
    // Point every bus call at a dead port. These tests never had a bus, but
    // DROVER_URL defaulted to 127.0.0.1:7970 — so on a machine where the real
    // drover bus is running they were quietly talking to it, and once a flip
    // started asking it who is live (DROVE-37) that turned into real HTTP
    // inside a 5s test. Connection refused is instant and is what "no bus"
    // should have meant all along.
    process.env.DROVER_URL = 'http://127.0.0.1:1'
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

async function build(
    opts: {
        cooldowns?: Record<string, number>
        /** Cooldowns scoped to one model family, as a real limit notice records them. */
        familyCooldowns?: Record<string, { until: number; family: string }>
        /** Milliseconds between "still parked" notes; tiny so a test can watch one. */
        parkAnnounceMs?: number
    } = {},
) {
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
    if (opts.familyCooldowns) {
        for (const [name, c] of Object.entries(opts.familyCooldowns)) {
            accounts.setCooldown(name, c.until, `${c.family} limit`, c.family)
        }
    }

    const said: string[] = []
    // The TERMINAL half, captured rather than written to the real stderr. In
    // production this is a stderr write, and it is the surface a park was
    // never reaching — `announce` above is the phone and only the phone.
    const terminal: string[] = []
    const flip = new FlipController(cwd, (m: string) => said.push(m), {
        toTerminal: (m: string) => terminal.push(m),
        ...(opts.parkAnnounceMs === undefined ? {} : { parkAnnounceMs: opts.parkAnnounceMs }),
    })
    // Same seeding runClaude does: say where the session started rather than
    // letting the controller read an environment that goes stale on flip 1.
    flip.startedOn('main')
    const harness = makeSession({ cwd, sessionId: 'sess-1', flip, account: 'main', configDir: mainDir })
    writeTranscript(mainDir, cwd, 'sess-1')

    const { claudeLocalLauncher } = await import('@/claude/claudeLocalLauncher')
    return { ...harness, flip, said, terminal, cwd, mainDir, altDir, claudeLocalLauncher, accounts }
}

/**
 * Wait for a line the park writes, instead of reading the buffer once.
 *
 * A park announces on a TIMER — once as it starts, then again every
 * parkAnnounceMs — so a test that samples h.terminal at one instant is racing
 * the output it is asserting on. Under load two of these read the buffer
 * before the park had said anything and failed quoting the PREVIOUS sentence
 * back (DROVE-60). This polls instead, and when the line never comes it fails
 * with the whole buffer rather than with a mismatch on half of one.
 */
async function waitForLine(surface: string[], needle: string, atLeast = 1): Promise<string[]> {
    return await vi.waitFor(
        () => {
            const hits = surface.filter((m) => m.includes(needle))
            if (hits.length < atLeast) {
                throw new Error(
                    `waited for ${atLeast} line(s) containing "${needle}", saw ${hits.length}. ` +
                        `Said so far:\n${surface.join('\n') || '(nothing)'}`,
                )
            }
            return hits
        },
        // Under vitest's own 5 s testTimeout on purpose: a waitFor that
        // outlasts the test is reported as "Test timed out" and the buffer
        // above is never printed, which is the unhelpful half of loud.
        { timeout: 2_000, interval: 10 },
    )
}

/**
 * Wait for the fake child to be up and holding the abort signal, rather than
 * sleeping 20 ms and hoping. claudeLocal records the spawn and registers its
 * abort listener in the same tick, so a spawn on the list is a child that can
 * be stopped.
 */
async function waitForSpawns(n: number): Promise<void> {
    await vi.waitFor(() => expect(spawns.length).toBeGreaterThanOrEqual(n), { timeout: 2_000, interval: 5 })
}

/**
 * End a park the way life does: the soonest account's window reopens and the
 * loop notices. Tests that watch a park in progress hold it open for a minute
 * so nothing they assert on is racing a stopwatch, and this is how they let go
 * — the alternative is a short real cooldown, which is the flake (DROVE-60).
 */
async function endPark(h: { accounts: any; flip: any }, run: Promise<unknown>): Promise<void> {
    h.accounts.clearCooldown('main')
    h.flip.request({ account: null, reason: 'cooldown expired', by: 'auto' })
    await run
}

/** Tell the controller which model this session is running, the way it learns. */
function ranModel(flip: any, model: string): void {
    flip.noteTranscriptMessage({
        type: 'assistant',
        message: { role: 'assistant', model, content: [{ type: 'text', text: 'ok' }] },
    })
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

    it('refuses a flip on a session that never spoke WITHOUT resuming a transcript that is not there', async () => {
        // BASED-98, reported live. Open a fresh drover, type nothing, press
        // flip. The refusal is correct — Clay picked the account he was
        // already on — but the child has already been aborted to make room for
        // a flip that then does not happen, so the refusal still costs a
        // relaunch, and the relaunch carried --resume <id> for an id that
        // never got a transcript. Claude Code exits on the spot with
        //   No conversation found with session ID: e6bb612b-…
        // and the brand-new session is dead.
        //
        // Measured at 22:29:05 in 2026-08-29-22-27-43-pid-16999.log: refused
        // "already on main", relaunched --resume e6bb612b, gone.
        const h = await build()
        // The difference from every other test here: NO transcript on disk.
        rmSync(join(h.mainDir, 'projects'), { recursive: true, force: true })
        childScript = ['abort', 'exit']

        const run = h.claudeLocalLauncher(h.session)
        await new Promise((r) => setTimeout(r, 20))
        // Already on main, so this is refused.
        h.flip.request({ account: 'main', reason: 'manual', by: 'tmux' })
        const result = await run

        expect(h.events.join('\n')).toContain('already on main')
        // Still relaunched — a refusal must not end the session...
        expect(spawns).toHaveLength(2)
        expect(spawns[1].account).toBe('main')
        // ...but as a CLEAN start, because there is nothing to resume.
        expect(spawns[1].sessionId).toBeNull()
        expect(result).toEqual({ type: 'exit', code: 0 })
    })

    it('refuses a flip on a session that HAS spoken and still resumes it', async () => {
        // The other half of the guard: the fix must not throw away a real
        // conversation. Same refusal, transcript present, id kept.
        const h = await build()
        childScript = ['abort', 'exit']

        const run = h.claudeLocalLauncher(h.session)
        await new Promise((r) => setTimeout(r, 20))
        h.flip.request({ account: 'main', reason: 'manual', by: 'tmux' })
        await run

        expect(spawns).toHaveLength(2)
        expect(spawns[1].sessionId).toBe('sess-1')
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

    it('hands the abort handler back when it exits, leaving no dead closure behind', async () => {
        // BASED-127. The handler closes over THIS launcher's
        // AbortController, which is aborted by the time the launcher returns.
        // Left registered, it was what FlipController.request() called for the
        // whole of the next remote turn: it ran, stopped nothing, reported
        // nothing, and the flip queued until the session came back to local
        // mode and its next child exited. From the phone that is a button that
        // does nothing.
        const h = await build()
        childScript = ['exit']
        await h.claudeLocalLauncher(h.session)
        expect(h.session.flip['abortChild']).toBeNull()
        // The in-flight probe was already cleared this way; the pair now
        // matches, and both belong to the launcher that registered them.
        expect(h.session.flip['inFlight']).toBeNull()
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

    it('keeps the name Claude Code gave the session instead of stamping the account over it', async () => {
        // DROVE-44, reported from the phone: Clay flipped a session he had
        // named DROVER and the app called it "[jamrizzi] cattle-drover".
        //
        // The flip is not the half that was wrong. It restamps only a
        // default-shaped name, and the name WAS default-shaped by the time it
        // looked, because the run had come up through `drover --resume` and
        // the scanner pre-marked the transcript's custom-title record along
        // with the messages instead of applying it. So this drives the seam
        // rather than either side of it, with the REAL scanner — the rest of
        // this file mocks it — and the assertion is the title on the screen
        // Clay was looking at.
        const h = await build()
        const sessionId = 'sess-1'
        const transcript = join(h.mainDir, 'projects', h.cwd.replace(/[^a-zA-Z0-9-]/g, '-'), `${sessionId}.jsonl`)
        writeFileSync(transcript, JSON.stringify({ type: 'custom-title', customTitle: 'DROVER', sessionId }) + '\n')

        const { createSessionScanner } = await vi.importActual<typeof import('@/claude/utils/sessionScanner')>(
            '@/claude/utils/sessionScanner',
        )
        const { applyCustomTitle } = await import('@/claude/session')
        const scanner = await createSessionScanner({
            sessionId: null,
            workingDirectory: h.cwd,
            claudeConfigDir: h.mainDir,
            onMessage: () => {},
            onCustomTitle: (t: string) => applyCustomTitle(h.session, t),
        })
        // The first SessionStart hook of a resumed run: what is on disk is
        // history, so it is pre-marked. The title is not history.
        await scanner.onNewSession(sessionId, { treatExistingAsProcessed: true })
        await new Promise((r) => setTimeout(r, 200))
        expect(h.metadata().name).toBe('DROVER')

        childScript = ['abort', 'exit']
        const run = h.claudeLocalLauncher(h.session)
        await new Promise((r) => setTimeout(r, 20))
        h.flip.request({ account: 'alt', reason: 'manual', by: 'test' })
        await run
        await scanner.cleanup()

        // The account moved. The name did not, on either of the two fields —
        // `summary` is the one the phone's session list actually renders.
        expect(h.metadata().droverAccount).toBe('alt')
        expect(h.metadata().name).toBe('DROVER')
        expect((h.metadata().summary as { text: string }).text).toBe('DROVER')
    })
})

describe('park and self-resume', () => {
    it('parks when every account is cooling, then resumes itself onto the first to reset', async () => {
        // alt is out for much longer than main, so main is the one the park
        // is waiting on. main's own window is set below, at the moment the
        // flip is requested, rather than here.
        const h = await build({ cooldowns: { alt: Date.now() + 60_000 } })
        childScript = ['abort', 'exit']

        const run = h.claudeLocalLauncher(h.session)
        await waitForSpawns(1)
        // main's window has to still be OPEN when the flip lands or there is
        // nothing to park for, and anchoring it to a clock started before
        // build() meant everything build() cost came straight out of it —
        // two dynamic imports among that. Measured 2026-08-30 on an idle box:
        // 345-548 ms left of a 400-600 ms window by the time the park began,
        // and under load it reached zero, so there was no park to assert on
        // (DROVE-60). Set here, the same measurement reads 595 of 600.
        h.accounts.setCooldown('main', Date.now() + 600, 'usage limit')
        // No account named: this is the auto path, which must consult the ledger.
        h.flip.request({ account: null, reason: 'usage limit', by: 'auto' })
        // And prove the park actually started before waiting on it to end, so
        // an outrun window fails saying so rather than three assertions later.
        await waitForLine(h.events, 'parked — no account has headroom')
        const result = await run

        const said = h.events.join('\n')
        expect(said).toContain('no account has headroom')
        expect(said).toContain('Resuming on main by itself at')
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
        const h = await build({ cooldowns: { alt: Date.now() + 60_000 } })
        childScript = ['abort', 'exit']
        const run = h.claudeLocalLauncher(h.session)
        await waitForSpawns(1)
        h.accounts.setCooldown('main', Date.now() + 600, 'usage limit')
        h.flip.request({ account: null, reason: 'usage limit', by: 'auto' })
        // Without this the assertion below passes on a session that never
        // parked at all, which is exactly what an outrun window looks like.
        await waitForLine(h.events, 'parked — no account has headroom')
        await run
        expect(h.flip.take()).toBeNull()
    })

    it('does not park when one account still has headroom', async () => {
        const h = await build({ cooldowns: { main: Date.now() + 60_000 } })
        childScript = ['abort', 'exit']
        const run = h.claudeLocalLauncher(h.session)
        await waitForSpawns(1)
        h.flip.request({ account: null, reason: 'usage limit', by: 'auto' })
        await run
        expect(h.events.join('\n')).not.toContain('parked')
        expect(spawns[1].account).toBe('alt')
    })

    // The wedge, in one test. Clay parked for 17,630 seconds with no claude
    // child running and saw NOTHING: every note went to session.sendSessionEvent,
    // which is an encrypted envelope to the Happy server. He was at a keyboard.
    it('says it is parked on the TERMINAL, not only the phone', async () => {
        // Both accounts are out for a LONG time, so the park is certain
        // whatever the fixture cost to build, and it ends when the ledger says
        // main is back rather than when a stopwatch started before the test
        // did runs out (DROVE-60).
        const h = await build({ cooldowns: { main: Date.now() + 60_000, alt: Date.now() + 120_000 } })
        childScript = ['abort', 'exit']
        const run = h.claudeLocalLauncher(h.session)
        await waitForSpawns(1)
        h.flip.request({ account: null, reason: 'usage limit', by: 'auto' })

        // The wait IS the assertion: the park has to reach the terminal.
        const printed = (await waitForLine(h.terminal, 'parked')).join('\n')
        // Which accounts, until when, and the two commands that override it.
        expect(printed).toContain('main')
        expect(printed).toContain('alt')
        expect(printed).toContain('Resuming on main by itself at')
        expect(printed).toContain('drover flip <account>')
        expect(printed).toContain('drover --account <name> --resume')

        await endPark(h, run)
    })

    // prefix+F during a park posted a flip frame, released the park, found
    // nothing with headroom, and re-parked — reprinting the identical sentence
    // Clay was already looking at. That silence is what read as "the key does
    // nothing", and it is the bug, not the parking.
    it('answers a MANUAL flip that lands in a park instead of silently re-parking', async () => {
        const h = await build({ cooldowns: { main: Date.now() + 60_000, alt: Date.now() + 120_000 } })
        childScript = ['abort', 'exit']

        const run = h.claudeLocalLauncher(h.session)
        await waitForSpawns(1)
        h.flip.request({ account: null, reason: 'usage limit', by: 'auto' })
        // Wait for the park to be up before pressing the key into it, rather
        // than sleeping 40 ms and hoping it got there (DROVE-60).
        await waitForLine(h.terminal, 'parked — no account has headroom')
        // What prefix+F posts: a flip frame naming no account.
        h.flip.request({ account: null, reason: 'requested', by: 'tmux' })

        const answer = await waitForLine(h.terminal, 'flip requested by tmux, but no account has headroom')
        // And it says when the soonest one is back rather than going quiet.
        expect(answer.join('\n')).toContain('Resuming on main by itself at')

        await endPark(h, run)
    })

    it('re-announces during a long park, so it cannot be mistaken for a hang', async () => {
        // A LONG park, the way the real one was — four hours fifty — with the
        // beat dialled right down so the test can watch several go by. The old
        // fixture parked for 400 ms and hoped one beat fitted inside it, so
        // setup time came straight out of the window and a loaded box saw none
        // at all (DROVE-60).
        const h = await build({
            cooldowns: { main: Date.now() + 60_000, alt: Date.now() + 120_000 },
            parkAnnounceMs: 20,
        })
        childScript = ['abort', 'exit']
        const run = h.claudeLocalLauncher(h.session)
        await waitForSpawns(1)
        h.flip.request({ account: null, reason: 'usage limit', by: 'auto' })

        // Two, not one: the point is that it says it AGAIN, and one beat does
        // not prove that. Waiting is the only honest read of output that
        // arrives on a timer.
        const beats = await waitForLine(h.terminal, 'still parked —', 2)
        expect(beats[0]).toContain('drover flip <account>')

        await endPark(h, run)
    })
})

describe('flipping to an account that has the MODEL', () => {
    it('prefers an account with headroom for the model in use', async () => {
        const now = Date.now()
        // alt is out of Fable and nothing else; main is out entirely. A
        // Fable session must not be sent to alt just because alt has Opus.
        const h = await build({
            cooldowns: { third: now + 60_000 },
            familyCooldowns: { alt: { until: now + 60_000, family: 'fable' } },
        })
        // A third account with room, added after build so the registry order
        // still puts alt first — position must lose to model headroom.
        writeFileSync(
            process.env.DROVER_ACCOUNTS!,
            JSON.stringify([
                { name: 'main', configDir: h.mainDir },
                { name: 'alt', configDir: h.altDir },
                { name: 'third', configDir: join(root, 'third') },
            ]),
        )
        mkdirSync(join(root, 'third'), { recursive: true })
        writeFileSync(
            join(root, 'third', '.claude.json'),
            JSON.stringify({ oauthAccount: { emailAddress: 'third@example.com' } }),
        )
        h.accounts.clearCooldown('third')

        childScript = ['abort', 'exit']
        const run = h.claudeLocalLauncher(h.session)
        await new Promise((r) => setTimeout(r, 20))
        ranModel(h.flip, 'claude-fable-5[1m]')
        h.flip.request({ account: null, reason: 'usage limit', by: 'auto' })
        await run

        expect(spawns[1].account).toBe('third')
    })

    it('an Opus session is not blocked by a Fable-only limit', async () => {
        const now = Date.now()
        const h = await build({ familyCooldowns: { alt: { until: now + 60_000, family: 'fable' } } })
        childScript = ['abort', 'exit']
        const run = h.claudeLocalLauncher(h.session)
        await new Promise((r) => setTimeout(r, 20))
        ranModel(h.flip, 'claude-opus-5')
        h.flip.request({ account: null, reason: 'usage limit', by: 'auto' })
        await run

        // Before this, "alt is cooling" meant cooling for everything and the
        // session parked for five hours next to an account that ran Opus fine.
        expect(spawns[1].account).toBe('alt')
        expect(h.events.join('\n')).not.toContain('parked')
    })

    it('takes an account with headroom for SOME model, and says which one to switch to', async () => {
        const now = Date.now()
        // main out ENTIRELY, alt out of Fable only. The move has to be worth
        // making: this fixture used to leave main with Fable headroom, so the
        // session was sent to the one account that had none — and from there
        // the same rule sent it straight back, which is the ping-pong.
        const h = await build({
            cooldowns: { main: now + 60_000 },
            familyCooldowns: { alt: { until: now + 60_000, family: 'fable' } },
        })
        childScript = ['abort', 'exit']
        const run = h.claudeLocalLauncher(h.session)
        await new Promise((r) => setTimeout(r, 20))
        ranModel(h.flip, 'claude-fable-5')
        h.flip.request({ account: null, reason: 'usage limit', by: 'auto' })
        await run

        // alt has no Fable left, but it is a live session rather than a
        // five-hour park — as long as the note says so.
        expect(spawns[1].account).toBe('alt')
        const said = h.events.join('\n')
        expect(said).toContain('Nothing has Fable headroom')
        expect(said).toContain('/model')
    })

    it('records an auto-flip cooldown against the MODEL the notice named', async () => {
        process.env.DROVER_ACCOUNT = 'main'
        const h = await build()
        childScript = ['abort', 'exit']
        const run = h.claudeLocalLauncher(h.session)
        await new Promise((r) => setTimeout(r, 20))
        ranModel(h.flip, 'claude-fable-5')
        h.flip.noteTranscriptMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                model: '<synthetic>',
                content: "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.",
            },
        })
        await run

        // The wrong record is the one measured on 2026-08-29: three accounts
        // blacked out for the full five hours over a Fable-only limit.
        expect(h.accounts.readLedger()['main'].family).toBe('fable')
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
