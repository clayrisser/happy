import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const {
    mockClaudeLocal,
    mockCreateSessionScanner,
    mockInjectIntoPane,
    mockPaneIsIdle,
    mockPaneAcceptsCommand,
    mockCapturePane,
    mockPressPaneKey,
    mockFindInbox,
    mockSendToInbox,
    mockInterruptPane,
    mockClaudeRemoteLauncher,
    mockReadPaneMode,
    mockReadPaneModeChip,
    mockPressCycleKey,
    callLog,
} = vi.hoisted(() => ({
    mockClaudeLocal: vi.fn(),
    mockCreateSessionScanner: vi.fn(),
    mockInjectIntoPane: vi.fn(),
    mockPaneIsIdle: vi.fn(async () => true),
    // DROVE-164: the picker's commands take this gate instead. It does NOT
    // wait for the turn to end, so it is open by default here the way the
    // pane really behaves.
    mockPaneAcceptsCommand: vi.fn(async () => true),
    // What the pane shows when the launcher reads its command back. An empty
    // screen parses as "nothing came back", which is the pending path, so a
    // test that does not care about the outcome is unaffected by the readback.
    mockCapturePane: vi.fn(async (): Promise<string | null> => null),
    mockPressPaneKey: vi.fn(async () => true),
    mockFindInbox: vi.fn(),
    mockSendToInbox: vi.fn(),
    mockInterruptPane: vi.fn(),
    mockClaudeRemoteLauncher: vi.fn(async () => 'exit' as const),
    mockReadPaneMode: vi.fn(),
    mockReadPaneModeChip: vi.fn(),
    mockPressCycleKey: vi.fn(),
    // DROVE-36 is partly a question of ORDER — did the mode reach the pane
    // before the message that came with it — and per-mock call counts cannot
    // answer that. One log, in the order things actually happened.
    callLog: [] as string[],
}));

// Only the loop-level test below reaches this. It is the takeover DROVE-33
// is about, so it is a spy that must stay uncalled rather than a real run.
vi.mock('./claudeRemoteLauncher', () => ({
    claudeRemoteLauncher: mockClaudeRemoteLauncher,
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

// DROVE-48 removed injectIntoPaneGated with the message fallback it existed
// for, so what is left here is the KEYSTROKE surface: the slash commands the
// phone's pickers send (DROVE-45) and the Escape that Stop sends (DROVE-13).
// mockInjectIntoPane standing in for the only paste path is what lets the
// tests below assert that a phone MESSAGE never reaches tmux at all.
vi.mock('./utils/paneInject', () => ({
    injectIntoPane: mockInjectIntoPane,
    // DROVE-45 types slash commands through the raw inject plus its own idle
    // check. Idle by default here so a queued /model is not held forever; the
    // model-routing tests below override it.
    paneIsIdle: mockPaneIsIdle,
    // DROVE-164: model and effort no longer wait for idle, and the launcher
    // reads the pane back instead of assuming the keystrokes worked.
    paneAcceptsCommand: mockPaneAcceptsCommand,
    capturePane: mockCapturePane,
    pressPaneKey: mockPressPaneKey,
    interruptPane: mockInterruptPane,
}));

// The real `wrapForPane` rides along on purpose (DROVE-49): the echo the
// launcher has to swallow is the WRAPPED text coming back off the transcript,
// so a stub here would test the stub.
vi.mock('./utils/inboxSocket', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./utils/inboxSocket')>()),
    findInbox: mockFindInbox,
    sendToInbox: mockSendToInbox,
}));

// DROVE-36. Only the two tmux calls are faked: the cycle loop itself is the
// real one, because "press, read back, press again" is the whole design and a
// fake of it would prove nothing about the launcher's use of it.
vi.mock('./utils/panePermissionSync', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./utils/panePermissionSync')>()),
    readPaneMode: mockReadPaneMode,
    // DROVE-199: the watcher's read is the CHIP only, so it is its own seam.
    readPaneModeChip: mockReadPaneModeChip,
    pressCycleKey: mockPressCycleKey,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        infoDeveloper: vi.fn(),
    },
}));

import { claudeLocalLauncher } from './claudeLocalLauncher';
import { loop } from './loop';
import type { Session } from './session';
import { appSenderName } from './utils/inboxSocket';
import { MessageQueue2 } from '@/utils/MessageQueue2';

type QueueHandler = (message: string, mode: { permissionMode: 'default' }) => void;
type ScannerOptions = {
    sessionId: string | null;
    workingDirectory: string;
    onMessage: (message: any) => void;
    onAgentNotification?: (notification: any) => void;
    onRunObserved?: (run: { model: string; effort: string | null }) => void;
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
        session,
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

    it('registers no goal carrier for a PANELESS session, because there is no prompt to type at', async () => {
        // DROVE-78: absent is the honest answer. runClaude turns it into "this
        // session has no pane to run /goal in" rather than offering the app a
        // button that throws.
        const started = await startLauncher({ sessionId: 'claude-session-paneless' });
        expect((started.session as any).paneSlashCommandCarrier).toBeUndefined();
        await started.finish();
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

    /**
     * DROVE-115. An async agent's Agent tool call ends at LAUNCH, so its card
     * on the phone had no second result to move it off "Running" and a
     * finished agent sat there for the rest of the session. The completion
     * reaches the scanner as a task-notification; this is the launcher turning
     * it into the terminal result for that same call.
     */
    it('sends a terminal tool-call-end when a background agent reports', async () => {
        const localRun = createDeferred<void>();
        let scannerOptions: ScannerOptions | undefined;

        mockCreateSessionScanner.mockImplementation(async (opts: ScannerOptions) => {
            scannerOptions = opts;
            return { onNewSession: vi.fn(), cleanup: vi.fn(async () => {}) };
        });
        mockClaudeLocal.mockImplementation(async () => {
            await localRun.promise;
        });

        const sendClaudeAgentStop = vi.fn();
        const session = {
            sessionId: 'claude-session-115',
            path: '/tmp/project',
            client: {
                sendClaudeSessionMessage: vi.fn(),
                sendClaudeSessionMessageFromLocalTranscript: vi.fn(async () => {}),
                sendClaudeAgentStop,
                closeClaudeSessionTurn: vi.fn(),
                rpcHandlerManager: { registerHandler: vi.fn() },
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
        await vi.waitFor(() => { expect(scannerOptions).toBeDefined(); });

        // The launch is the only place the agent id and its Agent tool call
        // are named together, and the notification below deliberately does not
        // name the call, so this is what makes it addressable.
        scannerOptions!.onMessage(asyncAgentLaunched('agent-115'));
        scannerOptions!.onAgentNotification?.({
            agentId: 'agent-115',
            status: 'completed',
            terminal: true,
            succeeded: true,
            result: 'Pushed as 55c43f95.',
            at: Date.now(),
        });

        await vi.waitFor(() => { expect(sendClaudeAgentStop).toHaveBeenCalledTimes(1); });
        expect(sendClaudeAgentStop.mock.calls[0][0]).toMatchObject({
            call: 'toolu_agent-115',
            isError: false,
            result: { agentId: 'agent-115', status: 'completed', content: [{ type: 'text', text: 'Pushed as 55c43f95.' }] },
        });

        // A progress note must never settle a card, and an agent nothing knows
        // a call for is left alone rather than addressed at a guess.
        scannerOptions!.onAgentNotification?.({ agentId: 'agent-115', status: 'progress', terminal: false, succeeded: false, at: Date.now() });
        scannerOptions!.onAgentNotification?.({ agentId: 'agent-unknown', status: 'completed', terminal: true, succeeded: true, at: Date.now() });
        expect(sendClaudeAgentStop).toHaveBeenCalledTimes(1);

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
        mockReadPaneModeChip.mockResolvedValue('default');
        mockPressCycleKey.mockResolvedValue(true);
        // And an open prompt. `vi.clearAllMocks` clears CALLS, not
        // implementations, so a test that closed the gate used to leave it
        // closed for whatever ran next — which is how three Remote Control
        // specs came to depend on the gate a permission-mode spec had set.
        mockPaneIsIdle.mockResolvedValue(true);
        mockPaneAcceptsCommand.mockResolvedValue(true);
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
        mockReadPaneModeChip.mockImplementation(async () => ring[index]);
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
            // DROVE-78: written by the launcher (the pane's carrier for a
            // slash command the app raised over RPC) and read by it (where a
            // goal_status record off this pane's transcript goes).
            paneSlashCommandCarrier: undefined as ((command: string) => Promise<boolean>) | null | undefined,
            onGoalStatusEvent: undefined as ((event: any) => void) | null | undefined,
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

        it('holds the command while something is typed in the input box', async () => {
            // The one thing that must never happen: `/model x` landing in the
            // middle of Clay's own line. That is what `paneAcceptsCommand`
            // checks, and DROVE-164 is the discovery that it is the WHOLE
            // check — waiting for the turn to end as well was not caution, it
            // was a gate that never opened in a session anyone was working.
            const runs = trackRuns();
            const { session, emitMetadata } = paneSession({});
            mockInjectIntoPane.mockResolvedValue(true);
            mockPaneAcceptsCommand.mockResolvedValue(false);

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            emitMetadata({ modelMode: 'claude-sonnet-5' });
            await new Promise((r) => setTimeout(r, 50));
            expect(mockInjectIntoPane).not.toHaveBeenCalled();

            // ...and it goes in the moment the box is clear.
            mockPaneAcceptsCommand.mockResolvedValue(true);
            await vi.waitFor(() => expect(mockInjectIntoPane).toHaveBeenCalledWith(
                pane, '/model claude-sonnet-5', { submit: true },
            ), { timeout: 5000 });

            runs[0].run.resolve();
            await launcher;
        });

        it('types the pick MID-TURN rather than waiting for a prompt that never opens', async () => {
            // DROVE-164, and the whole of it. Clay's own log for 2026-08-31 has
            // `/effort max` queued at 05:40:59 and still held at 08:06, 4454
            // "pane is busy" lines later, because a session being worked is
            // never idle. Measured on 2.1.251: a `/effort` pasted while a turn
            // is streaming runs immediately and the turn carries on.
            const runs = trackRuns();
            const { session, emitMetadata } = paneSession({});
            mockInjectIntoPane.mockResolvedValue(true);
            mockPaneIsIdle.mockResolvedValue(false);
            mockPaneAcceptsCommand.mockResolvedValue(true);

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            emitMetadata({ effortLevel: 'ultracode' });
            await vi.waitFor(() => expect(mockInjectIntoPane).toHaveBeenCalledWith(
                pane, '/effort ultracode', { submit: true },
            ), { timeout: 5000 });
            expect(mockPaneIsIdle).not.toHaveBeenCalled();

            mockPaneIsIdle.mockResolvedValue(true);
            runs[0].run.resolve();
            await launcher;
        });

        it('answers the confirmation Claude Code puts up, instead of leaving it on screen', async () => {
            // Measured on 2.1.251: every `/effort` at an idle prompt on a
            // conversation with history draws "Change effort level?" and waits.
            // Nobody was pressing that Enter, so the pick stopped there while
            // the app was told it had landed.
            const runs = trackRuns();
            const { session, emitMetadata, readMetadata } = paneSession({});
            mockInjectIntoPane.mockResolvedValue(true);
            const rule = '\u2500'.repeat(40);
            const idleScreen = [rule, '\u276f ', rule].join('\n');
            const dialog = ['   Change effort level?', '   \u276f 1. Yes, switch to max'].join('\n');
            const applied = ['  \u23bf  Set effort level to max (this session only)', rule, '\u276f ', rule].join('\n');
            let answered = false;
            mockCapturePane.mockImplementation(async () => (answered ? applied : idleScreen + '\n' + dialog));
            mockPressPaneKey.mockImplementation(async () => { answered = true; return true; });

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            emitMetadata({ effortLevel: 'max' });
            await vi.waitFor(() => expect(mockPressPaneKey).toHaveBeenCalledWith(pane, 'Enter'), { timeout: 5000 });
            await vi.waitFor(() => expect(readMetadata().paneEffort).toBe('max'), { timeout: 5000 });

            mockCapturePane.mockResolvedValue(null);
            mockPressPaneKey.mockResolvedValue(true);
            runs[0].run.resolve();
            await launcher;
        });

        it('tells the phone in the pane\'s own words when the level is refused', async () => {
            // A level the harness will not take must never look accepted. The
            // pill stays where it was and the reason is said out loud.
            const runs = trackRuns();
            const { session, emitMetadata } = paneSession({});
            mockInjectIntoPane.mockResolvedValue(true);
            const rule = '\u2500'.repeat(40);
            const refusal = [
                "  \u23bf  Ultracode runs at xhigh effort, which claude-opus-4-6 doesn't support \u2014 switch to an xhigh-capable model (Fable 5, Opus 4.7+, Sonnet 5).",
                rule, '\u276f ', rule,
            ].join('\n');
            let typed = false;
            mockCapturePane.mockImplementation(async () => (typed ? refusal : [rule, '\u276f ', rule].join('\n')));
            mockInjectIntoPane.mockImplementation(async () => { typed = true; return true; });

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            emitMetadata({ effortLevel: 'ultracode' });
            await vi.waitFor(() => expect(session.client.sendSessionEvent).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'message',
                    message: expect.stringContaining("doesn't support"),
                }),
            ), { timeout: 5000 });

            mockCapturePane.mockResolvedValue(null);
            mockInjectIntoPane.mockResolvedValue(true);
            runs[0].run.resolve();
            await launcher;
        });

        it('does not type a pick the pane is already running back into the pane (DROVE-77)', async () => {
            // Clay typed /model and /effort at the keyboard. The scanner
            // reported the run, the app wrote the same values into
            // modelMode/effortLevel, and the metadata event came back round
            // and queued `/model claude-fable-5` and `/effort ultracode` to be
            // typed into his prompt. The pick equals the OBSERVED run, so it
            // is not a change and nothing may reach the pane.
            const runs = trackRuns();
            let scannerOptions: ScannerOptions | undefined;
            mockCreateSessionScanner.mockImplementation(async (opts: ScannerOptions) => {
                scannerOptions = opts;
                return { onNewSession: vi.fn(), cleanup: vi.fn(async () => {}) };
            });
            const { session, emitMetadata } = paneSession({});
            mockInjectIntoPane.mockResolvedValue(true);
            mockPaneIsIdle.mockResolvedValue(true);

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));
            await vi.waitFor(() => expect(scannerOptions?.onRunObserved).toBeTypeOf('function'));

            scannerOptions!.onRunObserved!({ model: 'claude-fable-5', effort: 'ultracode' });
            emitMetadata({ modelMode: 'claude-fable-5', effortLevel: 'ultracode' });
            await new Promise((r) => setTimeout(r, 80));
            expect(mockInjectIntoPane).not.toHaveBeenCalled();

            // A REAL change still goes through, so the guard is not a mute.
            emitMetadata({ modelMode: 'claude-sonnet-5' });
            await vi.waitFor(() => expect(mockInjectIntoPane).toHaveBeenCalledWith(
                pane, '/model claude-sonnet-5', { submit: true },
            ));

            runs[0].run.resolve();
            await launcher;
        });

        it('withdraws a held command once the pane is seen running that value (DROVE-77)', async () => {
            // Held while the pane is busy, then Clay types the same /model
            // himself. When the prompt opens, the stale command must not be
            // typed on top of what he just did.
            const runs = trackRuns();
            let scannerOptions: ScannerOptions | undefined;
            mockCreateSessionScanner.mockImplementation(async (opts: ScannerOptions) => {
                scannerOptions = opts;
                return { onNewSession: vi.fn(), cleanup: vi.fn(async () => {}) };
            });
            const { session, emitMetadata } = paneSession({});
            mockInjectIntoPane.mockResolvedValue(true);
            mockPaneAcceptsCommand.mockResolvedValue(false);

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));
            await vi.waitFor(() => expect(scannerOptions?.onRunObserved).toBeTypeOf('function'));

            emitMetadata({ modelMode: 'claude-sonnet-5' });
            await new Promise((r) => setTimeout(r, 50));
            expect(mockInjectIntoPane).not.toHaveBeenCalled();

            scannerOptions!.onRunObserved!({ model: 'claude-sonnet-5', effort: null });
            emitMetadata({ modelMode: 'claude-sonnet-5' });
            mockPaneAcceptsCommand.mockResolvedValue(true);
            await new Promise((r) => setTimeout(r, 300));
            expect(mockInjectIntoPane).not.toHaveBeenCalled();

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

        it('says the pane is on the new model as soon as the pane says so', async () => {
            // It used to say so as soon as the keystrokes went in, which is
            // how a refused command still moved the chip (DROVE-164). Now the
            // pane's own answer is what moves it.
            const runs = trackRuns();
            const { session, emitMetadata, readMetadata } = paneSession({ modelMode: 'claude-opus-5' });
            const rule = '\u2500'.repeat(40);
            const applied = ['  \u23bf  Set model to claude-sonnet-5', rule, '\u276f ', rule].join('\n');
            let typed = false;
            mockCapturePane.mockImplementation(async () => (typed ? applied : [rule, '\u276f ', rule].join('\n')));
            mockInjectIntoPane.mockImplementation(async () => { typed = true; return true; });

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            emitMetadata({ modelMode: 'claude-sonnet-5' });
            await vi.waitFor(() => expect(readMetadata().paneModel).toBe('claude-sonnet-5'), { timeout: 5000 });

            mockCapturePane.mockResolvedValue(null);
            mockInjectIntoPane.mockResolvedValue(true);
            runs[0].run.resolve();
            await launcher;
        });

        /**
         * DROVE-191. `paneModel`/`paneEffort` tracked the terminal, `modelMode`
         * did not, and both the app's "did this change?" test and this
         * launcher's delta ran against `modelMode`. So the moment the pane
         * moved on its own the picker went dead: the row showed Sonnet 5 and
         * tapping Opus 5 [1M] matched a stale request and sent nothing.
         */
        describe('when the pane moves under the app', () => {
            it('mirrors the pane back into the request, so the next pick is a change again', async () => {
                const runs = trackRuns();
                let scannerOptions: ScannerOptions | undefined;
                mockCreateSessionScanner.mockImplementation(async (opts: ScannerOptions) => {
                    scannerOptions = opts;
                    return { onNewSession: vi.fn(), cleanup: vi.fn(async () => {}) };
                });
                const { session, emitMetadata, readMetadata } = paneSession({ modelMode: 'claude-opus-5[1m]' });
                const rule = '\u2500'.repeat(40);
                const applied = ['  \u23bf  Set model to Opus 5 [1M]', rule, '\u276f ', rule].join('\n');
                let typed = false;
                mockCapturePane.mockImplementation(async () => (typed ? applied : [rule, '\u276f ', rule].join('\n')));
                mockInjectIntoPane.mockImplementation(async () => { typed = true; return true; });

                const launcher = claudeLocalLauncher(session as any);
                await vi.waitFor(() => expect(runs).toHaveLength(1));
                await vi.waitFor(() => expect(scannerOptions?.onRunObserved).toBeTypeOf('function'));

                // Clay typed `/model claude-sonnet-5` at his own keyboard.
                scannerOptions!.onRunObserved!({ model: 'claude-sonnet-5', effort: null });
                await vi.waitFor(() => expect(readMetadata().paneModel).toBe('claude-sonnet-5'), { timeout: 5000 });
                // The request follows it. Before this, it stayed on opus[1m].
                await vi.waitFor(() => expect(readMetadata().modelMode).toBe('claude-sonnet-5'), { timeout: 5000 });

                // And now tapping Opus 5 [1M] reaches the prompt.
                emitMetadata({ modelMode: 'claude-opus-5[1m]' });
                await vi.waitFor(
                    () => expect(mockInjectIntoPane).toHaveBeenCalledWith(
                        expect.anything(),
                        '/model claude-opus-5[1m]',
                        expect.anything(),
                    ),
                    { timeout: 5000 },
                );
                // The id, not "Opus 5 [1M] and saved as your default…".
                await vi.waitFor(() => expect(readMetadata().paneModel).toBe('claude-opus-5[1m]'), { timeout: 5000 });

                mockCapturePane.mockResolvedValue(null);
                mockInjectIntoPane.mockResolvedValue(true);
                runs[0].run.resolve();
                await launcher;
            });

            it('keeps a [1m] request the transcript cannot contradict, and types nothing', async () => {
                // The retype loop this ticket must not reintroduce. The
                // transcript reports `claude-opus-5` for the 1M variant too, so
                // mirroring it literally would drop the bracket and every
                // observation after would disagree with the app forever.
                const runs = trackRuns();
                let scannerOptions: ScannerOptions | undefined;
                mockCreateSessionScanner.mockImplementation(async (opts: ScannerOptions) => {
                    scannerOptions = opts;
                    return { onNewSession: vi.fn(), cleanup: vi.fn(async () => {}) };
                });
                const { session, readMetadata } = paneSession({ modelMode: 'claude-opus-5[1m]' });
                mockInjectIntoPane.mockResolvedValue(true);

                const launcher = claudeLocalLauncher(session as any);
                await vi.waitFor(() => expect(runs).toHaveLength(1));
                await vi.waitFor(() => expect(scannerOptions?.onRunObserved).toBeTypeOf('function'));

                scannerOptions!.onRunObserved!({ model: 'claude-opus-5', effort: null });
                await vi.waitFor(() => expect(readMetadata().paneModel).toBe('claude-opus-5'), { timeout: 5000 });
                scannerOptions!.onRunObserved!({ model: 'claude-opus-5', effort: null });
                await new Promise((r) => setTimeout(r, 100));

                expect(readMetadata().modelMode).toBe('claude-opus-5[1m]');
                expect(mockInjectIntoPane).not.toHaveBeenCalled();

                runs[0].run.resolve();
                await launcher;
            });

            it('stops asking for an effort the pane refused', async () => {
                // DROVE-191(3): the rollback moved `paneEffort` and left
                // `effortLevel: "turbo"` standing on the server, so the request
                // field said something that had never happened.
                const runs = trackRuns();
                const { session, emitMetadata, readMetadata } = paneSession({ effortLevel: 'high' });
                const rule = '\u2500'.repeat(40);
                const refusal = ["  \u23bf  Invalid argument: 'turbo' is not an effort level", rule, '\u276f ', rule].join('\n');
                let typed = false;
                mockCapturePane.mockImplementation(async () => (typed ? refusal : [rule, '\u276f ', rule].join('\n')));
                mockInjectIntoPane.mockImplementation(async () => { typed = true; return true; });

                const launcher = claudeLocalLauncher(session as any);
                await vi.waitFor(() => expect(runs).toHaveLength(1));

                emitMetadata({ effortLevel: 'turbo' });
                await vi.waitFor(() => expect(readMetadata().effortLevel).toBe(null), { timeout: 5000 });
                expect(readMetadata().paneEffort).toBe(null);

                mockCapturePane.mockResolvedValue(null);
                mockInjectIntoPane.mockResolvedValue(true);
                runs[0].run.resolve();
                await launcher;
            });
        });

        it('reports ultracode as ultracode, not as the xhigh the transcript records', async () => {
            // Claude Code runs ultracode as xhigh with dynamic workflows beside
            // it, and the transcript carries no field that tells them apart —
            // so a session set to Ultracode reported xHigh and the chip snapped
            // back, which read as the app refusing the pick (DROVE-101). The
            // composer's top rule is the only place the word is written down.
            const runs = trackRuns();
            let scannerOptions: ScannerOptions | undefined;
            mockCreateSessionScanner.mockImplementation(async (opts: ScannerOptions) => {
                scannerOptions = opts;
                return { onNewSession: vi.fn(), cleanup: vi.fn(async () => {}) };
            });
            const { session, readMetadata } = paneSession({});
            const rule = '\u2500'.repeat(40);
            mockCapturePane.mockResolvedValue([rule + ' ultracode \u2500', '\u276f ', rule].join('\n'));

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));
            await vi.waitFor(() => expect(scannerOptions?.onRunObserved).toBeTypeOf('function'));

            scannerOptions!.onRunObserved!({ model: 'claude-opus-5', effort: 'xhigh' });
            await vi.waitFor(() => expect(readMetadata().paneEffort).toBe('ultracode'), { timeout: 5000 });

            mockCapturePane.mockResolvedValue(null);
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

        // DROVE-36 also had a twin of the test above for the pane PASTE
        // fallback. DROVE-48 deleted that fallback: a socket miss is now a
        // reported failed delivery, never a bracketed paste that could land on
        // whichever pane holds focus. There is no second carrier left to order
        // the mode against, so the test went with the code it covered.

        it('cycles the pane MID-TURN, because the idle gate never opens on a session being worked', async () => {
            // DROVE-199. This is the hop the pick died on. `#permission-mode`
            // was the one picker command still queued behind `paneIsIdle`, on
            // the reasoning that a loop reading the pane back wants the screen
            // holding still — but idle is not that property, it is the TURN
            // being over, and DROVE-164 already measured what that costs: Clay
            // works his sessions, so the prompt is never idle and the padlock
            // never moved. A running turn changes neither the input box nor
            // the dialog, and the mode chip stays first in the footer.
            const runs = trackRuns();
            const cycle = paneCycle(['default', 'bypassPermissions'], 'default');
            const { session, emitMetadata, readMetadata } = paneSession({ permissionMode: 'default' });
            mockPaneIsIdle.mockResolvedValue(false);
            mockPaneAcceptsCommand.mockResolvedValue(true);

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            emitMetadata({ permissionMode: 'bypassPermissions' });

            await vi.waitFor(() => expect(cycle.at()).toBe('bypassPermissions'), { timeout: 5000 });
            await vi.waitFor(() => expect(readMetadata().panePermissionMode).toBe('bypassPermissions'));

            runs[0].run.resolve();
            await launcher;
        });

        it('presses nothing while a dialog is on screen, and cycles once it clears', async () => {
            // The safety property that survived the gate change. A shift+tab
            // aimed at an open dialog is a keystroke landing on whatever is
            // highlighted — the DROVE-80 mistake — and a half-typed line is
            // the other thing a keystroke can ruin. `paneAcceptsCommand`
            // checks exactly those two, and nothing about the turn.
            const runs = trackRuns();
            const cycle = paneCycle(['default', 'bypassPermissions'], 'default');
            const { session, emitMetadata, readMetadata } = paneSession({ permissionMode: 'default' });
            mockPaneAcceptsCommand.mockResolvedValue(false);

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            emitMetadata({ permissionMode: 'bypassPermissions' });
            await new Promise((r) => setTimeout(r, 50));
            expect(mockPressCycleKey).not.toHaveBeenCalled();

            mockPaneAcceptsCommand.mockResolvedValue(true);
            await vi.waitFor(() => expect(cycle.at()).toBe('bypassPermissions'), { timeout: 5000 });
            await vi.waitFor(() => expect(readMetadata().panePermissionMode).toBe('bypassPermissions'));

            runs[0].run.resolve();
            await launcher;
        });

        it('follows a shift+tab Clay pressed himself, without waiting for a turn', async () => {
            // DROVE-199, the second fault. The transcript's `permission-mode`
            // record is written as part of the state block around a PROMPT, so
            // a shift+tab at an idle prompt appends nothing and the padlock sat
            // on the previous turn's mode until he sent another message. The
            // footer says it the moment the key is pressed, so the launcher
            // watches the footer.
            //
            // And the REQUEST follows the pane, not the other way round
            // (DROVE-191's direction): leaving `permissionMode` on the mode he
            // just left is what made his next tap on that row a no-op.
            const runs = trackRuns();
            const { session, readMetadata } = paneSession({ permissionMode: 'bypassPermissions' });
            mockReadPaneMode.mockResolvedValue('bypassPermissions');
            mockReadPaneModeChip.mockResolvedValue('bypassPermissions');

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            // Clay presses shift+tab at his own keyboard.
            mockReadPaneModeChip.mockResolvedValue('plan');

            await vi.waitFor(() => expect(readMetadata().panePermissionMode).toBe('plan'), { timeout: 8000 });
            expect(readMetadata().permissionMode).toBe('plan');
            // Read, not pressed: the launcher must not answer an observation
            // with keystrokes of its own.
            expect(mockPressCycleKey).not.toHaveBeenCalled();

            runs[0].run.resolve();
            await launcher;
        }, 20000);

        it('keeps the app\'s own spelling of a mode the pane cannot spell differently', async () => {
            // `yolo` is Codex's word for `bypassPermissions` and the pane can
            // only ever report the latter. Rewriting the request to the pane's
            // word would flip the app's vocabulary under it for nothing — the
            // same rule the `[1m]` model variant gets.
            const runs = trackRuns();
            const { session, readMetadata } = paneSession({ permissionMode: 'yolo' });
            mockReadPaneModeChip.mockResolvedValue('bypassPermissions');

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));
            await vi.waitFor(() => expect(readMetadata().panePermissionMode).toBe('bypassPermissions'), { timeout: 8000 });

            expect(readMetadata().permissionMode).toBe('yolo');

            runs[0].run.resolve();
            await launcher;
        }, 20000);

        it('says so on the phone when the mode is not in this session\'s cycle, and puts the pane back', async () => {
            // Bypass disabled by settings: it is simply absent from the ring.
            // Leaving the pane on whatever the last press reached would change
            // a mode nobody picked.
            const runs = trackRuns();
            const cycle = paneCycle(['plan', 'default', 'acceptEdits'], 'acceptEdits');
            const { session, emitMetadata, readMetadata } = paneSession({ permissionMode: 'default' });

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            emitMetadata({ permissionMode: 'bypassPermissions' });

            await vi.waitFor(() => expect(session.client.sendSessionEvent).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining('cannot switch to bypassPermissions'),
                }),
            ), { timeout: 8000 });
            expect(cycle.at()).toBe('acceptEdits');
            // DROVE-199: and it stops ASKING for it. The pane was walked back
            // to where it started, so a request still reading
            // `bypassPermissions` is a value that never happened — the same
            // false field DROVE-191 found standing after a refused `/effort`.
            await vi.waitFor(() => expect(readMetadata().permissionMode).toBe('acceptEdits'), { timeout: 8000 });
            expect(readMetadata().panePermissionMode).toBe('acceptEdits');

            runs[0].run.resolve();
            await launcher;
        }, 20000);

        it('presses nothing at all when it cannot see a prompt to press at', async () => {
            const runs = trackRuns();
            const { session, emitMetadata } = paneSession({ permissionMode: 'default' });
            mockReadPaneMode.mockResolvedValue(null);
            mockReadPaneModeChip.mockResolvedValue(null);

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            emitMetadata({ permissionMode: 'bypassPermissions' });
            await new Promise((r) => setTimeout(r, 100));
            expect(mockPressCycleKey).not.toHaveBeenCalled();

            runs[0].run.resolve();
            await launcher;
        });
    });

    /**
     * DROVE-63. Same carrier, one command, and one difference that matters:
     * `/remote-control` is a TOGGLE. Measured in 2.1.251's command table —
     * `get description(){ return rc() ? "Disconnect Remote Control" : … }`,
     * `get argumentHint(){ return rc() ? void 0 : "[name]" }` — so there is no
     * on/off word to send and typing it blind flips whatever is there. Every
     * test below is about only typing it when the pane's real state is known
     * and is not the one the app asked for.
     */
    describe('the Remote Control toggle in the app', () => {
        /** Fake the transcript telling the launcher where the bridge is. */
        function observe(active: boolean) {
            const scannerOpts = mockCreateSessionScanner.mock.calls.at(-1)![0];
            scannerOpts.onRemoteControlObserved?.(active);
        }

        it('types /remote-control when the app asks for on and the pane is off', async () => {
            const runs = trackRuns();
            const { session, emitMetadata } = paneSession({});
            mockInjectIntoPane.mockResolvedValue(true);

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));
            observe(false);

            emitMetadata({ remoteControl: 'on' });

            await vi.waitFor(() => expect(mockInjectIntoPane).toHaveBeenCalledWith(
                pane, '/remote-control', { submit: true },
            ));

            runs[0].run.resolve();
            await launcher;
        });

        it('types it to turn Remote Control OFF as well — one command, both ways', async () => {
            const runs = trackRuns();
            const { session, emitMetadata } = paneSession({});
            mockInjectIntoPane.mockResolvedValue(true);

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));
            observe(true);

            emitMetadata({ remoteControl: 'off' });

            await vi.waitFor(() => expect(mockInjectIntoPane).toHaveBeenCalledWith(
                pane, '/remote-control', { submit: true },
            ));

            runs[0].run.resolve();
            await launcher;
        });

        it('types nothing when the pane is already where the app asked', async () => {
            // The idempotence question the ticket asked to measure, answered by
            // the caller rather than by the command: /remote-control is not
            // idempotent, so asking for `on` twice must not send it twice.
            const runs = trackRuns();
            const { session, emitMetadata } = paneSession({});
            mockInjectIntoPane.mockResolvedValue(true);

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));
            observe(true);

            emitMetadata({ remoteControl: 'on' });
            await new Promise((r) => setTimeout(r, 50));

            expect(mockInjectIntoPane).not.toHaveBeenCalled();

            runs[0].run.resolve();
            await launcher;
        });

        it('types nothing while the pane has not said where it is', async () => {
            // Unknown is not off. A toggle on a guess can silence the session
            // the tap was meant to wake.
            const runs = trackRuns();
            const { session, emitMetadata } = paneSession({});
            mockInjectIntoPane.mockResolvedValue(true);

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            emitMetadata({ remoteControl: 'on' });
            await new Promise((r) => setTimeout(r, 50));

            expect(mockInjectIntoPane).not.toHaveBeenCalled();

            runs[0].run.resolve();
            await launcher;
        });

        it('holds for the prompt rather than pasting the toggle mid-turn', async () => {
            const runs = trackRuns();
            const { session, emitMetadata } = paneSession({});
            mockInjectIntoPane.mockResolvedValue(true);
            mockPaneIsIdle.mockResolvedValue(false);

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));
            observe(false);

            emitMetadata({ remoteControl: 'on' });
            await new Promise((r) => setTimeout(r, 50));
            expect(mockInjectIntoPane).not.toHaveBeenCalled();

            mockPaneIsIdle.mockResolvedValue(true);
            await vi.waitFor(() => expect(mockInjectIntoPane).toHaveBeenCalledWith(
                pane, '/remote-control', { submit: true },
            ), { timeout: 5000 });

            runs[0].run.resolve();
            await launcher;
        });

        it('drops a held toggle when the terminal gets there first', async () => {
            // The failure only a toggle has: the command waits for an idle
            // prompt, Clay types /remote-control himself while it waits, and
            // sending the queued one would now turn OFF what he just turned on.
            const runs = trackRuns();
            const { session, emitMetadata } = paneSession({});
            mockInjectIntoPane.mockResolvedValue(true);
            mockPaneIsIdle.mockResolvedValue(false);

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));
            observe(false);

            emitMetadata({ remoteControl: 'on' });
            await new Promise((r) => setTimeout(r, 50));

            observe(true);
            mockPaneIsIdle.mockResolvedValue(true);
            await new Promise((r) => setTimeout(r, 2500));

            expect(mockInjectIntoPane).not.toHaveBeenCalled();

            runs[0].run.resolve();
            await launcher;
        });

        it('publishes what the transcript says, so /remote-control in the terminal reaches the app', async () => {
            const runs = trackRuns();
            const { session, readMetadata } = paneSession({});
            mockInjectIntoPane.mockResolvedValue(true);

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            observe(true);
            await vi.waitFor(() => expect(readMetadata().paneRemoteControl).toBe(true));
            observe(false);
            await vi.waitFor(() => expect(readMetadata().paneRemoteControl).toBe(false));

            runs[0].run.resolve();
            await launcher;
        });

        it('says the toggle landed the moment it is typed, so the switch stops lagging', async () => {
            const runs = trackRuns();
            const { session, emitMetadata, readMetadata } = paneSession({});
            mockInjectIntoPane.mockResolvedValue(true);

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));
            observe(false);

            emitMetadata({ remoteControl: 'on' });
            await vi.waitFor(() => expect(readMetadata().paneRemoteControl).toBe(true));

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

        // DROVE-49: the socket carries the WRAPPED body, so that is the
        // spelling Claude Code writes back into the transcript. It is our own
        // delivery either way and must not be re-sent to the app.
        scannerOpts.onQueuedPrompt({
            text: `<cross-session-message from-name="${appSenderName}" from-mode="bypass">\nfrom the phone\n</cross-session-message>`,
            at: 1788113421999,
            carrier: 'enqueue',
        });
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

    /**
     * DROVE-49. Clay: "can you stop this bullshit extra messaging about this
     * came from Claude". Two separate findings sit behind these tests, both
     * measured against the 2.1.251 binary rather than assumed:
     *
     *   the uds handler (`Ye`) sets `skipSlashCommands:true` on every message
     *   it takes off the inbox socket, so `/model opus` from the app used to
     *   arrive as five words of prose. Nothing on the wire changes that, so a
     *   slash command has to go to the keyboard.
     *
     *   and the keyboard is only safe when nothing else owns the screen — an
     *   async agent can be running while the prompt reads idle, and the
     *   terminal can be looking at it (DROVE-48).
     */
    describe('a slash command sent from the app', () => {
        it('is typed into the pane, and never written to the socket as text', async () => {
            mockFindInbox.mockResolvedValue(inbox);
            mockSendToInbox.mockResolvedValue('ok');
            mockPaneIsIdle.mockResolvedValue(true);
            mockInjectIntoPane.mockResolvedValue(true);
            const runs = trackRuns();
            const { session, queue } = paneSession();

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            queue.push('/model claude-opus-5', mode);
            await vi.waitFor(() =>
                expect(mockInjectIntoPane).toHaveBeenCalledWith(pane, '/model claude-opus-5', { submit: true }));
            expect(mockSendToInbox).not.toHaveBeenCalled();
            expect(queue.size()).toBe(0);

            runs[0].run.resolve();
            await expect(launcher).resolves.toEqual({ type: 'exit', code: 0 });
        });

        it('waits, rather than typing, while an agent is still running', async () => {
            mockFindInbox.mockResolvedValue(inbox);
            mockSendToInbox.mockResolvedValue('ok');
            mockPaneIsIdle.mockResolvedValue(true);
            mockInjectIntoPane.mockResolvedValue(true);
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

            queue.push('/clear', mode);
            await vi.waitFor(() => expect(session.client.sendSessionEvent).toHaveBeenCalledWith(
                expect.objectContaining({ message: expect.stringContaining('/clear is waiting') })));

            // The whole point: with an agent live, no keystroke reached tmux,
            // and the command did not quietly become prose on the socket.
            expect(mockInjectIntoPane).not.toHaveBeenCalled();
            expect(mockSendToInbox).not.toHaveBeenCalled();

            runs[0].run.resolve();
            await expect(launcher).resolves.toEqual({ type: 'exit', code: 0 });
        });

        /**
         * DROVE-78. The app's goal card acts over the `goal-action` RPC, which
         * runClaude answers. Its only carrier used to be the SDK message
         * queue, which a pane session does not have. So the goal was dead for
         * every session under one mode. The pane carrier below is what the RPC
         * reaches for, and it is the SAME gate a `/goal` typed on the phone
         * goes through: no ungated paste, held rather than drafted.
         */
        describe('the goal carrier the app\'s goal card uses', () => {
            it('types /goal at an idle prompt, and never writes it to the inbox socket as prose', async () => {
                mockFindInbox.mockResolvedValue(inbox);
                mockSendToInbox.mockResolvedValue('ok');
                mockPaneIsIdle.mockResolvedValue(true);
                mockInjectIntoPane.mockResolvedValue(true);
                const runs = trackRuns();
                const { session } = paneSession();

                const launcher = claudeLocalLauncher(session as any);
                await vi.waitFor(() => expect(runs).toHaveLength(1));
                await vi.waitFor(() => expect(session.paneSlashCommandCarrier).toEqual(expect.any(Function)));

                await expect(session.paneSlashCommandCarrier!('/goal ship the thing')).resolves.toBe(true);
                expect(mockInjectIntoPane).toHaveBeenCalledWith(pane, '/goal ship the thing', { submit: true });
                // Claude Code hardcodes skipSlashCommands:true on everything it
                // reads off the inbox socket, so a /goal written there is four
                // words of prose. It must never go that way.
                expect(mockSendToInbox).not.toHaveBeenCalled();

                runs[0].run.resolve();
                await expect(launcher).resolves.toEqual({ type: 'exit', code: 0 });
            });

            it('holds the goal for the prompt while a subagent runs, and types NOTHING', async () => {
                mockFindInbox.mockResolvedValue(inbox);
                mockSendToInbox.mockResolvedValue('ok');
                mockPaneIsIdle.mockResolvedValue(true);
                mockInjectIntoPane.mockResolvedValue(true);
                const runs = trackRuns();
                let scannerOnMessage: ((message: any) => void) | undefined;
                mockCreateSessionScanner.mockImplementation(async (opts: any) => {
                    scannerOnMessage = opts.onMessage;
                    return { onNewSession: vi.fn(), cleanup: vi.fn(async () => {}) };
                });
                const { session } = paneSession();

                const launcher = claudeLocalLauncher(session as any);
                await vi.waitFor(() => expect(runs).toHaveLength(1));
                await vi.waitFor(() => expect(session.paneSlashCommandCarrier).toEqual(expect.any(Function)));
                scannerOnMessage!(asyncAgentLaunched('agent-9'));

                // Accepted, because the queue owns the retry. But a keystroke
                // aimed at the prompt right now could land on whichever agent
                // the terminal is showing.
                await expect(session.paneSlashCommandCarrier!('/goal ship the thing')).resolves.toBe(true);
                expect(mockInjectIntoPane).not.toHaveBeenCalled();
                expect(mockSendToInbox).not.toHaveBeenCalled();
                expect(session.client.sendSessionEvent).toHaveBeenCalledWith(
                    expect.objectContaining({ message: expect.stringContaining('/goal ship the thing is waiting') }));

                runs[0].run.resolve();
                await expect(launcher).resolves.toEqual({ type: 'exit', code: 0 });
            });

            it('goes with the launcher, so a goal never aims at a pane this call no longer owns', async () => {
                mockPaneIsIdle.mockResolvedValue(true);
                mockInjectIntoPane.mockResolvedValue(true);
                const runs = trackRuns();
                const { session } = paneSession();

                const launcher = claudeLocalLauncher(session as any);
                await vi.waitFor(() => expect(runs).toHaveLength(1));
                await vi.waitFor(() => expect(session.paneSlashCommandCarrier).toEqual(expect.any(Function)));
                const carrier = session.paneSlashCommandCarrier!;

                runs[0].run.resolve();
                await expect(launcher).resolves.toEqual({ type: 'exit', code: 0 });

                expect(session.paneSlashCommandCarrier).toBeNull();
                // And the closure itself refuses: no child is in the pane, so
                // there is nothing in there to run the command.
                await expect(carrier('/goal ship the thing')).resolves.toBe(false);
                expect(mockInjectIntoPane).not.toHaveBeenCalled();
            });

            it('hands goal_status records from the pane transcript to the session reducer', async () => {
                mockPaneIsIdle.mockResolvedValue(true);
                let scannerOnTranscriptEvent: ((event: any) => void) | undefined;
                mockCreateSessionScanner.mockImplementation(async (opts: any) => {
                    scannerOnTranscriptEvent = opts.onTranscriptEvent;
                    return { onNewSession: vi.fn(), cleanup: vi.fn(async () => {}) };
                });
                const runs = trackRuns();
                const { session } = paneSession();
                const onGoalStatusEvent = vi.fn();
                session.onGoalStatusEvent = onGoalStatusEvent;

                const launcher = claudeLocalLauncher(session as any);
                await vi.waitFor(() => expect(runs).toHaveLength(1));
                expect(scannerOnTranscriptEvent).toEqual(expect.any(Function));

                const event = {
                    type: 'goal_status',
                    uuid: 'goal-1',
                    sourceRevision: 'goal-1',
                    sourceSessionId: claudeSessionId,
                    attachment: { type: 'goal_status', met: false, condition: 'ship the thing' },
                };
                scannerOnTranscriptEvent!(event);
                expect(onGoalStatusEvent).toHaveBeenCalledWith(event);

                runs[0].run.resolve();
                await expect(launcher).resolves.toEqual({ type: 'exit', code: 0 });
            });
        });

        it('leaves an ordinary message on the socket, wrapped so the pane stops printing the peer note', async () => {
            mockFindInbox.mockResolvedValue(inbox);
            mockSendToInbox.mockResolvedValue('ok');
            mockInjectIntoPane.mockResolvedValue(true);
            const runs = trackRuns();
            const { session, queue } = paneSession();

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            queue.push('/Users/clayrisser/Projects/notes.md has the plan', mode);
            await vi.waitFor(() => expect(mockSendToInbox).toHaveBeenCalled());
            expect(mockInjectIntoPane).not.toHaveBeenCalled();

            runs[0].run.resolve();
            await expect(launcher).resolves.toEqual({ type: 'exit', code: 0 });
        });
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

    /**
     * DROVE-48. The socket is the only carrier for message text now.
     *
     * There used to be a pane paste behind it, and a paste lands on whatever
     * has focus: with Clay inside a background task's view in the terminal,
     * a phone message went to THAT SUBAGENT and was answered by the wrong
     * Claude, with nothing anywhere recording it. Clay's ruling was to delete
     * the fallback rather than guard it — "if you have to fall back then
     * things aren't set up correctly in the first place" — so a socket miss
     * is now a reported failure, not a silent downgrade.
     */
    describe('a phone message goes through the inbox socket or not at all (DROVE-48)', () => {
        let stateDir: string;

        beforeEach(async () => {
            const { mkdtempSync } = await import('node:fs');
            const { tmpdir } = await import('node:os');
            const { join } = await import('node:path');
            stateDir = mkdtempSync(join(tmpdir(), 'drover-state-'));
            vi.stubEnv('STATE_DIR', stateDir);
        });

        afterEach(async () => {
            const { rmSync } = await import('node:fs');
            rmSync(stateDir, { recursive: true, force: true });
        });

        /** The ledger `drover status` counts, or '' when nothing wrote one. */
        async function ledger(): Promise<string> {
            const { readFileSync, existsSync } = await import('node:fs');
            const { join } = await import('node:path');
            const path = join(stateDir, 'messages.log');
            return existsSync(path) ? readFileSync(path, 'utf8') : '';
        }

        /** Every refusal the socket can hand back, and what it is called. */
        const refusals: Array<[string, () => void, string]> = [
            ['the registry has no socket for this session', () => {
                mockFindInbox.mockResolvedValue(null);
            }, 'no-inbox-socket'],
            ['the socket path is there with nobody behind it', () => {
                mockFindInbox.mockResolvedValue(inbox);
                mockSendToInbox.mockResolvedValue('gone');
            }, 'inbox-socket-gone'],
            ['the socket refuses the write', () => {
                mockFindInbox.mockResolvedValue(inbox);
                mockSendToInbox.mockResolvedValue('failed');
            }, 'inbox-socket-refused'],
            ['the registry cannot be read at all', () => {
                mockFindInbox.mockRejectedValue(new Error('EACCES'));
            }, 'inbox-lookup-failed'],
        ];

        for (const [when, arrange, reason] of refusals) {
            it(`types NOTHING into the pane when ${when}`, async () => {
                arrange();
                // A truthy paste mock, so a surviving fallback would succeed
                // loudly rather than fail for its own reasons.
                mockInjectIntoPane.mockResolvedValue(true);
                const runs = trackRuns();
                const { session, queue } = paneSession();

                const launcher = claudeLocalLauncher(session as any);
                await vi.waitFor(() => expect(runs).toHaveLength(1));

                queue.push('from the phone', mode);
                await vi.waitFor(() => expect(session.client.sendSessionEvent).toHaveBeenCalledWith(
                    expect.objectContaining({ message: expect.stringContaining('did NOT reach the terminal') }),
                ));

                // The whole ticket, in one assertion.
                expect(mockInjectIntoPane).not.toHaveBeenCalled();
                // Counted where `drover status` can find it, with the cause.
                expect(await ledger()).toContain(`undelivered ${reason}`);
                // FOLD, NEVER DROP: still held for the next child.
                expect(session.pendingInitialPrompt).toBe('from the phone');

                runs[0].run.resolve();
                await expect(launcher).resolves.toEqual({ type: 'exit', code: 0 });
            });
        }

        it('types NOTHING into the pane with subagents running either', async () => {
            // The case Clay actually asked about: the terminal is showing a
            // background task, so a paste would be answered by that subagent.
            mockFindInbox.mockResolvedValue(null);
            mockInjectIntoPane.mockResolvedValue(true);
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

            expect(mockInjectIntoPane).not.toHaveBeenCalled();
            expect(await ledger()).toContain('undelivered no-inbox-socket');
            // And the subagents were left alone: no SIGTERM, no switch.
            expect(runs[0].opts.abort.aborted).toBe(false);

            runs[0].run.resolve();
            await expect(launcher).resolves.toEqual({ type: 'exit', code: 0 });
        });

        it('counts a delivery too, so an undelivered count has a denominator', async () => {
            mockFindInbox.mockResolvedValue(inbox);
            mockSendToInbox.mockResolvedValue('ok');
            const runs = trackRuns();
            const { session, queue } = paneSession();

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            queue.push('from the phone', mode);
            await vi.waitFor(() => expect(queue.size()).toBe(0));

            expect(await ledger()).toMatch(/\tmessage\tinbox\tdelivered\n$/);
            expect(session.client.sendSessionEvent).not.toHaveBeenCalledWith(
                expect.objectContaining({ message: expect.stringContaining('did NOT reach') }),
            );

            runs[0].run.resolve();
            await expect(launcher).resolves.toEqual({ type: 'exit', code: 0 });
        });
    });

    it('exits when the child exits, even with a message still on the queue', async () => {
        // The bug in one line: an undelivered message used to mean "switch",
        // so quitting claude handed the session to remote mode instead of
        // ending it, and the message was replayed there as a fresh turn.
        mockFindInbox.mockResolvedValue(null);
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

        // DROVE-33: the moment that actually cost Clay the pane. A deferred
        // switch is armed inside doSwitch and fires on the busy -> idle edge,
        // so "nothing was stopped yet" proves nothing on its own — the agent
        // has to report in. Only a switch that was never armed survives this.
        scannerOnMessage!(asyncAgentFinished('agent-7'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(runs[0].opts.abort.aborted).toBe(false);
        expect(session.client.sendSessionEvent).not.toHaveBeenCalledWith(
            expect.objectContaining({ message: expect.stringContaining('switching to remote') }),
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

    it('ends at /exit after a delivered message, with no takeover and no replay (DROVE-33)', async () => {
        // The whole complaint, end to end, through the real loop and a real
        // Session: one message answered in the pane, then Clay quits. The
        // launcher's `exit` is only half the proof — what matters is that the
        // loop RETURNS on it, so the remote launcher never gets the queue and
        // cannot serve the message a second time as a headless turn.
        mockFindInbox.mockResolvedValue(inbox);
        mockSendToInbox.mockResolvedValue('ok');
        const runs = trackRuns();
        const queue = new MessageQueue2<any>(() => 'mode-hash');
        let metadata: Record<string, any> = {};
        const bus = new EventEmitter();
        const client = {
            sendClaudeSessionMessage: vi.fn(),
            sendClaudeSessionMessageFromLocalTranscript: vi.fn(async () => {}),
            sendQueuedPromptFromLocalTranscript: vi.fn(),
            closeClaudeSessionTurn: vi.fn(),
            sendSessionEvent: vi.fn(),
            rpcHandlerManager: { registerHandler: vi.fn() },
            getMetadata: () => metadata,
            updateMetadata: (fn: (m: any) => any) => { metadata = fn(metadata); },
            keepAlive: vi.fn(),
            on: (event: string, handler: (...args: any[]) => void) => bus.on(event, handler),
            off: (event: string, handler: (...args: any[]) => void) => bus.off(event, handler),
        };
        const onModeChange = vi.fn();
        let session: Session | undefined;

        const exitCode = loop({
            path: '/tmp/project',
            onModeChange,
            mcpServers: {},
            session: client as any,
            api: {} as any,
            messageQueue: queue,
            hookSettingsPath: '/tmp/hook-settings.json',
            onSessionReady: (s) => { session = s; },
        });
        try {
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            queue.push('from the phone', mode);
            await vi.waitFor(() =>
                expect(mockSendToInbox).toHaveBeenCalledWith(inbox, 'from the phone', claudeSessionId));
            // Waiting on the delivery rather than on an empty queue is
            // deliberate: with the dequeue put back the way it was, this test
            // has to reach the assertions BELOW to say what actually went
            // wrong, instead of timing out on a queue that never drains. One
            // macrotask is enough — everything after the delivery is a
            // microtask on the same chain.
            await new Promise((resolve) => setTimeout(resolve, 0));

            // `/exit` in the terminal: the child ends with 0.
            runs[0].run.resolve();
            await expect(exitCode).resolves.toBe(0);

            // The takeover, in the three forms it was visible in: a second,
            // headless Claude started; the app told the session went remote;
            // and the pane's own child replaced rather than ended.
            expect(mockClaudeRemoteLauncher).not.toHaveBeenCalled();
            expect(onModeChange).not.toHaveBeenCalled();
            expect(runs).toHaveLength(1);
            // And nothing is left for anyone to replay.
            expect(queue.size()).toBe(0);
        } finally {
            session?.cleanup();
        }
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

        /**
         * DROVE-80. Stop over an open permission dialog used to type Escape
         * into it, which is a deny. interruptPane withdraws the prompt on the
         * bus instead, and the outcome has to reach the phone: the turn is not
         * stopped by that, so a silent Stop would read as one that worked.
         */
        it('says so when Stop withdrew an open prompt instead of pressing Escape', async () => {
            mockInterruptPane.mockResolvedValue('gate-cancelled');
            const runs = trackRuns();
            const { session } = paneSession();

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            await abortHandler(session)();

            expect(runs[0].opts.abort.aborted).toBe(false);
            expect(session.client.sendSessionEvent).toHaveBeenCalledWith(
                expect.objectContaining({ message: expect.stringContaining('withdrew it') }),
            );
            expect(session.client.closeClaudeSessionTurn).toHaveBeenCalledWith('cancelled');

            runs[0].run.resolve();
            await expect(launcher).resolves.toEqual({ type: 'exit', code: 0 });
        });

        it('leaves the turn open, and says why, when the bus could not be asked', async () => {
            // Nothing was typed and nothing was withdrawn, so the turn really
            // is still running: closing it would take the Stop button off the
            // screen the message just asked him to press again.
            mockInterruptPane.mockResolvedValue('unknown');
            const runs = trackRuns();
            const { session } = paneSession();

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            await abortHandler(session)();

            expect(runs[0].opts.abort.aborted).toBe(false);
            expect(session.client.sendSessionEvent).toHaveBeenCalledWith(
                expect.objectContaining({ message: expect.stringContaining('did not answer') }),
            );
            expect(session.client.closeClaudeSessionTurn).not.toHaveBeenCalled();

            runs[0].run.resolve();
            await expect(launcher).resolves.toEqual({ type: 'exit', code: 0 });
        });

        it('leaves a message that is still queued alone', async () => {
            // Stop is about the turn in flight. A message held for the next
            // child never ran, so cancelling does not un-send it.
            mockInterruptPane.mockResolvedValue('cancelled');
            mockFindInbox.mockResolvedValue(null);
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
                // Asked once on the way up, for a model the flip dropped a rung
                // to (DROVE-187). Nothing dropped here.
                takeDowngradePick: () => null,
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

    /**
     * DROVE-79. The sixth way, and the one nobody had pulled yet: the `switch`
     * RPC was still registered on a pane session, where it could not switch
     * anything. exitReasonAfterChild returns `exit` for every pane child, so
     * the handler SIGTERMed the child and the launcher ended the session. A
     * takeover button that just kills the terminal.
     */
    describe('the switch RPC', () => {
        /**
         * A registry that answers a lookup the way RpcHandlerManager does, so
         * "the app called switch" can be played out rather than assumed:
         * handleRequest returns `{ error: 'Method not found' }` for a method
         * with no handler and never touches this session.
         */
        function rpcRegistry(session: any) {
            const handlers = new Map<string, (params: unknown) => unknown>();
            session.client.rpcHandlerManager = {
                registerHandler: vi.fn((name: string, fn: (params: unknown) => unknown) => {
                    handlers.set(name, fn);
                }),
                unregisterHandler: vi.fn((name: string) => {
                    handlers.delete(name);
                }),
            };
            return {
                names: () => [...handlers.keys()],
                call: async (method: string, params: unknown) => {
                    const handler = handlers.get(method);
                    if (!handler) return { error: 'Method not found' };
                    return await handler(params);
                },
            };
        }

        it('is never registered, so the app can see the capability is absent', async () => {
            const runs = trackRuns();
            const { session } = paneSession();
            const rpc = rpcRegistry(session);

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            // Stop is still there. It is the one the app labels "cancel the
            // active turn" and DROVE-13 gave it a pane-safe answer.
            expect(rpc.names()).toContain('abort');
            expect(rpc.names()).not.toContain('switch');

            runs[0].run.resolve();
            await expect(launcher).resolves.toEqual({ type: 'exit', code: 0 });
            // Not even the finally's no-op: a registered method is a
            // capability the app can call.
            expect(rpc.names()).not.toContain('switch');
        });

        it('does not signal the child when the app calls switch anyway', async () => {
            const runs = trackRuns();
            const { session } = paneSession();
            const rpc = rpcRegistry(session);

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            await expect(rpc.call('switch', { to: 'remote' }))
                .resolves.toEqual({ error: 'Method not found' });

            // The three things the old handler did: SIGTERM the child, end the
            // launcher, and hand the pane to a headless run.
            expect(runs[0].opts.abort.aborted).toBe(false);
            expect(runs).toHaveLength(1);
            expect(session.client.closeClaudeSessionTurn).not.toHaveBeenCalled();

            runs[0].run.resolve();
            await expect(launcher).resolves.toEqual({ type: 'exit', code: 0 });
            expect(mockClaudeRemoteLauncher).not.toHaveBeenCalled();
        });

        it('still registers it for a PANELESS session, where remote mode is the only carrier', async () => {
            vi.stubEnv('TMUX_PANE', '');
            const runs = trackRuns();
            const { session } = paneSession();
            const rpc = rpcRegistry(session);

            const launcher = claudeLocalLauncher(session as any);
            await vi.waitFor(() => expect(runs).toHaveLength(1));

            expect(rpc.names()).toContain('switch');
            await rpc.call('switch', { to: 'remote' });
            expect(runs[0].opts.abort.aborted).toBe(true);

            runs[0].run.resolve();
            await expect(launcher).resolves.toEqual({ type: 'switch' });
        });
    });
});

/**
 * The task-notification an async Agent's completion arrives as, trimmed to the
 * three tags InFlightTracker reads. This is the record that takes the count to
 * zero, and with it any switch that was deferred behind that agent.
 */
function asyncAgentFinished(id: string) {
    return {
        type: 'user',
        isSidechain: false,
        message: {
            role: 'user',
            content: '<task-notification>\n'
                + `<task-id>${id}</task-id>\n`
                + '<status>completed</status>\n'
                + '</task-notification>',
        },
        uuid: `uuid-${id}-done`,
    };
}

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
