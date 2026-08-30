import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockClaudeLocal,
    mockCreateSessionScanner,
    mockInjectIntoPane,
    mockFindInbox,
    mockSendToInbox,
} = vi.hoisted(() => ({
    mockClaudeLocal: vi.fn(),
    mockCreateSessionScanner: vi.fn(),
    mockInjectIntoPane: vi.fn(),
    mockFindInbox: vi.fn(),
    mockSendToInbox: vi.fn(),
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
}));

vi.mock('./utils/inboxSocket', () => ({
    findInbox: mockFindInbox,
    sendToInbox: mockSendToInbox,
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
        vi.stubEnv('TMUX_PANE', pane);
        mockCreateSessionScanner.mockResolvedValue({
            onNewSession: vi.fn(),
            cleanup: vi.fn(async () => {}),
        });
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    /** A stub session with a REAL queue, because the queue is what is on trial. */
    function paneSession() {
        const queue = new MessageQueue2<any>(() => 'mode-hash');
        const session = {
            sessionId: claudeSessionId,
            path: '/tmp/project',
            client: {
                sendClaudeSessionMessage: vi.fn(),
                sendClaudeSessionMessageFromLocalTranscript: vi.fn(async () => {}),
                closeClaudeSessionTurn: vi.fn(),
                sendSessionEvent: vi.fn(),
                rpcHandlerManager: { registerHandler: vi.fn() },
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
        return { session, queue };
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
