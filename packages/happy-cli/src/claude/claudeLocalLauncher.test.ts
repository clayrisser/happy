import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const {
    mockClaudeLocal,
    mockCreateSessionScanner,
    mockInjectIntoPane,
    mockPaneIsIdle,
    mockFindInbox,
    mockSendToInbox,
    mockInterruptPane,
    mockReadPaneMode,
    mockPressCycleKey,
    callLog,
} = vi.hoisted(() => ({
    mockClaudeLocal: vi.fn(),
    mockCreateSessionScanner: vi.fn(),
    mockInjectIntoPane: vi.fn(),
    mockPaneIsIdle: vi.fn(async () => true),
    mockFindInbox: vi.fn(),
    mockSendToInbox: vi.fn(),
    mockInterruptPane: vi.fn(),
    mockReadPaneMode: vi.fn(),
    mockPressCycleKey: vi.fn(),
    // DROVE-36 is partly a question of ORDER — did the mode reach the pane
    // before the message that came with it — and per-mock call counts cannot
    // answer that. One log, in the order things actually happened.
    callLog: [] as string[],
}));

vi.mock('./claudeLocal', () => ({
    claudeLocal: mockClaudeLocal,
    ExitCodeError: class ExitCodeError extends Error {
        exitCode: number;

        constructor(exitCode: number) {
            super(`Process exited with code: ${exitCode}`);
            this.exitCode = exitCode;
        }
    },
}));

vi.mock('./utils/sessionScanner', () => ({
    createSessionScanner: mockCreateSessionScanner,
}));

vi.mock('./utils/paneInject', () => ({
    injectIntoPane: mockInjectIntoPane,
    // DROVE-45 types slash commands through the raw inject plus its own idle
    // check. Idle by default here so a queued /model is not held forever; the
    // model-routing tests below override it.
    paneIsIdle: mockPaneIsIdle,
    // The launcher goes through the gated entry point. Adapt it onto the same
    // boolean mock so the tests keep asserting on (pane, text): a truthy
    // answer is "delivered and submitted", a falsy one is "refused".
    injectIntoPaneGated: async (gate: { pane: string }, text: string) => {
        const delivered = Boolean(await mockInjectIntoPane(gate.pane, text));
        return { delivered, submitted: delivered };
    },
    interruptPane: mockInterruptPane,
}));

vi.mock('./utils/inboxSocket', () => ({
    findInbox: mockFindInbox,
    sendToInbox: mockSendToInbox,
}));

// DROVE-36. Only the two tmux calls are faked: the cycle loop itself is the
// real one, because "press, read back, press again" is the whole design and a
// fake of it would prove nothing about the launcher's use of it.
vi.mock('./utils/panePermissionSync', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./utils/panePermissionSync')>()),
    readPaneMode: mockReadPaneMode,
    pressCycleKey: mockPressCycleKey,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
    },
}));

import { claudeLocalLauncher } from './claudeLocalLauncher';
import { MessageQueue2 } from '@/utils/MessageQueue2';

type QueueHandler = (message: string, mode: { permissionMode: 'default' }) => void;
type ScannerOptions = {
    sessionId: string | null;
    workingDirectory: string;
    onMessage: (message: any) => void;
};

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

const RESUMED_ID = '9ae61ba4-8a3b-452f-a294-da49d0019c79';

/**
 * Start the launcher on a stub session and hand back the levers the replay
 * tests need: the scanner's onNewSession spy, the SessionStart hook callback,
 * and a way to let the child exit. Only the fields those tests vary are
 * parameters; everything else is the same inert stub each time.
 */
async function startLauncher(overrides: {
    sessionId?: string | null;
    claudeArgs?: string[];
    reattachedClaudeSessionId?: string;
}) {
    const onNewSession = vi.fn();
    mockCreateSessionScanner.mockResolvedValue({
        onNewSession,
        cleanup: vi.fn(async () => {}),
    });
    const localRun = createDeferred<void>();
    mockClaudeLocal.mockImplementation(async () => {
        await localRun.promise;
    });

    let sessionFound: ((sessionId: string) => void) | undefined;
    const session = {
        sessionId: overrides.sessionId ?? null,
        reattachedClaudeSessionId: overrides.reattachedClaudeSessionId,
        path: '/tmp/project',
        client: {
            sendClaudeSessionMessage: vi.fn(),
            sendClaudeSessionMessageFromLocalTranscript: vi.fn(async () => {}),
            closeClaudeSessionTurn: vi.fn(),
            rpcHandlerManager: { registerHandler: vi.fn() },
            // A real client is an EventEmitter carrying session metadata; the
            // launcher reads both to route a phone-side model pick (DROVE-45).
            // These tests run wherever they run, and $TMUX_PANE is set inside a
            // terminal, so the stub has to answer whether they care or not.
            getMetadata: () => ({}),
            updateMetadata: vi.fn(),
            on: vi.fn(),
            off: vi.fn(),
        },
        queue: {
            reset: vi.fn(),
            setOnMessage: vi.fn(),
            size: vi.fn(() => 0),
        },
        addSessionFoundCallback: vi.fn((callback: (sessionId: string) => void) => {
            sessionFound = callback;
        }),
        removeSessionFoundCallback: vi.fn(),
        onAbort: vi.fn(),
        onSessionFound: vi.fn(),
        onThinkingChange: vi.fn(),
        consumeOneTimeFlags: vi.fn(),
        claudeEnvVars: undefined,
        claudeArgs: overrides.claudeArgs,
        mcpServers: {},
        allowedTools: [],
        hookSettingsPath: '/tmp/hook-settings.json',
        sandboxConfig: undefined,
    };

    const launcher = claudeLocalLauncher(session as any);
    await vi.waitFor(() => {
        expect(sessionFound).toBeDefined();
    });

    return {
        onNewSession,
        sessionFound: () => sessionFound!,
        finish: async () => {
            localRun.resolve();
            await expect(launcher).resolves.toEqual({ type: 'exit', code: 0 });
        },
    };
}

describe('claudeLocalLauncher', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // No pane. Stated rather than assumed: `$TMUX_PANE` is set for every
        // process started inside tmux, so a suite run from Clay's own terminal
        // would otherwise take the pane path and type into it.
        vi.stubEnv('TMUX_PANE', '');
        mockCreateSessionScanner.mockResolvedValue({
            onNewSession: vi.fn(),
            cleanup: vi.fn(async () => {}),
        });
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('aborts local Claude Code when an app message requests remote control', async () => {
        const localRun = createDeferred<void>();
        const observed: {
            queueHandler?: QueueHandler;
            localAbortSignal?: AbortSignal;
        } = {};
        let queuedMessages = 0;

        mockClaudeLocal.mockImplementation(async (opts: { abort: AbortSignal }) => {
            observed.localAbortSignal = opts.abort;
            await localRun.promise;
        });

        const session = {
            sessionId: 'claude-session-1',
            path: '/tmp/project',
            client: {
                sendClaudeSessionMessage: vi.fn(),
                sendClaudeSessionMessageFromLocalTranscript: vi.fn(async () => {}),
                closeClaudeSessionTurn: vi.fn(),
                rpcHandlerManager: {
                    registerHandler: vi.fn(),
                },
            },
            queue: {
                reset: vi.fn(() => {
                    queuedMessages = 0;
                }),
                setOnMessage: vi.fn((handler: QueueHandler | null) => {
                    observed.queueHandler = handler ?? undefined;
                }),
                size: vi.fn(() => queuedMessages),
            },
            addSessionFoundCallback: vi.fn(),
            removeSessionFoundCallback: vi.fn(),
            onAbort: vi.fn(),
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            consumeOneTimeFlags: vi.fn(),
            claudeEnvVars: undefined,
            claudeArgs: undefined,
            mcpServers: {},
            allowedTools: [],
            hookSettingsPath: '/tmp/hook-settings.json',
            sandboxConfig: undefined,
        };

        const launcher = claudeLocalLauncher(session as any);

        await vi.waitFor(() => {
            expect(observed.localAbortSignal).toBeDefined();
            expect(observed.queueHandler).toBeDefined();
        });

        queuedMessages = 1;
        const handler = observed.queueHandler;
        const signal = observed.localAbortSignal;
        if (!handler || !signal) {
            throw new Error('local launcher did not start');
        }
        handler('from app', { permissionMode: 'default' });

        await vi.waitFor(() => {
            expect(signal.aborted).toBe(true);
        });
        expect(session.client.closeClaudeSessionTurn).not.toHaveBeenCalledWith('cancelled');

        localRun.resolve();

        await expect(launcher).resolves.toEqual({ type: 'switch' });
        expect(session.client.closeClaudeSessionTurn).toHaveBeenCalledWith('completed');
    });

    it('still hands a PANELESS session to remote mode when the phone presses Stop', async () => {
        // DROVE-13 softens Stop for a pane session only. A daemon-spawned one
        // has no terminal to protect and no other carrier the phone can reach,
        // so the upstream kill-and-switch stays exactly as it was.
        const localRun = createDeferred<void>();
        let abortSignal: AbortSignal | undefined;
        mockClaudeLocal.mockImplementation(async (opts: { abort: AbortSignal }) => {
            abortSignal = opts.abort;
            await localRun.promise;
        });
        const handlers = new Map<string, () => Promise<void>>();
        const session = {
            sessionId: 'claude-session-paneless',
            path: '/tmp/project',
            client: {
                sendClaudeSessionMessage: vi.fn(),
                sendClaudeSessionMessageFromLocalTranscript: vi.fn(async () => {}),
                closeClaudeSessionTurn: vi.fn(),
                sendSessionEvent: vi.fn(),
                rpcHandlerManager: {
                    registerHandler: vi.fn((name: string, fn: () => Promise<void>) => {
                        if (!handlers.has(name)) handlers.set(name, fn);
                    }),
                },
            },
            queue: { reset: vi.fn(), setOnMessage: vi.fn(), size: vi.fn(() => 0) },
            addSessionFoundCallback: vi.fn(),
            removeSessionFoundCallback: vi.fn(),
            onAbort: vi.fn(),
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            consumeOneTimeFlags: vi.fn(),
            claudeEnvVars: undefined,
            claudeArgs: undefined,
            mcpServers: {},
            allowedTools: [],
            hookSettingsPath: '/tmp/hook-settings.json',
            sandboxConfig: undefined,
        };

        const launcher = claudeLocalLauncher(session as any);
        await vi.waitFor(() => expect(handlers.has('abort')).toBe(true));

        void handlers.get('abort')!();

        await vi.waitFor(() => expect(abortSignal?.aborted).toBe(true));
        expect(mockInterruptPane).not.toHaveBeenCalled();
        expect(session.queue.reset).toHaveBeenCalled();

        localRun.resolve();
        await expect(launcher).resolves.toEqual({ type: 'switch' });
    });

    it('routes scanner messages through local transcript replay so attachments can be uploaded', async () => {
        const localRun = createDeferred<void>();
        let scannerOptions: ScannerOptions | undefined;

        mockCreateSessionScanner.mockImplementation(async (opts: ScannerOptions) => {
            scannerOptions = opts;
            return {
                onNewSession: vi.fn(),
                cleanup: vi.fn(async () => {}),
            };
        });
        mockClaudeLocal.mockImplementation(async () => {
            await localRun.promise;
        });

        const session = {
            sessionId: 'claude-session-1',
            path: '/tmp/project',
            client: {
                sendClaudeSessionMessage: vi.fn(),
                sendClaudeSessionMessageFromLocalTranscript: vi.fn(async () => {}),
                closeClaudeSessionTurn: vi.fn(),
                rpcHandlerManager: {
                    registerHandler: vi.fn(),
                },
            },
            queue: {
                reset: vi.fn(),
                setOnMessage: vi.fn(),
                size: vi.fn(() => 0),
            },
            addSessionFoundCallback: vi.fn(),
            removeSessionFoundCallback: vi.fn(),
            onAbort: vi.fn(),
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            consumeOneTimeFlags: vi.fn(),
            claudeEnvVars: undefined,
            claudeArgs: undefined,
            mcpServers: {},
            allowedTools: [],
            hookSettingsPath: '/tmp/hook-settings.json',
            sandboxConfig: undefined,
        };

        const launcher = claudeLocalLauncher(session as any);

        await vi.waitFor(() => {
            expect(scannerOptions).toBeDefined();
        });

        scannerOptions!.onMessage({
            type: 'user',
            uuid: 'u-image-1',
            message: {
                content: [
                    { type: 'text', text: 'look' },
                    {
                        type: 'image',
                        source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
                    },
                ],
            },
        });

        await vi.waitFor(() => {
            expect(session.client.sendClaudeSessionMessageFromLocalTranscript).toHaveBeenCalledWith(
                expect.objectContaining({ uuid: 'u-image-1' }),
            );
        });
        expect(session.client.sendClaudeSessionMessage).not.toHaveBeenCalled();

        localRun.resolve();
        await launcher;
    });

    it('reports the underlying error when a launch throws, instead of a bare notice', async () => {
        // The SDK surfaces an unresolvable native binary as a plain Error; the
        // launcher used to drop it and report only "Process exited unexpectedly".
        const sdkFailure = new Error(
            'Native CLI binary for darwin-arm64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.'
        );
        mockClaudeLocal
            .mockRejectedValueOnce(sdkFailure)
            .mockResolvedValueOnce(undefined);

        const session = {
            sessionId: 'claude-session-3',
            path: '/tmp/project',
            client: {
                sendClaudeSessionMessage: vi.fn(),
                sendClaudeSessionMessageFromLocalTranscript: vi.fn(async () => {}),
                closeClaudeSessionTurn: vi.fn(),
                sendSessionEvent: vi.fn(),
                rpcHandlerManager: {
                    registerHandler: vi.fn(),
                },
            },
            queue: {
                reset: vi.fn(),
                setOnMessage: vi.fn(),
                size: vi.fn(() => 0),
            },
            addSessionFoundCallback: vi.fn(),
            removeSessionFoundCallback: vi.fn(),
            onAbort: vi.fn(),
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            consumeOneTimeFlags: vi.fn(),
            claudeEnvVars: undefined,
            claudeArgs: undefined,
            mcpServers: {},
            allowedTools: [],
            hookSettingsPath: '/tmp/hook-settings.json',
            sandboxConfig: undefined,
        };

        // The failed launch retries, so the second attempt settles the launcher.
        await expect(claudeLocalLauncher(session as any)).resolves.toEqual({ type: 'exit', code: 0 });

        expect(session.client.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: `Process exited unexpectedly: ${sdkFailure.message}`,
        });
    });

    // The replay storm. Every one of these is a run whose transcript already
    // exists on disk before our child writes a byte, so the first SessionStart
    // hook is announcing history. The guard used to demand a successful
    // reattach, which only the first row can offer; the rest streamed the whole
    // file to the phone as fresh user prompts. Clay hit the bare `--resume`
    // row repeatedly against a 190 MB transcript.
    const historyOnDisk: Array<{ what: string; claudeArgs: string[]; reattached?: string }> = [
        { what: 'a reattached --resume', claudeArgs: ['--resume', RESUMED_ID], reattached: RESUMED_ID },
        { what: 'a --resume that found no Happy session to reattach to', claudeArgs: ['--resume', RESUMED_ID] },
        { what: 'a bare --resume, whose id does not exist until this very hook', claudeArgs: ['--resume'] },
        { what: 'a bare -r', claudeArgs: ['-r'] },
        { what: '--continue', claudeArgs: ['--continue'] },
        { what: '-c', claudeArgs: ['-c'] },
        { what: '--resume behind other flags', claudeArgs: ['--dangerously-skip-permissions', '--resume', RESUMED_ID] },
    ];

    for (const { what, claudeArgs, reattached } of historyOnDisk) {
        it(`pre-marks the transcript on ${what}, so old messages are not replayed`, async () => {
            const { onNewSession, sessionFound, finish } = await startLauncher({
                claudeArgs,
                reattachedClaudeSessionId: reattached,
            });

            sessionFound()(RESUMED_ID);
            expect(onNewSession).toHaveBeenLastCalledWith(RESUMED_ID, { treatExistingAsProcessed: true });

            await finish();
        });
    }

    it('leaves a fresh start alone — there is no history to mistake for activity', async () => {
        const { onNewSession, sessionFound, finish } = await startLauncher({ claudeArgs: undefined });

        sessionFound()(RESUMED_ID);
        expect(onNewSession).toHaveBeenLastCalledWith(RESUMED_ID, undefined);

        await finish();
    });

    it('only pre-marks the FIRST hook, so a fork or /compact still flows', async () => {
        // This is also what keeps a flip safe. A flip relaunches inside the
        // launcher's own loop, so its hook is never the first one — and
        // sessionScanner's setClaudeConfigDir must re-read the carried file
        // from the top, because what Claude appended between the last poll and
        // the kill is still unsent. Pre-marking there eats exactly those.
        const { onNewSession, sessionFound, finish } = await startLauncher({
            claudeArgs: ['--resume', RESUMED_ID],
        });

        sessionFound()(RESUMED_ID);
        expect(onNewSession).toHaveBeenLastCalledWith(RESUMED_ID, { treatExistingAsProcessed: true });

        sessionFound()('22222222-3333-4444-8555-666666666666');
        expect(onNewSession).toHaveBeenLastCalledWith('22222222-3333-4444-8555-666666666666', undefined);

        await finish();
    });

    it('does not pre-mark a second launcher run, where the id is already known', async () => {
        // A local -> remote -> local switch re-enters the launcher. The flags
        // are spent by then and sessionId is set, so the scanner's own
        // constructor marks the file and this path must stay out of it — a
        // Claude that forks on relaunch would otherwise lose its tail.
        const { onNewSession, sessionFound, finish } = await startLauncher({
            sessionId: RESUMED_ID,
            claudeArgs: ['--resume', RESUMED_ID],
        });

        sessionFound()('22222222-3333-4444-8555-666666666666');
        expect(onNewSession).toHaveBeenLastCalledWith('22222222-3333-4444-8555-666666666666', undefined);

        await finish();
    });
});

/**
 * One mode for a pane session (BASED-141, DROVE-1).
 *
 * A session running in a tmux pane never hands itself to remote mode: the
 * terminal IS the session, so a takeover kills the thing Clay is watching and
 * replays his message as a second, headless conversation. Everything below is
 * one of the four ways that used to happen.
 */
describe('claudeLocalLauncher in a tmux pane', () => {
    const pane = '%50';
    const claudeSessionId = 'e495e6e8-43f6-4699-a984-ff19f5ab4551';
    const inbox = {
        pid: 4242,
        sessionId: claudeSessionId,
        socketPath: '/tmp/cc-socks/4242.sock',
        token: 'peer-token',
    };
    const mode = { permissionMode: 'default' } as any;

    beforeEach(() => {
        vi.clearAllMocks();
        callLog.length = 0;
        vi.stubEnv('TMUX_PANE', pane);
        mockCreateSessionScanner.mockResolvedValue({
            onNewSession: vi.fn(),
            cleanup: vi.fn(async () => {}),
        });
        // A pane nobody asked to change mode: reads back whatever it is on and
        // refuses nothing. Tests that care override it with `paneCycle`.
        mockReadPaneMode.mockResolvedValue('default');
        mockPressCycleKey.mockResolvedValue(true);
    });

    /**
     * A pane that walks `ring` on every shift+tab, starting at `start` — the
     * behaviour measured in Claude Code 2.1.251, where the cycle is a ring of
     * plan / default / acceptEdits plus auto and bypassPermissions when each is
     * available. Every read and press is logged so ordering can be asserted.
     */
    function paneCycle(ring: string[], start: string) {
        let index = ring.indexOf(start);
        mockReadPaneMode.mockImplementation(async () => ring[index]);
        mockPressCycleKey.mockImplementation(async () => {
            index = (index + 1) % ring.length;
            callLog.push(`cycle:${ring[index]}`);
            return true;
        });
        return { at: () => ring[index] };
    }

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    /** A stub session with a REAL queue, because the queue is what is on trial. */
    function paneSession(initialMetadata: Record<string, any> = {}) {
        const queue = new MessageQueue2<any>(() => 'mode-hash');
        // DROVE-45: the client is an EventEmitter in real life, and 'metadata'
        // is how a model or effort pick made on the phone reaches this
        // launcher. `emitMetadata` below is the app doing the picking.
        const bus = new EventEmitter();
        let metadata: Record<string, any> = { ...initialMetadata };
        const session = {
            sessionId: claudeSessionId,
            path: '/tmp/project',
            client: {
                sendClaudeSessionMessage: vi.fn(),
                sendClaudeSessionMessageFromLocalTranscript: vi.fn(async () => {}),
                sendQueuedPromptFromLocalTranscript: vi.fn(),
                closeClaudeSessionTurn: vi.fn(),
                sendSessionEvent: vi.fn(),
                rpcHandlerManager: { registerHandler: vi.fn() },
                getMetadata: () => metadata,
                updateMetadata: (fn: (m: any) => any) => { metadata = fn(metadata); },
                on: (event: string, handler: (...args: any[]) => void) => bus.on(event, handler),
                off: (event: string, handler: (...args: any[]) => void) => bus.off(event, handler),
            },
            queue,
            addSessionFoundCallback: vi.fn(),
            removeSessionFoundCallback: vi.fn(),
            onAbort: vi.fn(),
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            consumeOneTimeFlags: vi.fn(),
            claudeEnvVars: undefined,
            claudeArgs: undefined,
            mcpServers: {},
            allowedTools: [],
            hookSettingsPath: '/tmp/hook-settings.json',
            sandboxConfig: undefined,
            pendingInitialPrompt: undefined as string | undefined,
        };
        const emitMetadata = (patch: Record<string, any>) => {
            metadata = { ...metadata, ...patch };
            bus.emit('metadata', metadata);
        };
        return { session, queue, emitMetadata, readMetadata: () => metadata };
    }

    /** Every claudeLocal call, with the lever that ends it. */
    function trackRuns() {
        const runs: Array<{ opts: any; run: ReturnType<typeof createDeferred<void>> }> = [];
        mockClaudeLocal.mockImplementation(async (opts: any) => {
            const run = createDeferred<void>();
            runs.push({ opts, run });
            await run.promise;
        });
        return runs;
    }

    /**
     * DROVE-45. Clay's composer read "Fable 5 - Ultracode" while /status in the
     * pane read claude-opus-5[1m], because the pickers write session metadata
     * and only the SDK path ever read it. A pane has no query() to hand it to,
     * so the pick was ignored in silence. `/model` and `/effort` are the pane's
     * own way in — both real commands in Claude Code 2.1.251.
     */
    describe('a model picked in the app', () => {
        it('is typed into the pane as /model at the next idle prompt', async () => {
            const runs = trackRuns();
            const { session, emitMetadata } = paneSession({ modelMode: 'claude-opus-5' });
            mockInjectIntoPane.mockResolvedValue(true);

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            emitMetadata({ modelMode: 'claude-sonnet-5' });

            await vi.waitFor(() => expect(mockInjectIntoPane).toHaveBeenCalledWith(
                pane, '/model claude-sonnet-5', { submit: true },
            ));

            runs[0].run.resolve();
            await launcher;
        });

        it('carries effort too, and sends the model first because effort is capped by it', async () => {
            const runs = trackRuns();
            const { session, emitMetadata } = paneSession({ modelMode: 'claude-opus-5', effortLevel: 'high' });
            mockInjectIntoPane.mockResolvedValue(true);

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            emitMetadata({ modelMode: 'claude-fable-5', effortLevel: 'xhigh' });

            await vi.waitFor(() => expect(mockInjectIntoPane.mock.calls.length).toBe(2));
            expect(mockInjectIntoPane.mock.calls.map((c) => c[1])).toEqual([
                '/model claude-fable-5',
                '/effort xhigh',
            ]);

            runs[0].run.resolve();
            await launcher;
        });

        it('waits for the prompt instead of pasting a half-typed command into it', async () => {
            // The one thing that must never happen: `/model x` landing in the
            // middle of Clay's own line. A message is drafted when the pane is
            // busy; a command is HELD.
            const runs = trackRuns();
            const { session, emitMetadata } = paneSession({});
            mockInjectIntoPane.mockResolvedValue(true);
            mockPaneIsIdle.mockResolvedValue(false);

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            emitMetadata({ modelMode: 'claude-sonnet-5' });
            await new Promise((r) => setTimeout(r, 50));
            expect(mockInjectIntoPane).not.toHaveBeenCalled();

            // ...and it goes in the moment the prompt opens up.
            mockPaneIsIdle.mockResolvedValue(true);
            await vi.waitFor(() => expect(mockInjectIntoPane).toHaveBeenCalledWith(
                pane, '/model claude-sonnet-5', { submit: true },
            ), { timeout: 5000 });

            runs[0].run.resolve();
            await launcher;
        });

        it('types nothing when the metadata write did not change the pick', async () => {
            const runs = trackRuns();
            const { session, emitMetadata } = paneSession({ modelMode: 'claude-opus-5' });
            mockInjectIntoPane.mockResolvedValue(true);

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            // The app renaming the session, say. Same model, so the pane must
            // not be interrupted with a /model it is already on.
            emitMetadata({ name: 'renamed', modelMode: 'claude-opus-5' });
            await new Promise((r) => setTimeout(r, 50));

            expect(mockInjectIntoPane).not.toHaveBeenCalled();

            runs[0].run.resolve();
            await launcher;
        });

        it('says the pane is on the new model straight away, so the chip stops lying', async () => {
            const runs = trackRuns();
            const { session, emitMetadata, readMetadata } = paneSession({ modelMode: 'claude-opus-5' });
            mockInjectIntoPane.mockResolvedValue(true);

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            emitMetadata({ modelMode: 'claude-sonnet-5' });
            await vi.waitFor(() => expect(readMetadata().paneModel).toBe('claude-sonnet-5'));

            runs[0].run.resolve();
            await launcher;
        });
    });

    /**
     * DROVE-36. Clay had Yolo selected in the composer for this very session
     * and every Bash call still raised a permission card, because the pick was
     * metadata nothing in the pane path ever read. 2.1.251 has no slash
     * command for the permission mode — measured, see panePermissionSync.ts —
     * so the carrier is the keystroke a person would use.
     */
    describe('a permission mode picked in the app', () => {
        it('cycles the pane to Yolo with shift+tab, without restarting anything', async () => {
            const runs = trackRuns();
            const cycle = paneCycle(['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'], 'default');
            const { session, emitMetadata, readMetadata } = paneSession({ permissionMode: 'default' });

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            emitMetadata({ permissionMode: 'bypassPermissions' });

            await vi.waitFor(() => expect(cycle.at()).toBe('bypassPermissions'), { timeout: 5000 });
            // The chip on the phone says so too, without waiting for a turn.
            await vi.waitFor(() => expect(readMetadata().panePermissionMode).toBe('bypassPermissions'));
            // One child, start to finish: the mode changed under a running
            // session rather than by relaunching it.
            expect(runs).toHaveLength(1);

            runs[0].run.resolve();
            await launcher;
        });

        it('reads the app\'s Yolo as Claude\'s bypassPermissions, through the one mapping', async () => {
            // `yolo` is Codex's spelling and mapToClaudeMode is the single
            // place it is folded into Claude's. A second copy of that table
            // here is how the two drift.
            const runs = trackRuns();
            const cycle = paneCycle(['default', 'bypassPermissions'], 'default');
            const { session, emitMetadata } = paneSession({ permissionMode: 'default' });

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            emitMetadata({ permissionMode: 'yolo' });
            await vi.waitFor(() => expect(cycle.at()).toBe('bypassPermissions'), { timeout: 5000 });

            runs[0].run.resolve();
            await launcher;
        });

        it('lands the mode BEFORE the message that came with it, on the inbox socket', async () => {
            // The whole complaint in one line: a turn started from the phone
            // must not run under the mode the session had before the pick.
            mockFindInbox.mockResolvedValue(inbox);
            mockSendToInbox.mockImplementation(async () => { callLog.push('inbox'); return 'ok'; });
            const runs = trackRuns();
            paneCycle(['default', 'bypassPermissions'], 'default');
            const { session, queue, emitMetadata } = paneSession({ permissionMode: 'default' });

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            // The composer's own order: pick Yolo, then hit send.
            emitMetadata({ permissionMode: 'bypassPermissions' });
            queue.push('go', mode);

            await vi.waitFor(() => expect(callLog).toContain('inbox'), { timeout: 5000 });
            expect(callLog).toEqual(['cycle:bypassPermissions', 'inbox']);

            runs[0].run.resolve();
            await launcher;
        });

        it('lands the mode BEFORE the message on the pane paste path too', async () => {
            // No socket to find — an older Claude, or a stale registry record.
            // The keyboard is the carrier there, and the ordering rule is the
            // same one.
            mockFindInbox.mockResolvedValue(null);
            mockInjectIntoPane.mockImplementation(async () => { callLog.push('paste'); return true; });
            const runs = trackRuns();
            paneCycle(['default', 'bypassPermissions'], 'default');
            const { session, queue, emitMetadata } = paneSession({ permissionMode: 'default' });

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            emitMetadata({ permissionMode: 'bypassPermissions' });
            queue.push('go', mode);

            await vi.waitFor(() => expect(callLog).toContain('paste'), { timeout: 5000 });
            expect(callLog).toEqual(['cycle:bypassPermissions', 'paste']);

            runs[0].run.resolve();
            await launcher;
        });

        it('presses nothing while the pane is busy, and cycles when the prompt opens', async () => {
            const runs = trackRuns();
            const cycle = paneCycle(['default', 'bypassPermissions'], 'default');
            const { session, emitMetadata } = paneSession({ permissionMode: 'default' });
            mockPaneIsIdle.mockResolvedValue(false);

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            emitMetadata({ permissionMode: 'bypassPermissions' });
            await new Promise((r) => setTimeout(r, 50));
            expect(mockPressCycleKey).not.toHaveBeenCalled();

            mockPaneIsIdle.mockResolvedValue(true);
            await vi.waitFor(() => expect(cycle.at()).toBe('bypassPermissions'), { timeout: 5000 });

            runs[0].run.resolve();
            await launcher;
        });

        it('says so on the phone when the mode is not in this session\'s cycle, and puts the pane back', async () => {
            // Bypass disabled by settings: it is simply absent from the ring.
            // Leaving the pane on whatever the last press reached would change
            // a mode nobody picked.
            const runs = trackRuns();
            const cycle = paneCycle(['plan', 'default', 'acceptEdits'], 'acceptEdits');
            const { session, emitMetadata } = paneSession({ permissionMode: 'default' });

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            emitMetadata({ permissionMode: 'bypassPermissions' });

            await vi.waitFor(() => expect(session.client.sendSessionEvent).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining('cannot switch to bypassPermissions'),
                }),
            ), { timeout: 8000 });
            expect(cycle.at()).toBe('acceptEdits');

            runs[0].run.resolve();
            await launcher;
        });

        it('presses nothing at all when it cannot see a prompt to press at', async () => {
            const runs = trackRuns();
            const { session, emitMetadata } = paneSession({ permissionMode: 'default' });
            mockReadPaneMode.mockResolvedValue(null);

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            emitMetadata({ permissionMode: 'bypassPermissions' });
            await new Promise((r) => setTimeout(r, 100));
            expect(mockPressCycleKey).not.toHaveBeenCalled();

            runs[0].run.resolve();
            await launcher;
        });
    });

    it('takes a message off the queue once the inbox socket has it', async () => {
        mockFindInbox.mockResolvedValue(inbox);
        mockSendToInbox.mockResolvedValue('ok');
        const runs = trackRuns();
        const { session, queue } = paneSession();

        const launcher = claudeLocalLauncher(session as any);
        await vi.waitFor(() => expect(runs).toHaveLength(1));

        queue.push('from the phone', mode);
        await vi.waitFor(() => expect(queue.size()).toBe(0));

        // The socket, not the keyboard: it queues inside Claude and is served
        // between tool calls, so it is safe while a turn is running.
        expect(mockSendToInbox).toHaveBeenCalledWith(inbox, 'from the phone', claudeSessionId);
        expect(mockInjectIntoPane).not.toHaveBeenCalled();
        expect(runs[0].opts.abort.aborted).toBe(false);

        runs[0].run.resolve();
        await expect(launcher).resolves.toEqual({ type: 'exit', code: 0 });
    });

    it('sends a terminal-queued prompt to the app, but not its own echo (DROVE-41)', async () => {
        // A message typed while Claude is busy is queued inside Claude Code
        // and only ever recorded as queue/attachment records, so nothing used
        // to carry it to the app. The scanner reports it now — but everything
        // WE put in the pane comes back through the same records, and the app
        // is already showing those: it sent them.
        mockFindInbox.mockResolvedValue(inbox);
        mockSendToInbox.mockResolvedValue('ok');
        const runs = trackRuns();
        const { session, queue } = paneSession();

        const launcher = claudeLocalLauncher(session as any);
        await vi.waitFor(() => expect(runs).toHaveLength(1));
        const scannerOpts = mockCreateSessionScanner.mock.calls.at(-1)![0];

        queue.push('from the phone', mode);
        await vi.waitFor(() => expect(mockSendToInbox).toHaveBeenCalled());

        // Both records one delivery produces are swallowed, not just the first.
        scannerOpts.onQueuedPrompt({ text: 'from the phone', at: 1788113356575, carrier: 'enqueue' });
        scannerOpts.onQueuedPrompt({ text: 'from the phone', at: 1788113421656, carrier: 'absorbed' });
        expect(session.client.sendQueuedPromptFromLocalTranscript).not.toHaveBeenCalled();

        scannerOpts.onQueuedPrompt({ text: 'typed at the keyboard', at: 1788113356600, carrier: 'enqueue' });
        expect(session.client.sendQueuedPromptFromLocalTranscript).toHaveBeenCalledWith({
            text: 'typed at the keyboard',
            at: 1788113356600,
            carrier: 'enqueue',
        });
        expect(session.client.sendQueuedPromptFromLocalTranscript).toHaveBeenCalledTimes(1);

        runs[0].run.resolve();
        await expect(launcher).resolves.toEqual({ type: 'exit', code: 0 });
    });

    it('stages a phone image to uploads/ and hands Claude the path (DROVE-38)', async () => {
        // Remote mode turned attachments into SDK image blocks; the pane path
        // dropped them after decrypting. Both pane carriers are text, so the
        // bytes go to <config dir>/uploads/<session>/ and the path rides the
        // message.
        const { mkdtempSync, existsSync, readFileSync, rmSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const configDir = mkdtempSync(join(tmpdir(), 'drover-cfg-'));
        try {
            mockFindInbox.mockResolvedValue(inbox);
            mockSendToInbox.mockResolvedValue('ok');
            const runs = trackRuns();
            const { session, queue } = paneSession();
            (session as any).claudeEnvVars = { CLAUDE_CONFIG_DIR: configDir };

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
            queue.push('can you see my screenshot', mode, [{ data: png, mimeType: 'image/heic', name: 'IMG_1.HEIC' }]);
            await vi.waitFor(() => expect(queue.size()).toBe(0));

            const [, text] = mockSendToInbox.mock.calls[0];
            const match = /\[Image 1: (.+\.png)\]/.exec(text);
            expect(match, text).not.toBeNull();
            const path = match![1];
            expect(path.startsWith(join(configDir, 'uploads', claudeSessionId))).toBe(true);
            expect(existsSync(path)).toBe(true);
            expect(readFileSync(path)).toEqual(Buffer.from(png));
            expect(text).toContain('can you see my screenshot');
            expect(text).toContain('Read it with the Read tool');

            runs[0].run.resolve();
            await expect(launcher).resolves.toEqual({ type: 'exit', code: 0 });
        } finally {
            rmSync(configDir, { recursive: true, force: true });
        }
    });

    it('falls through to the pane when the socket is gone', async () => {
        mockFindInbox.mockResolvedValue(inbox);
        mockSendToInbox.mockResolvedValue('gone');
        mockInjectIntoPane.mockResolvedValue(true);
        const runs = trackRuns();
        const { session, queue } = paneSession();

        const launcher = claudeLocalLauncher(session as any);
        await vi.waitFor(() => expect(runs).toHaveLength(1));

        queue.push('from the phone', mode);
        await vi.waitFor(() => expect(mockInjectIntoPane).toHaveBeenCalledWith(pane, 'from the phone'));
        await vi.waitFor(() => expect(queue.size()).toBe(0));

        runs[0].run.resolve();
        await expect(launcher).resolves.toEqual({ type: 'exit', code: 0 });
    });

    it('exits when the child exits, even with a message still on the queue', async () => {
        // The bug in one line: an undelivered message used to mean "switch",
        // so quitting claude handed the session to remote mode instead of
        // ending it, and the message was replayed there as a fresh turn.
        mockFindInbox.mockResolvedValue(null);
        mockInjectIntoPane.mockResolvedValue(false);
        const runs = trackRuns();
        const { session, queue } = paneSession();

        const launcher = claudeLocalLauncher(session as any);
        await vi.waitFor(() => expect(runs).toHaveLength(1));

        queue.push('from the phone', mode);
        await vi.waitFor(() => expect(session.pendingInitialPrompt).toBe('from the phone'));
        expect(queue.size()).toBe(1);

        runs[0].run.resolve();
        await expect(launcher).resolves.toEqual({ type: 'exit', code: 0 });
        expect(session.client.closeClaudeSessionTurn).toHaveBeenCalledWith('completed');
    });

    it('propagates a non-zero exit code instead of switching', async () => {
        mockFindInbox.mockResolvedValue(null);
        mockInjectIntoPane.mockResolvedValue(false);
        const runs = trackRuns();
        const { session, queue } = paneSession();

        const launcher = claudeLocalLauncher(session as any);
        await vi.waitFor(() => expect(runs).toHaveLength(1));

        queue.push('from the phone', mode);
        await vi.waitFor(() => expect(queue.size()).toBe(1));

        const { ExitCodeError } = await import('./claudeLocal');
        runs[0].run.reject(new ExitCodeError(3));
        await expect(launcher).resolves.toEqual({ type: 'exit', code: 3 });
    });

    it('holds a message it cannot deliver, with subagents running, and opens the next child with it', async () => {
        // The worst of the four: a declined injection called doSwitch(), which
        // with agents in flight armed a deferred switch — so the moment the
        // last agent reported in, the child Clay was watching was SIGTERMed.
        mockFindInbox.mockResolvedValue(null);
        mockInjectIntoPane.mockResolvedValue(false);
        const runs = trackRuns();
        let scannerOnMessage: ((message: any) => void) | undefined;
        mockCreateSessionScanner.mockImplementation(async (opts: any) => {
            scannerOnMessage = opts.onMessage;
            return { onNewSession: vi.fn(), cleanup: vi.fn(async () => {}) };
        });
        const { session, queue } = paneSession();

        const launcher = claudeLocalLauncher(session as any);
        await vi.waitFor(() => expect(runs).toHaveLength(1));
        scannerOnMessage!(asyncAgentLaunched('agent-7'));

        queue.push('from the phone', mode);
        await vi.waitFor(() => expect(session.pendingInitialPrompt).toBe('from the phone'));

        // Nothing was stopped, and nothing announced a switch it was holding.
        expect(runs[0].opts.abort.aborted).toBe(false);
        expect(session.client.sendSessionEvent).not.toHaveBeenCalledWith(
            expect.objectContaining({ message: expect.stringContaining('holding the switch to remote') }),
        );

        // The child dies on its own; the held message opens its replacement.
        runs[0].run.reject(new Error('claude fell over'));
        await vi.waitFor(() => expect(runs).toHaveLength(2));
        expect(runs[1].opts.initialPrompt).toBe('from the phone');
        expect(session.pendingInitialPrompt).toBeUndefined();
        expect(queue.size()).toBe(0);

        runs[1].run.resolve();
        await expect(launcher).resolves.toEqual({ type: 'exit', code: 0 });
    });

    /**
     * DROVE-13. The fifth way the phone took the terminal, and the loudest:
     * pressing Stop. Upstream's doAbort SIGTERMed the child and set
     * `{type:'switch'}`, so a button the app labels "cancel the active turn"
     * killed the TUI and handed the session to a headless run.
     */
    describe('Stop from the phone', () => {
        /** The handler the app's `abort` RPC actually calls. */
        function abortHandler(session: any): () => Promise<void> {
            const call = session.client.rpcHandlerManager.registerHandler.mock.calls
                .find(([name]: [string]) => name === 'abort');
            expect(call, 'no abort handler registered').toBeDefined();
            return call[1];
        }

        it('cancels the turn with an Escape and leaves the child running', async () => {
            mockInterruptPane.mockResolvedValue('cancelled');
            const runs = trackRuns();
            const { session } = paneSession();

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            await abortHandler(session)();

            expect(mockInterruptPane).toHaveBeenCalledWith(
                expect.objectContaining({ pane, claudeSessionId }),
            );
            // The three things Stop must not do: kill the child, end the
            // launcher, or hand the session to remote mode.
            expect(runs[0].opts.abort.aborted).toBe(false);
            expect(runs).toHaveLength(1);
            expect(session.client.closeClaudeSessionTurn).toHaveBeenCalledWith('cancelled');

            // ...and the session is still there for the next message.
            runs[0].run.resolve();
            await expect(launcher).resolves.toEqual({ type: 'exit', code: 0 });
        });

        it('still does not kill the child when the pane refuses the interrupt', async () => {
            mockInterruptPane.mockResolvedValue('unavailable');
            const runs = trackRuns();
            const { session } = paneSession();

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            await abortHandler(session)();

            expect(runs[0].opts.abort.aborted).toBe(false);
            expect(session.client.sendSessionEvent).toHaveBeenCalledWith(
                expect.objectContaining({ message: expect.stringContaining('no turn to stop') }),
            );

            runs[0].run.resolve();
            await expect(launcher).resolves.toEqual({ type: 'exit', code: 0 });
        });

        it('leaves a message that is still queued alone', async () => {
            // Stop is about the turn in flight. A message held for the next
            // child never ran, so cancelling does not un-send it.
            mockInterruptPane.mockResolvedValue('cancelled');
            mockFindInbox.mockResolvedValue(null);
            mockInjectIntoPane.mockResolvedValue(false);
            const runs = trackRuns();
            const { session, queue } = paneSession();

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));
            queue.push('from the phone', mode);
            await vi.waitFor(() => expect(queue.size()).toBe(1));

            await abortHandler(session)();

            expect(queue.size()).toBe(1);

            runs[0].run.resolve();
            await expect(launcher).resolves.toEqual({ type: 'exit', code: 0 });
        });

        it('a flip still gets the child killed, because it has to relaunch it', async () => {
            // Stop and a flip share the word "abort" and nothing else. The flip
            // goes through setAbortHandler, so softening Stop must not soften it.
            mockInterruptPane.mockResolvedValue('cancelled');
            const runs = trackRuns();
            const { session } = paneSession();
            let flipAbort: (() => void) | null = null;
            (session as any).flip = {
                setAbortHandler: (fn: (() => void) | null) => { flipAbort = fn; },
                setInFlightProbe: vi.fn(),
                hasPending: () => false,
                take: () => null,
                request: vi.fn(),
            };

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            expect(flipAbort).toBeTruthy();
            flipAbort!();

            expect(runs[0].opts.abort.aborted).toBe(true);
            expect(mockInterruptPane).not.toHaveBeenCalled();

            runs[0].run.resolve();
            await launcher;
        });
    });
});

/**
 * The tool_result Claude Code writes when an async Agent starts, trimmed to the
 * sentence InFlightTracker keys off. Copied from a real transcript.
 */
function asyncAgentLaunched(id: string) {
    return {
        type: 'user',
        isSidechain: false,
        message: {
            role: 'user',
            content: [{
                tool_use_id: `toolu_${id}`,
                type: 'tool_result',
                content: [{
                    type: 'text',
                    text: 'Async agent launched successfully.\n'
                        + `agentId: ${id} (internal ID - do not mention to user.)\n`
                        + 'The agent is working in the background.',
                }],
            }],
        },
        uuid: `uuid-${id}`,
        toolUseResult: {
            isAsync: true,
            status: 'async_launched',
            agentId: id,
            description: 'Build the thing',
        },
    };
}
