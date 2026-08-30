/**
 * The flip through the REMOTE launcher loop (BASED-127).
 *
 * launcher.test.ts drives the same flip through claudeLocalLauncher, and until
 * now that was the only launcher that could carry one out at all. The
 * INTERCEPTION was moved up to runClaude so both modes hear a `/flip`, and an
 * acceptance criterion was ticked on the strength of it — but the EXECUTION
 * was still local-only: applyPendingFlip was called after a spawned child
 * exited, and remote mode has no spawned child. A flip requested from the
 * phone while the session was in remote mode was accepted, logged, and then
 * sat pending until the session came back to local and its next child died.
 *
 * So this drives the real remote loop with a scripted engine. What is faked:
 * the SDK `query()` loop (claudeRemote) and the Happy client. What is real:
 * claudeRemoteLauncher, the FlipController, the InFlightTracker, the account
 * registry, the cooldown ledger on disk, the message queue, and the transcript
 * copy.
 */

import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let root: string

/** Each start of the fake engine, in order, with what it was told. */
interface Engine {
    configDir: string | undefined
    account: string | undefined
    sessionId: string | null
}
let engines: Engine[] = []
/** Everything the engine was asked to say, in order. */
let prompts: string[] = []
/** The live engine's options, so a test can push a message through onMessage. */
let live: any = null

vi.mock('@/claude/claudeRemote', () => ({
    claudeRemote: vi.fn(async (opts: any) => {
        live = opts
        // Same order as the real one: claudeEnvVars are written into
        // process.env before anything else, which is how a flip reaches the
        // SDK at all — there is no spawn to merge them into.
        if (opts.claudeEnvVars) {
            for (const [k, v] of Object.entries(opts.claudeEnvVars)) {
                process.env[k] = v as string
            }
        }
        engines.push({
            configDir: opts.claudeEnvVars?.CLAUDE_CONFIG_DIR,
            account: opts.claudeEnvVars?.DROVER_ACCOUNT,
            sessionId: opts.sessionId,
        })
        const first = await opts.nextMessage()
        if (first) prompts.push(String(first.message))
        // A turn stays alive until something stops it. That "something" is the
        // whole point here: a flip has to be able to be that something.
        await new Promise<void>((resolve) => {
            if (opts.signal.aborted) return resolve()
            opts.signal.addEventListener('abort', () => resolve(), { once: true })
        })
    }),
}))

/** Write the registry AND log every account in — see launcher.test.ts. */
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

/**
 * A launch as REMOTE mode sees it.
 *
 * Deliberately not the transcript record inflight.test.ts uses: an SDK user
 * message carries no `toolUseResult`, so the tracker has only the banner text
 * to go on. If that path ever stops working the gate silently opens.
 */
function sdkLaunchMessage(id: string) {
    // Ids are the real 17-character shape on purpose: the tracker's pattern
    // wants at least four characters, so a made-up "a1" is silently not an
    // agent at all and every gate test passes for the wrong reason.
    return {
        type: 'user',
        parent_tool_use_id: null,
        session_id: 'sess-1',
        message: {
            role: 'user',
            content: [
                {
                    tool_use_id: `toolu_${id}`,
                    type: 'tool_result',
                    content:
                        'Async agent launched successfully.\n' +
                        `agentId: ${id} (internal ID - do not mention to user.)\n` +
                        `output_file: /tmp/tasks/${id}.output\n`,
                },
            ],
        },
    }
}

interface Harness {
    session: any
    events: string[]
    handlers: Record<string, (...args: any[]) => any>
    metadata: () => Record<string, unknown>
}

function makeSession(opts: {
    cwd: string
    sessionId: string
    flip: any
    account: string
    configDir: string
    queue: any
}): Harness {
    const events: string[] = []
    const handlers: Record<string, (...args: any[]) => any> = {}
    let metadata: Record<string, unknown> = { path: opts.cwd }
    const session: any = {
        path: opts.cwd,
        sessionId: opts.sessionId,
        logPath: join(opts.cwd, 'log.txt'),
        flip: opts.flip,
        claudeEnvVars: { CLAUDE_CONFIG_DIR: opts.configDir, DROVER_ACCOUNT: opts.account },
        claudeArgs: [],
        mcpServers: {},
        allowedTools: [],
        hookSettingsPath: join(opts.cwd, 'hooks.json'),
        jsRuntime: 'node',
        queue: opts.queue,
        onThinkingChange: vi.fn(),
        onAbort: vi.fn(),
        onSessionFound: vi.fn(),
        consumeOneTimeFlags: vi.fn(),
        clearSessionId: vi.fn(() => {
            session.sessionId = null
        }),
        api: {
            push: () => ({ sendSessionNotification: vi.fn() }),
        },
        client: {
            sessionId: 'happy-1',
            rpcHandlerManager: {
                registerHandler: vi.fn((name: string, fn: (...args: any[]) => any) => {
                    handlers[name] = fn
                }),
            },
            sendSessionEvent: vi.fn(({ message }: { message: string }) => events.push(message)),
            closeClaudeSessionTurn: vi.fn(),
            sendClaudeSessionMessage: vi.fn(),
            getMetadata: () => metadata,
            updateAgentState: vi.fn(),
            updateMetadata: vi.fn((fn: (m: any) => any) => {
                metadata = fn(metadata)
            }),
        },
    }
    return { session, events, handlers, metadata: () => metadata }
}

beforeEach(() => {
    // Point every bus call at a dead port. These tests never had a bus, but
    // DROVER_URL defaulted to 127.0.0.1:7970 — so on a machine where the real
    // drover bus is running they were quietly talking to it, and once a flip
    // started asking it who is live (DROVE-37) that turned into real HTTP
    // inside a 5s test. Connection refused is instant and is what "no bus"
    // should have meant all along.
    process.env.DROVER_URL = 'http://127.0.0.1:1'
    root = mkdtempSync(join(tmpdir(), 'drover-remote-'))
    process.env.XDG_STATE_HOME = join(root, 'state')
    process.env.DROVER_ACCOUNTS = join(root, 'accounts.json')
    delete process.env.DROVER_ACCOUNT
    delete process.env.CLAUDE_CONFIG_DIR
    delete process.env.DROVER_FLIP_PROMPT
    engines = []
    prompts = []
    live = null
    vi.resetModules()
})

afterEach(() => {
    rmSync(root, { recursive: true, force: true })
})

async function build(opts: { flipConfirmMs?: number } = {}) {
    const mainDir = join(root, 'main')
    const altDir = join(root, 'alt')
    const cwd = join(root, 'project')
    mkdirSync(cwd, { recursive: true })
    writeAccounts([
        { name: 'main', configDir: mainDir },
        { name: 'alt', configDir: altDir },
    ])

    const { FlipController } = await import('./controller')
    const { MessageQueue2 } = await import('@/utils/MessageQueue2')
    const said: string[] = []
    const terminal: string[] = []
    const flip = new FlipController(cwd, (m: string) => said.push(m), {
        toTerminal: (m: string) => terminal.push(m),
        ...(opts.flipConfirmMs === undefined ? {} : { flipConfirmMs: opts.flipConfirmMs }),
    })
    flip.startedOn('main')
    const queue = new MessageQueue2<any>(() => 'mode-hash')
    const harness = makeSession({ cwd, sessionId: 'sess-1', flip, account: 'main', configDir: mainDir, queue })
    writeTranscript(mainDir, cwd, 'sess-1')

    const { claudeRemoteLauncher } = await import('@/claude/claudeRemoteLauncher')
    // The module itself is the registry: the cooldown ledger is on disk under
    // the env this harness already points at a temp root.
    const accounts = await import('./accounts')
    return { ...harness, flip, said, terminal, cwd, mainDir, altDir, queue, claudeRemoteLauncher, accounts }
}

/** Let the loop get as far as an engine waiting for something to say. */
const settle = () => new Promise((r) => setTimeout(r, 20))

describe('a flip requested while the session is in REMOTE mode', () => {
    it('moves the account and starts the next engine there, with the same session id', async () => {
        const h = await build()
        const run = h.claudeRemoteLauncher(h.session)
        await settle()
        expect(engines).toHaveLength(1)

        h.flip.request({ account: 'alt', reason: 'manual', by: 'app' })
        await settle()

        // The defect this ticket is about: before the fix `request()` set
        // `pending`, found no abort handler, and nothing else ever happened.
        expect(engines).toHaveLength(2)
        expect(engines[1].account).toBe('alt')
        expect(engines[1].configDir).toBe(h.altDir)
        // The id the app is watching does not change.
        expect(engines[1].sessionId).toBe('sess-1')
        expect(h.events.join('\n')).toContain('main → alt')

        h.handlers.switch()
        await expect(run).resolves.toBe('switch')
    })

    it('says "carry on" to the engine it started, rather than leaving it mute', async () => {
        // Local mode hands the arrival prompt to the spawn as its opening
        // prompt. A query() loop has no such thing, so it goes to the head of
        // the message queue instead — and if it did not, a flipped remote
        // session would sit silent until someone happened to type at it.
        const h = await build()
        const run = h.claudeRemoteLauncher(h.session)
        await settle()
        h.flip.request({ account: 'alt', reason: 'manual', by: 'app' })
        await settle()

        expect(prompts).toHaveLength(1)
        expect(prompts[0]).toContain('Pick up where we left off')

        h.handlers.switch()
        await run
    })

    it('carries the transcript into the target account before resuming there', async () => {
        const h = await build()
        const projectId = h.cwd.replace(/[^a-zA-Z0-9-]/g, '-')
        const landing = join(h.altDir, 'projects', projectId, 'sess-1.jsonl')
        expect(existsSync(landing)).toBe(false)

        const run = h.claudeRemoteLauncher(h.session)
        await settle()
        h.flip.request({ account: 'alt', reason: 'manual', by: 'app' })
        await settle()

        expect(existsSync(landing)).toBe(true)
        expect(readFileSync(landing, 'utf8')).toContain('"type":"user"')

        h.handlers.switch()
        await run
    })

    it('stays in REMOTE mode instead of dumping the session back to the keyboard', async () => {
        // The account changes; the control surface does not. A daemon-spawned
        // session cannot run local mode at all (runClaude hard-fails
        // daemon + local), and whoever pressed flip on the phone is not at the
        // keyboard to take a session that quietly went interactive.
        const h = await build()
        const run = h.claudeRemoteLauncher(h.session)
        await settle()
        h.flip.request({ account: 'alt', reason: 'manual', by: 'app' })
        await settle()

        // Still running: the launcher has not returned, so loop.ts has not
        // been told to switch modes.
        let settled = false
        void run.then(() => {
            settled = true
        })
        await settle()
        expect(settled).toBe(false)
        expect(engines).toHaveLength(2)

        h.handlers.switch()
        await expect(run).resolves.toBe('switch')
    })

    it('stamps the new account on the metadata the app renders', async () => {
        const h = await build()
        const run = h.claudeRemoteLauncher(h.session)
        await settle()
        h.flip.request({ account: 'alt', reason: 'manual', by: 'app' })
        await settle()

        expect(h.metadata().droverAccount).toBe('alt')
        expect(String(h.metadata().name)).toContain('[alt]')

        h.handlers.switch()
        await run
    })

    it('announces a refused flip and keeps the session alive rather than exiting', async () => {
        const h = await build()
        const run = h.claudeRemoteLauncher(h.session)
        await settle()
        h.flip.request({ account: 'nosuch', reason: 'manual', by: 'app' })
        await settle()

        expect(h.events.join('\n')).toContain('no account named "nosuch"')
        // Carried on where it was, on the SAME account.
        expect(engines).toHaveLength(2)
        expect(engines[1].account).toBe('main')

        h.handlers.switch()
        await expect(run).resolves.toBe('switch')
    })

    it('does not report a flip as "Aborted by user"', async () => {
        // The abort IS the flip. Reporting it as the stop button, and closing
        // the turn as cancelled, contradicts the flip note arriving right
        // behind it.
        const h = await build()
        const run = h.claudeRemoteLauncher(h.session)
        await settle()
        h.flip.request({ account: 'alt', reason: 'manual', by: 'app' })
        await settle()

        expect(h.events.join('\n')).not.toContain('Aborted by user')

        h.handlers.switch()
        await run
    })
})

describe('running out of headroom while REMOTE', () => {
    it('flips on a synthetic limit message the engine streams, and records the cooldown', async () => {
        // The last hole in DROVE-12. The flip itself works in remote mode now,
        // but nothing FED the limit detector there: noteTranscriptMessage was
        // called from the local launcher's onMessage and nowhere else, so a
        // remote session that ran out kept talking to an exhausted account.
        //
        // It goes through live.onMessage rather than calling the controller
        // directly, because the wiring IS the defect — a test that pokes the
        // controller would have passed all along.
        process.env.DROVER_ACCOUNT = 'main'
        const h = await build()
        const run = h.claudeRemoteLauncher(h.session)
        await settle()
        expect(engines).toHaveLength(1)

        live.onMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                model: '<synthetic>',
                content: 'Claude usage limit reached. Resets at 3pm.',
            },
        })
        await settle()

        expect(engines).toHaveLength(2)
        expect(engines[1].account).toBe('alt')
        expect(h.accounts.isCooling('main')).toBe(true)

        h.handlers.switch()
        await expect(run).resolves.toBe('switch')
    })

    it('does not move the session when the engine merely TALKS about a limit', async () => {
        // A real model answering a question about rate limits must never move
        // Clay onto another account behind his back. Same guard local has.
        process.env.DROVER_ACCOUNT = 'main'
        const h = await build()
        const run = h.claudeRemoteLauncher(h.session)
        await settle()

        live.onMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                model: 'claude-opus-4',
                content: 'The usage limit reached branch is the one to test here.',
            },
        })
        await settle()

        expect(engines).toHaveLength(1)
        expect(h.accounts.isCooling('main')).toBe(false)

        h.handlers.switch()
        await expect(run).resolves.toBe('switch')
    })
})

describe('warning about the Remote Control it will sever', () => {
    // The bus is stubbed at fetch, not at a seam invented for the test, so the
    // real fetchBusSessions -> sessionsAtRisk -> warningFor path runs.
    // Routed by URL, not blanket: the FlipController also opens the bus event
    // stream at /v1/stream, and a stub that answered everything with a session
    // list broke six unrelated tests in this file.
    const busReturns = (rows: unknown[]) => {
        const spy = vi.fn(async (url: any) => {
            if (String(url).includes('/v1/sessions')) {
                return { ok: true, json: async () => rows } as any
            }
            throw new Error('no bus in tests')
        })
        ;(globalThis as any).fetch = spy
        return spy
    }
    const realFetch: any = (globalThis as any).fetch
    afterEach(() => { (globalThis as any).fetch = realFetch })

    it('names the other live session on the terminal AND the phone', async () => {
        // DROVE-37. The warning is only worth anything if a REAL flip emits it,
        // so this goes through the launcher rather than calling the formatter.
        // `employees` is UNMANAGED — account null — which is the exact shape
        // Clay lost and the one a naive filter on named accounts would skip.
        busReturns([
            { id: 'sess-1', account: 'main', title: 'drover', state: 'live-interactive' },
            { id: 'emp', account: null, title: 'employees', state: 'live-interactive' },
            { id: 'old', account: 'main', title: 'finished', state: 'ended' },
        ])
        const h = await build()
        const run = h.claudeRemoteLauncher(h.session)
        await settle()

        h.flip.request({ account: 'alt', reason: 'manual', by: 'app' })
        await settle()

        const said = h.said.join('\n')
        expect(said).toContain('employees (main)')
        expect(said).toContain('/remote-control')
        // Not the session doing the flipping, and not the one that has ended.
        expect(said).not.toContain('drover (main)')
        expect(said).not.toContain('finished')
        // say() reaches the keyboard too, which is where Clay was sitting.
        expect(h.terminal.join('\n')).toContain('employees (main)')

        h.handlers.switch()
        await expect(run).resolves.toBe('switch')
    })

    it('stays silent when every other live session is already on the target', async () => {
        busReturns([{ id: 'other', account: 'alt', title: 'already there', state: 'live-interactive' }])
        const h = await build()
        const run = h.claudeRemoteLauncher(h.session)
        await settle()

        h.flip.request({ account: 'alt', reason: 'manual', by: 'app' })
        await settle()

        expect(h.said.join('\n')).not.toContain('Remote Control')

        h.handlers.switch()
        await expect(run).resolves.toBe('switch')
    })

    it('flips anyway when the bus cannot be reached', async () => {
        // A flip is usually asked for BECAUSE an account ran out. A bus that is
        // down must cost the warning, never the flip.
        ;(globalThis as any).fetch = vi.fn(async () => { throw new Error('bus unreachable') })
        const h = await build()
        const run = h.claudeRemoteLauncher(h.session)
        await settle()

        h.flip.request({ account: 'alt', reason: 'manual', by: 'app' })
        await settle()

        expect(engines).toHaveLength(2)
        expect(engines[1].account).toBe('alt')

        h.handlers.switch()
        await expect(run).resolves.toBe('switch')
    })
})

describe('the in-flight gate in remote mode', () => {
    it('holds a flip while subagents are running, and takes it on the repeat', async () => {
        const h = await build()
        const run = h.claudeRemoteLauncher(h.session)
        await settle()
        // Two agents launched, as remote mode hears about them: an SDK user
        // message carrying the launch banner.
        live.onMessage(sdkLaunchMessage('agent0001'))
        live.onMessage(sdkLaunchMessage('agent0002'))

        h.flip.request({ account: 'alt', reason: 'manual', by: 'app' })
        await settle()

        // Nothing was stopped, and nothing was queued for later either.
        expect(engines).toHaveLength(1)
        expect(h.said.join('\n')).toContain('2 subagents still running')
        expect(h.said.join('\n')).toContain('Ask again within')

        // The repeat means "do it anyway".
        h.flip.request({ account: 'alt', reason: 'manual', by: 'app' })
        await settle()
        expect(engines).toHaveLength(2)
        expect(engines[1].account).toBe('alt')
        expect(h.said.join('\n')).toContain('confirmed')

        h.handlers.switch()
        await run
    })

    it('flips anyway on a usage limit, after saying what it costs', async () => {
        const h = await build()
        const run = h.claudeRemoteLauncher(h.session)
        await settle()
        live.onMessage(sdkLaunchMessage('agent0001'))

        h.flip.request({ account: null, reason: 'usage limit', by: 'auto' })
        await settle()

        expect(engines).toHaveLength(2)
        expect(engines[1].account).toBe('alt')
        expect(h.said.join('\n')).toContain('1 subagent still running')
        expect(h.said.join('\n')).toContain('tasks/<agentId>.output')

        h.handlers.switch()
        await run
    })

    it('forgets the count when the engine restarts, so it cannot jam the gate', async () => {
        const h = await build()
        const run = h.claudeRemoteLauncher(h.session)
        await settle()
        live.onMessage(sdkLaunchMessage('agent0001'))

        // Confirmed flip: the agent is abandoned with the engine that held it.
        h.flip.request({ account: 'alt', reason: 'manual', by: 'app' })
        h.flip.request({ account: 'alt', reason: 'manual', by: 'app' })
        await settle()
        expect(engines).toHaveLength(2)

        // The next flip must not be gated by an agent that died two engines
        // ago — the entry belonged to a process that no longer exists.
        h.flip.request({ account: 'main', reason: 'back', by: 'app' })
        await settle()
        expect(engines).toHaveLength(3)
        expect(engines[2].account).toBe('main')

        h.handlers.switch()
        await run
    })
})

describe('the abort handler does not outlive the launcher that registered it', () => {
    it('is handed back on the way out, so the next mode cannot call a dead closure', async () => {
        // This is a bug in its own right, and it is half of why a remote flip
        // did nothing: claudeLocalLauncher registered a handler closing over
        // ITS AbortController and never cleared it. In remote mode the
        // controller then had a handler that was already aborted, called it,
        // stopped nothing, and reported success.
        const h = await build()
        const run = h.claudeRemoteLauncher(h.session)
        await settle()
        expect((h.flip as any).abortChild).not.toBeNull()

        h.handlers.switch()
        await run

        expect((h.flip as any).abortChild).toBeNull()
        // The in-flight probe goes with it: the tracker was tailing a
        // transcript for an engine that has stopped.
        expect((h.flip as any).inFlight).toBeNull()
    })

    it('a flip requested between launchers queues instead of firing a stale abort', async () => {
        const h = await build()
        const run = h.claudeRemoteLauncher(h.session)
        await settle()
        h.handlers.switch()
        await run

        // Nothing is running. The request is remembered for whichever launcher
        // comes next, and stops nothing in the meantime.
        h.flip.request({ account: 'alt', reason: 'manual', by: 'app' })
        expect(engines).toHaveLength(1)
        expect(h.flip.take()).toMatchObject({ account: 'alt' })
    })
})
