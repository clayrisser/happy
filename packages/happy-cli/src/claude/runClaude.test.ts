import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockApiClientCreate,
    mockCreateSessionScanner,
    mockLoop,
    mockNotifyDaemonSessionStarted,
    mockReadSettings,
    mockStartHappyServer,
    mockStartHookServer,
    mockRegisterKillSessionHandler,
    mockResumedClaudeSessionId,
    mockFindHappySessionForClaudeSession,
} = vi.hoisted(() => ({
    mockApiClientCreate: vi.fn(),
    mockCreateSessionScanner: vi.fn(),
    mockLoop: vi.fn(),
    mockNotifyDaemonSessionStarted: vi.fn(),
    mockReadSettings: vi.fn(),
    mockStartHappyServer: vi.fn(),
    mockStartHookServer: vi.fn(),
    mockRegisterKillSessionHandler: vi.fn(),
    mockResumedClaudeSessionId: vi.fn(),
    mockFindHappySessionForClaudeSession: vi.fn(),
}));

vi.mock('@/api/api', () => ({
    ApiClient: {
        create: mockApiClientCreate,
    },
}));

vi.mock('@/persistence', () => ({
    readSettings: mockReadSettings,
}));

vi.mock('@/claude/utils/sessionScanner', () => ({
    createSessionScanner: mockCreateSessionScanner,
}));

vi.mock('@/claude/loop', () => ({
    loop: mockLoop,
}));

vi.mock('@/daemon/controlClient', () => ({
    notifyDaemonSessionStarted: mockNotifyDaemonSessionStarted,
}));

vi.mock('@/daemon/run', () => ({
    initialMachineMetadata: {},
}));

vi.mock('@/claude/utils/startHappyServer', () => ({
    startHappyServer: mockStartHappyServer,
}));

vi.mock('@/claude/utils/startHookServer', () => ({
    startHookServer: mockStartHookServer,
}));

vi.mock('@/claude/utils/generateHookSettings', () => ({
    generateHookSettingsFile: vi.fn(() => '/tmp/happy-hook-settings.json'),
    cleanupHookSettingsFile: vi.fn(),
}));

vi.mock('./registerKillSessionHandler', () => ({
    registerKillSessionHandler: mockRegisterKillSessionHandler,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn(),
        infoDeveloper: vi.fn(),
    },
}));

vi.mock('@/ui/doctor', () => ({
    getEnvironmentInfo: vi.fn(() => ({})),
}));

vi.mock('@/utils/serverConnectionErrors', () => ({
    connectionState: {
        setBackend: vi.fn(),
        notifyOffline: vi.fn(),
        fail: vi.fn(),
    },
    startOfflineReconnection: vi.fn(),
}));

vi.mock('@/claude/claudeLocal', () => ({
    claudeLocal: vi.fn(),
}));

vi.mock('@/resume/reattachClaudeSession', () => ({
    resumedClaudeSessionId: mockResumedClaudeSessionId,
    findHappySessionForClaudeSession: mockFindHappySessionForClaudeSession,
}));

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { getProjectPath } from '@/claude/utils/path';

import { refusesDaemonLocalStart, runClaude } from './runClaude';

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function expectPromptRejectsFast(promise: Promise<unknown>, pattern: RegExp) {
    await expect(Promise.race([
        promise,
        new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error('goal action did not reject')), 10);
        }),
    ])).rejects.toThrow(pattern);
}

async function startRemoteRunClaudeHarness(opts: {
    metadata?: Record<string, unknown>;
    updateAgentState?: ReturnType<typeof vi.fn>;
    registerHandler?: ReturnType<typeof vi.fn>;
} = {}) {
    let metadata = opts.metadata ?? {
        claudeSessionId: 'claude-session-1',
        slashCommands: ['goal'],
    };
    const updateAgentState = opts.updateAgentState ?? vi.fn();
    const registerHandler = opts.registerHandler ?? vi.fn();
    const sessionClient = {
        sessionId: 'happy-session-1',
        suppressNextArchiveSignal: vi.fn(),
        skipExistingMessages: vi.fn(),
        updateMetadata: vi.fn((updater: (current: Record<string, unknown>) => Record<string, unknown>) => {
            metadata = updater(metadata);
        }),
        sendClaudeSessionMessage: vi.fn(),
        onUserMessage: vi.fn(),
        onFileEvent: vi.fn(),
        on: vi.fn(),
        trackAttachmentDownload: vi.fn(),
        drainAttachmentsForUserMessage: vi.fn(async () => []),
        downloadAndDecryptAttachment: vi.fn(),
        getMetadata: vi.fn(() => metadata),
        sendSessionEvent: vi.fn(),
        updateAgentState,
        rpcHandlerManager: {
            registerHandler,
        },
        sendSessionDeath: vi.fn(),
        flush: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
    };
    const api = {
        getOrCreateMachine: vi.fn(async () => ({})),
        getOrCreateSession: vi.fn(async () => ({
            id: 'happy-session-1',
            seq: 0,
            metadata: {},
            metadataVersion: 0,
            agentState: {},
            agentStateVersion: 0,
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy' as const,
        })),
        sessionSyncClient: vi.fn(() => sessionClient),
        deactivateSession: vi.fn(async () => {}),
    };
    mockApiClientCreate.mockResolvedValue(api);

    const loopDeferred = createDeferred<number>();
    mockLoop.mockReturnValue(loopDeferred.promise);

    const runPromise = runClaude({
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array(32) },
    } as any, {
        startingMode: 'remote',
        shouldStartDaemon: false,
    });

    await vi.waitFor(() => {
        expect(mockCreateSessionScanner).toHaveBeenCalled();
        expect(mockLoop).toHaveBeenCalled();
    });

    const scannerOptions = mockCreateSessionScanner.mock.calls.at(-1)?.[0];
    const loopOptions = mockLoop.mock.calls.at(-1)?.[0];
    if (!scannerOptions || !loopOptions) {
        throw new Error('runClaude harness did not start');
    }
    // Stands in for the Session the loop builds. The two DROVE-78 hooks are
    // declared here because runClaude writes one (onGoalStatusEvent) and reads
    // the other (paneSlashCommandCarrier, set by the local launcher).
    const runtimeSession: {
        thinking: boolean;
        cleanup: ReturnType<typeof vi.fn>;
        paneSlashCommandCarrier?: ((command: string) => Promise<boolean>) | null;
        onGoalStatusEvent?: ((event: any) => void) | null;
    } = { thinking: false, cleanup: vi.fn() };
    loopOptions.onSessionReady(runtimeSession);
    const goalActionHandler = registerHandler.mock.calls.find(([method]) => method === 'goal-action')?.[1];

    const finish = async () => {
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);
        loopDeferred.resolve(0);
        await expect(runPromise).rejects.toThrow('process.exit');
        exitSpy.mockRestore();
    };

    return {
        api,
        finish,
        goalActionHandler,
        loopOptions,
        registerHandler,
        runtimeSession,
        scannerOptions,
        sessionClient,
        updateAgentState,
    };
}

function emitClaudeGoalStatus(
    scannerOptions: { onTranscriptEvent: (event: unknown) => void },
    event: {
        uuid: string;
        met: boolean;
        condition: string;
        sourceSessionId?: string;
    },
) {
    scannerOptions.onTranscriptEvent({
        type: 'goal_status',
        uuid: event.uuid,
        sourceRevision: event.uuid,
        sourceSessionId: event.sourceSessionId ?? 'claude-session-1',
        attachment: {
            type: 'goal_status',
            met: event.met,
            sentinel: true,
            condition: event.condition,
        },
    });
}

describe('runClaude remote JSONL scanner', () => {
    const processEvents = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'] as const;
    const originalListeners = new Map<string, Array<(...args: any[]) => void>>();
    let savedConfigDir: string | undefined;
    let savedAccounts: string | undefined;
    let titleRoot: string;

    beforeEach(() => {
        vi.clearAllMocks();
        for (const event of processEvents) {
            originalListeners.set(event, process.listeners(event as any) as Array<(...args: any[]) => void>);
        }

        delete process.env.HAPPY_RECONNECT_SESSION_ID;
        delete process.env.HAPPY_RECONNECT_ENCRYPTION_KEY;
        delete process.env.HAPPY_RECONNECT_ENCRYPTION_VARIANT;
        delete process.env.HAPPY_RECONNECT_SEQ;
        delete process.env.HAPPY_RECONNECT_METADATA_VERSION;
        delete process.env.HAPPY_RECONNECT_AGENT_STATE_VERSION;
        delete process.env.HAPPY_FORKED_FROM_SESSION_ID;
        delete process.env.HAPPY_FORKED_FROM_MESSAGE_ID;
        delete process.env.HAPPY_FORK_CLAUDE_SESSION_ID;

        // DROVE-15: runClaude now looks up the name Claude Code is showing,
        // which is a file read. Point it at an empty directory and an absent
        // account registry so these tests never read the developer's own
        // ~/.claude and are not renamed by a session that happens to be there.
        savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
        savedAccounts = process.env.DROVER_ACCOUNTS;
        titleRoot = join(tmpdir(), `runclaude-title-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(titleRoot, { recursive: true });
        process.env.CLAUDE_CONFIG_DIR = join(titleRoot, 'config');
        process.env.DROVER_ACCOUNTS = join(titleRoot, 'accounts.json');

        mockReadSettings.mockResolvedValue({
            machineId: 'machine-1',
            sandboxConfig: undefined,
        });
        mockNotifyDaemonSessionStarted.mockResolvedValue({});
        mockStartHappyServer.mockResolvedValue({
            url: 'http://127.0.0.1:12345',
            toolNames: ['change_title'],
            stop: vi.fn(),
        });
        mockStartHookServer.mockResolvedValue({
            port: 23456,
            stop: vi.fn(),
        });
        mockCreateSessionScanner.mockResolvedValue({
            onNewSession: vi.fn(),
            cleanup: vi.fn(),
        });
        mockResumedClaudeSessionId.mockReturnValue(null);
        mockFindHappySessionForClaudeSession.mockResolvedValue(null);
    });

    afterEach(() => {
        if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
        if (savedAccounts === undefined) delete process.env.DROVER_ACCOUNTS;
        else process.env.DROVER_ACCOUNTS = savedAccounts;
        rmSync(titleRoot, { recursive: true, force: true });
        for (const [event, listeners] of originalListeners) {
            process.removeAllListeners(event as any);
            for (const listener of listeners) {
                process.on(event as any, listener);
            }
        }
        originalListeners.clear();
    });

    it('seeds the account config dir into the session env, so every reader finds the right sessions/ (DROVE-77)', async () => {
        // Seven readers take CLAUDE_CONFIG_DIR from session.claudeEnvVars and
        // fall back to ~/.claude when it is missing. A flip wrote it and every
        // fresh start used to be ambient, so nobody noticed it was never
        // seeded — until DROVE-21 stamped the first fresh start with jamrizzi,
        // claude announced its socket under jamrizzi/sessions/, and findInbox
        // read ~/.claude/sessions/: five phone messages in two minutes came
        // back "did NOT reach the terminal".
        const { loopOptions, finish } = await startRemoteRunClaudeHarness();
        expect(loopOptions.claudeEnvVars?.CLAUDE_CONFIG_DIR).toBe(process.env.CLAUDE_CONFIG_DIR);
        expect(loopOptions.claudeEnvVars?.CLAUDE_CONFIG_DIR).toBe(join(titleRoot, 'config'));
        await finish();
    });

    it('does not forward terminal JSONL messages while local mode owns the transcript', async () => {
        const sentMessages: unknown[] = [];
        const sessionClient = {
            sessionId: 'happy-session-1',
            suppressNextArchiveSignal: vi.fn(),
            skipExistingMessages: vi.fn(),
            updateMetadata: vi.fn(),
            sendClaudeSessionMessage: vi.fn((message: unknown) => {
                sentMessages.push(message);
            }),
            onUserMessage: vi.fn(),
            onFileEvent: vi.fn(),
            on: vi.fn(),
            trackAttachmentDownload: vi.fn(),
            drainAttachmentsForUserMessage: vi.fn(async () => []),
            downloadAndDecryptAttachment: vi.fn(),
            getMetadata: vi.fn(() => ({})),
            sendSessionEvent: vi.fn(),
            updateAgentState: vi.fn(),
            rpcHandlerManager: {
                registerHandler: vi.fn(),
            },
            sendSessionDeath: vi.fn(),
            flush: vi.fn(async () => {}),
            close: vi.fn(async () => {}),
        };
        const api = {
            getOrCreateMachine: vi.fn(async () => ({})),
            getOrCreateSession: vi.fn(async () => ({
                id: 'happy-session-1',
                seq: 0,
                metadata: {},
                metadataVersion: 0,
                agentState: {},
                agentStateVersion: 0,
                encryptionKey: new Uint8Array(32),
                encryptionVariant: 'legacy' as const,
            })),
            sessionSyncClient: vi.fn(() => sessionClient),
            deactivateSession: vi.fn(async () => {}),
        };
        mockApiClientCreate.mockResolvedValue(api);

        const loopDeferred = createDeferred<number>();
        mockLoop.mockReturnValue(loopDeferred.promise);

        const runPromise = runClaude({
            token: 'token',
            encryption: { type: 'legacy', secret: new Uint8Array(32) },
        } as any, {
            startingMode: 'local',
            shouldStartDaemon: false,
        });

        await vi.waitFor(() => {
            expect(mockLoop).toHaveBeenCalled();
            expect(mockCreateSessionScanner).toHaveBeenCalled();
        });

        const scannerOptions = mockCreateSessionScanner.mock.calls[0][0];
        scannerOptions.onMessage({
            type: 'user',
            uuid: 'local-owned-user',
            parentUuid: null,
            isSidechain: false,
            sessionId: 'claude-session-1',
            timestamp: new Date().toISOString(),
            message: {
                role: 'user',
                content: 'typed in local terminal',
            },
        });

        expect(sentMessages).toHaveLength(0);

        const loopOptions = mockLoop.mock.calls[0][0];
        loopOptions.onModeChange('remote');
        scannerOptions.onMessage({
            type: 'user',
            uuid: 'remote-terminal-user',
            parentUuid: null,
            isSidechain: false,
            sessionId: 'claude-session-1',
            timestamp: new Date().toISOString(),
            message: {
                role: 'user',
                content: 'typed in parallel remote terminal',
            },
        });

        expect(sentMessages).toHaveLength(1);
        expect(sessionClient.sendClaudeSessionMessage).toHaveBeenCalledWith(
            expect.objectContaining({ uuid: 'remote-terminal-user' }),
        );

        loopDeferred.resolve(0);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);
        await expect(runPromise).rejects.toThrow('process.exit');
        exitSpy.mockRestore();
    });

    it('observes goal_status side-channel events as agent goal state', async () => {
        const sentMessages: unknown[] = [];
        let metadata = {
            claudeSessionId: 'claude-session-1',
            slashCommands: ['goal'],
        };
        const sessionClient = {
            sessionId: 'happy-session-1',
            suppressNextArchiveSignal: vi.fn(),
            skipExistingMessages: vi.fn(),
            updateMetadata: vi.fn((updater: (current: typeof metadata) => typeof metadata) => {
                metadata = updater(metadata);
            }),
            sendClaudeSessionMessage: vi.fn((message: unknown) => {
                sentMessages.push(message);
            }),
            onUserMessage: vi.fn(),
            onFileEvent: vi.fn(),
            on: vi.fn(),
            trackAttachmentDownload: vi.fn(),
            drainAttachmentsForUserMessage: vi.fn(async () => []),
            downloadAndDecryptAttachment: vi.fn(),
            getMetadata: vi.fn(() => metadata),
            sendSessionEvent: vi.fn(),
            updateAgentState: vi.fn(),
            rpcHandlerManager: {
                registerHandler: vi.fn(),
            },
            sendSessionDeath: vi.fn(),
            flush: vi.fn(async () => {}),
            close: vi.fn(async () => {}),
        };
        const api = {
            getOrCreateMachine: vi.fn(async () => ({})),
            getOrCreateSession: vi.fn(async () => ({
                id: 'happy-session-1',
                seq: 0,
                metadata: {},
                metadataVersion: 0,
                agentState: {},
                agentStateVersion: 0,
                encryptionKey: new Uint8Array(32),
                encryptionVariant: 'legacy' as const,
            })),
            sessionSyncClient: vi.fn(() => sessionClient),
            deactivateSession: vi.fn(async () => {}),
        };
        mockApiClientCreate.mockResolvedValue(api);

        const loopDeferred = createDeferred<number>();
        mockLoop.mockReturnValue(loopDeferred.promise);

        const runPromise = runClaude({
            token: 'token',
            encryption: { type: 'legacy', secret: new Uint8Array(32) },
        } as any, {
            startingMode: 'remote',
            shouldStartDaemon: false,
        });

        await vi.waitFor(() => {
            expect(mockLoop).toHaveBeenCalled();
            expect(mockCreateSessionScanner).toHaveBeenCalled();
        });

        const scannerOptions = mockCreateSessionScanner.mock.calls[0][0];
        expect(scannerOptions.onTranscriptEvent).toEqual(expect.any(Function));

        scannerOptions.onMessage({
            type: 'attachment',
            uuid: 'goal-event-as-message',
            sessionId: 'claude-session-1',
            timestamp: new Date().toISOString(),
            attachment: {
                type: 'goal_status',
                met: false,
                condition: 'Ship goal observation',
            },
        });
        expect(sentMessages).toHaveLength(0);

        scannerOptions.onTranscriptEvent({
            type: 'goal_status',
            uuid: 'goal-event-ignored',
            sourceSessionId: 'other-claude-session',
            sourceRevision: 'rev-ignored',
            timestamp: new Date().toISOString(),
            attachment: {
                type: 'goal_status',
                met: false,
                condition: 'Wrong session goal',
            },
        });
        expect(sessionClient.updateAgentState).toHaveBeenCalledTimes(1);

        const userMessageHandler = sessionClient.onUserMessage.mock.calls[0][0];
        await userMessageHandler({
            content: { text: '/goal Ship goal observation' },
            meta: {},
        });
        expect(sessionClient.updateAgentState).toHaveBeenCalledTimes(1);

        scannerOptions.onTranscriptEvent({
            type: 'goal_status',
            uuid: 'goal-event-1',
            sourceSessionId: 'claude-session-1',
            sourceRevision: 'rev-1',
            timestamp: new Date().toISOString(),
            attachment: {
                type: 'goal_status',
                met: false,
                condition: 'Ship goal observation',
            },
        });

        expect(sessionClient.updateAgentState).toHaveBeenCalledTimes(2);
        const goalUpdater = sessionClient.updateAgentState.mock.calls[1][0];
        const nextState = goalUpdater({ controlledByUser: false });
        expect(nextState).toMatchObject({
            controlledByUser: false,
            agentGoalStatus: {
                source: 'claude',
                status: 'active',
                sourceSessionId: 'claude-session-1',
                sourceRevision: 'rev-1',
                text: 'Ship goal observation',
                capabilities: { clear: true, edit: true },
            },
        });

        expect(sentMessages).toHaveLength(0);

        loopDeferred.resolve(0);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);
        await expect(runPromise).rejects.toThrow('process.exit');
        exitSpy.mockRestore();
    });

    it('registers Claude goal-action and queues clear as an isolated command without optimistic state changes', async () => {
        const harness = await startRemoteRunClaudeHarness();
        await vi.waitFor(() => {
            expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        });
        const handler = harness.goalActionHandler;
        if (!handler) throw new Error('goal-action handler not registered');

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-active',
            met: false,
            condition: 'finish rpc test',
        });
        expect(harness.updateAgentState).toHaveBeenCalledTimes(2);

        const promise = handler({ action: 'clear' });
        expect(harness.loopOptions.messageQueue.queue).toEqual([
            expect.objectContaining({ message: '/goal clear', isolate: true }),
        ]);
        expect(harness.updateAgentState).toHaveBeenCalledTimes(2);

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-cleared',
            met: true,
            condition: 'finish rpc test',
        });

        await expect(promise).resolves.toEqual({ ok: true });
        await harness.finish();
    });

    it('rejects a second Claude goal action while one is pending', async () => {
        const harness = await startRemoteRunClaudeHarness();
        await vi.waitFor(() => {
            expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        });
        const handler = harness.goalActionHandler;
        if (!handler) throw new Error('goal-action handler not registered');

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-active',
            met: false,
            condition: 'old rpc goal',
        });

        const first = handler({ action: 'edit', objective: 'new rpc goal' });
        expect(harness.loopOptions.messageQueue.queue).toEqual([
            expect.objectContaining({ message: '/goal new rpc goal', isolate: true }),
        ]);

        await expect(handler({ action: 'clear' })).rejects.toThrow(/already in progress|busy/i);
        expect(harness.loopOptions.messageQueue.queue).toEqual([
            expect.objectContaining({ message: '/goal new rpc goal', isolate: true }),
        ]);

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-edited',
            met: false,
            condition: 'new rpc goal',
        });

        await expect(first).resolves.toEqual({ ok: true });
        await harness.finish();
    });

    it('times out a pending Claude goal action, resets pending, and allows a subsequent action', async () => {
        const harness = await startRemoteRunClaudeHarness();
        await vi.waitFor(() => {
            expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        });
        const handler = harness.goalActionHandler;
        if (!handler) throw new Error('goal-action handler not registered');

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-active-timeout',
            met: false,
            condition: 'timeout rpc goal',
        });

        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const first = handler({ action: 'clear' });
            expect(harness.loopOptions.messageQueue.queue).toEqual([
                expect.objectContaining({ message: '/goal clear', isolate: true }),
            ]);

            vi.advanceTimersByTime(30000);
            await expect(first).rejects.toThrow(/Timed out waiting for Claude goal confirmation/);

            await harness.loopOptions.messageQueue.waitForMessagesAndGetAsString();
            const second = handler({ action: 'edit', objective: 'goal after timeout' });
            expect(harness.loopOptions.messageQueue.queue).toEqual([
                expect.objectContaining({ message: '/goal goal after timeout', isolate: true }),
            ]);

            emitClaudeGoalStatus(harness.scannerOptions, {
                uuid: 'goal-att-after-timeout',
                met: false,
                condition: 'goal after timeout',
            });
            await expect(second).resolves.toEqual({ ok: true });
        } finally {
            vi.useRealTimers();
            await harness.finish();
        }
    });

    it('resets pending and clears timeout when pushIsolated throwing rejects Claude goal-action', async () => {
        const harness = await startRemoteRunClaudeHarness();
        await vi.waitFor(() => {
            expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        });
        const handler = harness.goalActionHandler;
        if (!handler) throw new Error('goal-action handler not registered');

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-active-push-failure',
            met: false,
            condition: 'push failure rpc goal',
        });

        const originalPushIsolated = harness.loopOptions.messageQueue.pushIsolated.bind(harness.loopOptions.messageQueue);
        const pushError = new Error('pushIsolated failed');
        const pushIsolatedSpy = vi.spyOn(harness.loopOptions.messageQueue, 'pushIsolated')
            .mockImplementationOnce(() => {
                throw pushError;
            })
            .mockImplementation((...args: unknown[]) => {
                const [message, mode, attachments] = args as [string, any, any];
                originalPushIsolated(message, mode, attachments);
            });
        const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

        try {
            await expect(handler({ action: 'clear' })).rejects.toThrow(/pushIsolated failed/);
            expect(clearTimeoutSpy).toHaveBeenCalled();

            const second = handler({ action: 'edit', objective: 'goal after push failure' });
            expect(pushIsolatedSpy).toHaveBeenCalledTimes(2);
            expect(harness.loopOptions.messageQueue.queue).toEqual([
                expect.objectContaining({ message: '/goal goal after push failure', isolate: true }),
            ]);

            emitClaudeGoalStatus(harness.scannerOptions, {
                uuid: 'goal-att-after-push-failure',
                met: false,
                condition: 'goal after push failure',
            });
            await expect(second).resolves.toEqual({ ok: true });
        } finally {
            pushIsolatedSpy.mockRestore();
            clearTimeoutSpy.mockRestore();
            await harness.finish();
        }
    });

    it('queues edit Claude goal as isolated command and resolves only after a matching active side-channel status', async () => {
        const harness = await startRemoteRunClaudeHarness();
        await vi.waitFor(() => {
            expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        });
        const handler = harness.goalActionHandler;
        if (!handler) throw new Error('goal-action handler not registered');

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-active',
            met: false,
            condition: 'old rpc goal',
        });

        let settled = false;
        const promise = handler({ action: 'edit', objective: '  revised rpc goal  ' });
        promise.then(() => { settled = true; });

        expect(harness.loopOptions.messageQueue.queue).toEqual([
            expect.objectContaining({ message: '/goal revised rpc goal', isolate: true }),
        ]);
        expect(harness.updateAgentState).toHaveBeenCalledTimes(2);

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-not-matching',
            met: false,
            condition: 'not yet revised',
        });
        await Promise.resolve();
        expect(settled).toBe(false);

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-matching',
            met: false,
            condition: '  revised rpc goal  ',
        });

        await expect(promise).resolves.toEqual({ ok: true });
        expect(settled).toBe(true);
        await harness.finish();
    });

    it('rejects invalid and unsupported Claude goal-action params', async () => {
        const harness = await startRemoteRunClaudeHarness();
        await vi.waitFor(() => {
            expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        });
        const handler = harness.goalActionHandler;
        if (!handler) throw new Error('goal-action handler not registered');

        await expect(handler(null)).rejects.toThrow(/Unsupported Claude goal action/);
        await expect(handler(undefined)).rejects.toThrow(/Unsupported Claude goal action/);
        await expect(handler({ action: 'stop' })).rejects.toThrow(/Unsupported Claude goal action/);
        await expect(handler({ action: 'edit', objective: '   ' })).rejects.toThrow(/Unsupported Claude goal action/);
        await harness.finish();
    });

    it('rejects Claude goal-action when no active Claude goal is known', async () => {
        const harness = await startRemoteRunClaudeHarness();
        await vi.waitFor(() => {
            expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        });
        const handler = harness.goalActionHandler;
        if (!handler) throw new Error('goal-action handler not registered');

        await expect(handler({ action: 'clear' })).rejects.toThrow(/No active Claude goal/);
        await harness.finish();
    });

    it('rejects Claude goal-action when the relevant capability is missing', async () => {
        const harness = await startRemoteRunClaudeHarness({
            metadata: {
                claudeSessionId: 'claude-session-1',
                slashCommands: [],
            },
        });
        await vi.waitFor(() => {
            expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        });
        const handler = harness.goalActionHandler;
        if (!handler) throw new Error('goal-action handler not registered');

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-active-no-capabilities',
            met: false,
            condition: 'goal without actions',
        });

        await expect(handler({ action: 'clear' })).rejects.toThrow(/clear goal action is not supported/);
        await expect(handler({ action: 'edit', objective: 'new goal' })).rejects.toThrow(/edit goal action is not supported/);
        await harness.finish();
    });

    it('rejects Claude goal-action when the message queue is busy', async () => {
        const harness = await startRemoteRunClaudeHarness();
        await vi.waitFor(() => {
            expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        });
        const handler = harness.goalActionHandler;
        if (!handler) throw new Error('goal-action handler not registered');

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-active-busy-queue',
            met: false,
            condition: 'busy queue goal',
        });
        harness.loopOptions.messageQueue.push('already queued', { permissionMode: 'default' });

        await expect(handler({ action: 'clear' })).rejects.toThrow(/queue is busy|busy/i);
        expect(harness.loopOptions.messageQueue.queue).toEqual([
            expect.objectContaining({ message: 'already queued' }),
        ]);
        await harness.finish();
    });

    /**
     * DROVE-78. `/goal` from the phone used to throw for any session that was
     * not remote, and under one mode (DROVE-1) every session is a pane session
     * so the goal card was dead for every session Clay actually runs.
     */
    describe('a Claude goal set from the phone on a LOCAL session', () => {
        it('goes to the pane through its own carrier, with nothing pushed at the SDK queue', async () => {
            const harness = await startRemoteRunClaudeHarness();
            await vi.waitFor(() => {
                expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
            });
            const handler = harness.goalActionHandler;
            if (!handler) throw new Error('goal-action handler not registered');

            harness.loopOptions.onModeChange('local');
            const carrier = vi.fn(async () => true);
            harness.runtimeSession.paneSlashCommandCarrier = carrier;

            emitClaudeGoalStatus(harness.scannerOptions, {
                uuid: 'goal-att-active-pane',
                met: false,
                condition: 'old pane goal',
            });

            await expect(handler({ action: 'edit', objective: 'ship the pane goal' }))
                .resolves.toEqual({ ok: true });
            expect(carrier).toHaveBeenCalledWith('/goal ship the pane goal');
            // The SDK queue belongs to remote mode. A pane session has no
            // query() draining it, so anything left here is a message that
            // never runs.
            expect(harness.loopOptions.messageQueue.queue).toEqual([]);

            await expect(handler({ action: 'clear' })).resolves.toEqual({ ok: true });
            expect(carrier).toHaveBeenLastCalledWith('/goal clear');
            await harness.finish();
        });

        it('offers clear and edit even though a pane session has no slashCommands list', async () => {
            // metadata.slashCommands is written from the SDK's system init,
            // which only the remote launcher runs. Reading it as the whole
            // truth is what left a pane session's goal card with no buttons.
            const harness = await startRemoteRunClaudeHarness({
                metadata: {
                    claudeSessionId: 'claude-session-1',
                    slashCommands: [],
                },
            });
            await vi.waitFor(() => {
                expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
            });

            harness.loopOptions.onModeChange('local');
            harness.runtimeSession.paneSlashCommandCarrier = vi.fn(async () => true);

            emitClaudeGoalStatus(harness.scannerOptions, {
                uuid: 'goal-att-active-pane-capabilities',
                met: false,
                condition: 'pane goal with actions',
            });

            const goalUpdater = harness.updateAgentState.mock.calls.at(-1)?.[0];
            expect(goalUpdater({})).toMatchObject({
                agentGoalStatus: {
                    status: 'active',
                    text: 'pane goal with actions',
                    capabilities: { clear: true, edit: true },
                },
            });
            await harness.finish();
        });

        it('reports the goal back from the local scanner, which is the one that follows a flip', async () => {
            const harness = await startRemoteRunClaudeHarness();
            await vi.waitFor(() => {
                expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
            });

            harness.loopOptions.onModeChange('local');
            harness.runtimeSession.paneSlashCommandCarrier = vi.fn(async () => true);

            // What claudeLocalLauncher's scanner hands over. Same reducer as
            // the remote scanner, so the app sees one goal card either way.
            const onGoalStatusEvent = harness.runtimeSession.onGoalStatusEvent;
            expect(onGoalStatusEvent).toEqual(expect.any(Function));
            onGoalStatusEvent!({
                type: 'goal_status',
                uuid: 'goal-from-pane-scanner',
                sourceRevision: 'rev-pane-1',
                sourceSessionId: 'claude-session-1',
                timestamp: new Date().toISOString(),
                attachment: {
                    type: 'goal_status',
                    met: false,
                    condition: 'watched from the pane',
                },
            });

            const goalUpdater = harness.updateAgentState.mock.calls.at(-1)?.[0];
            expect(goalUpdater({})).toMatchObject({
                agentGoalStatus: {
                    status: 'active',
                    sourceRevision: 'rev-pane-1',
                    text: 'watched from the pane',
                },
            });

            // The same record arriving down the remote scanner as well is one
            // goal, not two: both feed the same reducer and the revision is
            // already spent.
            const updatesAfterFirst = harness.updateAgentState.mock.calls.length;
            harness.scannerOptions.onTranscriptEvent({
                type: 'goal_status',
                uuid: 'goal-from-pane-scanner',
                sourceRevision: 'rev-pane-1',
                sourceSessionId: 'claude-session-1',
                timestamp: new Date().toISOString(),
                attachment: {
                    type: 'goal_status',
                    met: false,
                    condition: 'watched from the pane',
                },
            });
            expect(harness.updateAgentState.mock.calls.length).toBe(updatesAfterFirst);
            await harness.finish();
        });

        it('says there is no terminal, rather than "not ready", when the session has no pane', async () => {
            const harness = await startRemoteRunClaudeHarness();
            await vi.waitFor(() => {
                expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
            });
            const handler = harness.goalActionHandler;
            if (!handler) throw new Error('goal-action handler not registered');

            emitClaudeGoalStatus(harness.scannerOptions, {
                uuid: 'goal-att-active-local-mode',
                met: false,
                condition: 'local mode goal',
            });
            harness.loopOptions.onModeChange('local');

            await expectPromptRejectsFast(handler({ action: 'clear' }), /no pane to run \/goal in/i);
            expect(harness.loopOptions.messageQueue.queue).toEqual([]);
            await harness.finish();
        });

        it('says the command did not reach the terminal when the pane has no live Claude', async () => {
            const harness = await startRemoteRunClaudeHarness();
            await vi.waitFor(() => {
                expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
            });
            const handler = harness.goalActionHandler;
            if (!handler) throw new Error('goal-action handler not registered');

            harness.loopOptions.onModeChange('local');
            harness.runtimeSession.paneSlashCommandCarrier = vi.fn(async () => false);

            emitClaudeGoalStatus(harness.scannerOptions, {
                uuid: 'goal-att-active-dead-pane',
                met: false,
                condition: 'goal with no child',
            });

            await expectPromptRejectsFast(
                handler({ action: 'clear' }),
                /did not reach the terminal/i,
            );
            expect(harness.loopOptions.messageQueue.queue).toEqual([]);
            await harness.finish();
        });
    });

    it('keeps the picked model and effort after an abort resets the other mode defaults', async () => {
        const harness = await startRemoteRunClaudeHarness();
        const userMessageHandler = harness.sessionClient.onUserMessage.mock.calls[0][0];

        await userMessageHandler({
            content: { text: 'first turn' },
            meta: { model: 'claude-fable-5-20260115', effort: 'high' },
        });
        expect(harness.loopOptions.messageQueue.queue[0].mode).toMatchObject({
            model: 'claude-fable-5-20260115',
            effort: 'high',
        });

        // Aborting the turn must not silently revert the picker's choice —
        // the app only sends meta.model/meta.effort when the user changes them.
        harness.loopOptions.onAbort();

        await userMessageHandler({
            content: { text: 'second turn' },
            meta: {},
        });
        expect(harness.loopOptions.messageQueue.queue[1].mode).toMatchObject({
            model: 'claude-fable-5-20260115',
            effort: 'high',
        });

        await harness.finish();
    });

    it('rejects Claude goal-action while Claude is still thinking', async () => {
        const harness = await startRemoteRunClaudeHarness();
        await vi.waitFor(() => {
            expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        });
        const handler = harness.goalActionHandler;
        if (!handler) throw new Error('goal-action handler not registered');

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-active-thinking',
            met: false,
            condition: 'thinking goal',
        });
        harness.runtimeSession.thinking = true;

        await expectPromptRejectsFast(handler({ action: 'clear' }), /not ready|thinking/i);
        expect(harness.loopOptions.messageQueue.queue).toEqual([]);
        await harness.finish();
    });

    function createReattachHarness() {
        const sessionClient = {
            sessionId: 'happy-existing',
            suppressNextArchiveSignal: vi.fn(),
            skipExistingMessages: vi.fn(),
            updateMetadata: vi.fn(),
            sendClaudeSessionMessage: vi.fn(),
            onUserMessage: vi.fn(),
            onFileEvent: vi.fn(),
            on: vi.fn(),
            trackAttachmentDownload: vi.fn(),
            drainAttachmentsForUserMessage: vi.fn(async () => []),
            downloadAndDecryptAttachment: vi.fn(),
            getMetadata: vi.fn(() => ({})),
            sendSessionEvent: vi.fn(),
            updateAgentState: vi.fn(),
            rpcHandlerManager: {
                registerHandler: vi.fn(),
            },
            sendSessionDeath: vi.fn(),
            flush: vi.fn(async () => {}),
            close: vi.fn(async () => {}),
        };
        const api = {
            getOrCreateMachine: vi.fn(async () => ({})),
            getOrCreateSession: vi.fn(async () => ({
                id: 'happy-fresh',
                seq: 0,
                metadata: {},
                metadataVersion: 0,
                agentState: {},
                agentStateVersion: 0,
                encryptionKey: new Uint8Array(32),
                encryptionVariant: 'legacy' as const,
            })),
            sessionSyncClient: vi.fn(() => sessionClient),
            deactivateSession: vi.fn(async () => {}),
        };
        mockApiClientCreate.mockResolvedValue(api);
        const loopDeferred = createDeferred<number>();
        mockLoop.mockReturnValue(loopDeferred.promise);
        return { api, sessionClient, loopDeferred };
    }

    async function finishRun(runPromise: Promise<unknown>, loopDeferred: { resolve: (value: number) => void }) {
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);
        loopDeferred.resolve(0);
        await expect(runPromise).rejects.toThrow('process.exit');
        exitSpy.mockRestore();
    }

    it('reattaches --resume to the Happy session already holding that Claude transcript', async () => {
        // A wrapper running these tests exports DROVER_ACCOUNT, which renames
        // the session and would hide whether the app's title survives.
        const droverAccount = process.env.DROVER_ACCOUNT;
        delete process.env.DROVER_ACCOUNT;
        const claudeId = '9ae61ba4-8a3b-452f-a294-da49d0019c79';
        const claudeArgs = ['--dangerously-skip-permissions', '--resume', claudeId];
        const existingKey = new Uint8Array(32).fill(7);
        mockResumedClaudeSessionId.mockReturnValue(claudeId);
        mockFindHappySessionForClaudeSession.mockResolvedValue({
            id: 'happy-existing',
            active: false,
            seq: 40,
            metadataVersion: 7,
            agentStateVersion: 3,
            encryptionKey: existingKey,
            encryptionVariant: 'legacy',
            metadata: {
                path: process.cwd(),
                name: 'titled by the app',
                summary: { text: 'titled by the app', updatedAt: 1 },
                claudeSessionId: claudeId,
                lifecycleState: 'archived',
            },
        });
        const { api, sessionClient, loopDeferred } = createReattachHarness();

        const runPromise = runClaude({
            token: 'token',
            encryption: { type: 'legacy', secret: new Uint8Array(32) },
        } as any, {
            startingMode: 'local',
            shouldStartDaemon: false,
            claudeArgs,
        });

        await vi.waitFor(() => {
            expect(mockLoop).toHaveBeenCalled();
        });

        expect(mockResumedClaudeSessionId).toHaveBeenCalledWith(claudeArgs, process.cwd());
        expect(mockFindHappySessionForClaudeSession).toHaveBeenCalledWith(claudeId);
        // No throwaway session: the existing one is joined with its own key
        // and the server's versions, on the same path HAPPY_RECONNECT_* uses.
        expect(api.getOrCreateSession).not.toHaveBeenCalled();
        expect(api.sessionSyncClient).toHaveBeenCalledWith(expect.objectContaining({
            id: 'happy-existing',
            seq: 40,
            metadataVersion: 7,
            agentStateVersion: 3,
            encryptionKey: existingKey,
            metadata: expect.objectContaining({
                claudeSessionId: claudeId,
                // The start name is a seed, not a fact: a title already on the
                // session outranks it, or every resume would rename a session
                // the user had named.
                name: 'titled by the app',
                summary: { text: 'titled by the app', updatedAt: 1 },
                lifecycleState: 'running',
            }),
        }));
        expect(sessionClient.skipExistingMessages).toHaveBeenCalled();
        expect(sessionClient.suppressNextArchiveSignal).toHaveBeenCalled();
        // The remote scanner starts on the transcript, so it is pre-marked.
        expect(mockCreateSessionScanner.mock.calls[0][0]).toMatchObject({ sessionId: claudeId });
        expect(mockNotifyDaemonSessionStarted).toHaveBeenCalledWith(
            'happy-existing',
            expect.objectContaining({ claudeSessionId: claudeId }),
            expect.objectContaining({ seq: 40, metadataVersion: 7 }),
        );

        const loopOptions = mockLoop.mock.calls[0][0];
        expect(loopOptions.reattachedClaudeSessionId).toBe(claudeId);
        // Claude args pass through untouched: the drover default flag stays,
        // --resume is neither dropped nor doubled.
        expect(loopOptions.claudeArgs).toEqual(claudeArgs);

        await finishRun(runPromise, loopDeferred);
        if (droverAccount !== undefined) process.env.DROVER_ACCOUNT = droverAccount;
    });

    it('still creates a fresh Happy session when no existing one holds the transcript', async () => {
        const claudeId = '9ae61ba4-8a3b-452f-a294-da49d0019c79';
        mockResumedClaudeSessionId.mockReturnValue(claudeId);
        mockFindHappySessionForClaudeSession.mockResolvedValue(null);
        const { api, sessionClient, loopDeferred } = createReattachHarness();

        const runPromise = runClaude({
            token: 'token',
            encryption: { type: 'legacy', secret: new Uint8Array(32) },
        } as any, {
            startingMode: 'local',
            shouldStartDaemon: false,
            claudeArgs: ['--resume', claudeId],
        });

        await vi.waitFor(() => {
            expect(mockLoop).toHaveBeenCalled();
        });

        expect(api.getOrCreateSession).toHaveBeenCalledTimes(1);
        expect(sessionClient.skipExistingMessages).not.toHaveBeenCalled();
        expect(mockLoop.mock.calls[0][0].reattachedClaudeSessionId).toBeUndefined();

        await finishRun(runPromise, loopDeferred);
    });

    it('names a fresh session after the project instead of leaving it "New chat"', async () => {
        // The phone's title is metadata.summary.text and nothing on the Claude
        // path ever wrote one: transcript summaries are dropped by
        // claudeLocalLauncher and change_title is only wired for Gemini, so
        // every session read "New chat" over its own path until it flipped.
        const droverAccount = process.env.DROVER_ACCOUNT;
        delete process.env.DROVER_ACCOUNT;
        const { api, loopDeferred } = createReattachHarness();

        const runPromise = runClaude({
            token: 'token',
            encryption: { type: 'legacy', secret: new Uint8Array(32) },
        } as any, {
            startingMode: 'local',
            shouldStartDaemon: false,
        });

        await vi.waitFor(() => {
            expect(mockLoop).toHaveBeenCalled();
        });

        const expected = basename(process.cwd());
        expect(api.getOrCreateSession).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({
                name: expected,
                summary: expect.objectContaining({ text: expected }),
            }),
        }));

        await finishRun(runPromise, loopDeferred);
        if (droverAccount !== undefined) process.env.DROVER_ACCOUNT = droverAccount;
    });

    it('carries the drover account in the start name, in the shape a flip stamps', async () => {
        const droverAccount = process.env.DROVER_ACCOUNT;
        process.env.DROVER_ACCOUNT = 'work';
        const { api, loopDeferred } = createReattachHarness();

        const runPromise = runClaude({
            token: 'token',
            encryption: { type: 'legacy', secret: new Uint8Array(32) },
        } as any, {
            startingMode: 'local',
            shouldStartDaemon: false,
        });

        await vi.waitFor(() => {
            expect(mockLoop).toHaveBeenCalled();
        });

        const expected = `[work] ${basename(process.cwd())}`;
        expect(api.getOrCreateSession).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({
                droverAccount: 'work',
                name: expected,
                summary: expect.objectContaining({ text: expected }),
            }),
        }));

        await finishRun(runPromise, loopDeferred);
        if (droverAccount === undefined) delete process.env.DROVER_ACCOUNT;
        else process.env.DROVER_ACCOUNT = droverAccount;
    });

    it('restamps a reattached session whose only name is a stale account prefix', async () => {
        // The seed loses to a real title (covered above) but beats one of our
        // own defaults, which may still be carrying the account this session
        // has just moved off.
        const droverAccount = process.env.DROVER_ACCOUNT;
        process.env.DROVER_ACCOUNT = 'work';
        const claudeId = '9ae61ba4-8a3b-452f-a294-da49d0019c79';
        mockResumedClaudeSessionId.mockReturnValue(claudeId);
        mockFindHappySessionForClaudeSession.mockResolvedValue({
            id: 'happy-existing',
            active: false,
            seq: 1,
            metadataVersion: 1,
            agentStateVersion: 1,
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy',
            metadata: {
                path: process.cwd(),
                name: `[personal] ${basename(process.cwd())}`,
                summary: { text: `[personal] ${basename(process.cwd())}`, updatedAt: 1 },
                claudeSessionId: claudeId,
            },
        });
        const { api, loopDeferred } = createReattachHarness();

        const runPromise = runClaude({
            token: 'token',
            encryption: { type: 'legacy', secret: new Uint8Array(32) },
        } as any, {
            startingMode: 'local',
            shouldStartDaemon: false,
            claudeArgs: ['--resume', claudeId],
        });

        await vi.waitFor(() => {
            expect(mockLoop).toHaveBeenCalled();
        });

        const expected = `[work] ${basename(process.cwd())}`;
        expect(api.sessionSyncClient).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({
                name: expected,
                summary: expect.objectContaining({ text: expected }),
            }),
        }));

        await finishRun(runPromise, loopDeferred);
        if (droverAccount === undefined) delete process.env.DROVER_ACCOUNT;
        else process.env.DROVER_ACCOUNT = droverAccount;
    });

    it('never reattaches a fork, which is a new Happy session by definition', async () => {
        process.env.HAPPY_FORK_CLAUDE_SESSION_ID = '11111111-2222-4333-8444-555555555555';
        const { api, loopDeferred } = createReattachHarness();

        const runPromise = runClaude({
            token: 'token',
            encryption: { type: 'legacy', secret: new Uint8Array(32) },
        } as any, {
            startingMode: 'local',
            shouldStartDaemon: false,
            claudeArgs: ['--resume', '11111111-2222-4333-8444-555555555555'],
        });

        await vi.waitFor(() => {
            expect(mockLoop).toHaveBeenCalled();
        });

        expect(mockResumedClaudeSessionId).not.toHaveBeenCalled();
        expect(mockFindHappySessionForClaudeSession).not.toHaveBeenCalled();
        expect(api.getOrCreateSession).toHaveBeenCalledTimes(1);

        await finishRun(runPromise, loopDeferred);
    });

    // DROVE-2: a session started from the phone now lands in a tmux window of
    // the user's own server, so it has a pane and local mode is right for it.
    // The blanket refusal assumed a daemon spawn could only ever be paneless.
    describe('a daemon spawn in local mode', () => {
        it('refuses local mode only when there is no pane', () => {
            expect(refusesDaemonLocalStart('daemon', 'local', undefined)).toBe(true);
            expect(refusesDaemonLocalStart('daemon', 'local', '')).toBe(true);
            expect(refusesDaemonLocalStart('daemon', 'local', '%43')).toBe(false);
            expect(refusesDaemonLocalStart('daemon', 'remote', undefined)).toBe(false);
            expect(refusesDaemonLocalStart('terminal', 'local', undefined)).toBe(false);
        });

        it('throws for a paneless daemon spawn asking for local mode', async () => {
            const pane = process.env.TMUX_PANE;
            delete process.env.TMUX_PANE;
            try {
                await expect(runClaude({
                    token: 'token',
                    encryption: { type: 'legacy', secret: new Uint8Array(32) },
                } as any, {
                    startedBy: 'daemon',
                    startingMode: 'local',
                    shouldStartDaemon: false,
                })).rejects.toThrow(/no tmux pane cannot use local/);
            } finally {
                if (pane === undefined) delete process.env.TMUX_PANE;
                else process.env.TMUX_PANE = pane;
            }
        });

        it('lets a daemon spawn that owns a tmux pane start local', async () => {
            const pane = process.env.TMUX_PANE;
            process.env.TMUX_PANE = '%77';
            // Fail at the first step AFTER the guard, so reaching this error is
            // proof the guard let the launch through.
            mockApiClientCreate.mockRejectedValueOnce(new Error('past the guard'));
            try {
                await expect(runClaude({
                    token: 'token',
                    encryption: { type: 'legacy', secret: new Uint8Array(32) },
                } as any, {
                    startedBy: 'daemon',
                    startingMode: 'local',
                    shouldStartDaemon: false,
                })).rejects.toThrow('past the guard');
            } finally {
                if (pane === undefined) delete process.env.TMUX_PANE;
                else process.env.TMUX_PANE = pane;
            }
        });
    });

    it('resumes under the name Claude Code is showing, not the project default', async () => {
        // DROVE-15. Clay renamed a session DROVER with /rename, quit drover,
        // and started it again with --resume. The terminal said DROVER; the
        // app header said cattle-drover, which is only the cwd basename. The
        // name is on disk in the account's own projects tree, so read it
        // rather than seeding a path over it.
        const droverAccount = process.env.DROVER_ACCOUNT;
        delete process.env.DROVER_ACCOUNT;
        const claudeId = '9ae61ba4-8a3b-452f-a294-da49d0019c79';
        const titleDir = join(getProjectPath(process.cwd(), process.env.CLAUDE_CONFIG_DIR!), claudeId);
        mkdirSync(titleDir, { recursive: true });
        writeFileSync(join(titleDir, 'custom-title.json'), JSON.stringify({ customTitle: 'DROVER' }));
        mockResumedClaudeSessionId.mockReturnValue(claudeId);
        mockFindHappySessionForClaudeSession.mockResolvedValue(null);
        const { api, loopDeferred } = createReattachHarness();

        const runPromise = runClaude({
            token: 'token',
            encryption: { type: 'legacy', secret: new Uint8Array(32) },
        } as any, {
            startingMode: 'local',
            shouldStartDaemon: false,
            claudeArgs: ['--resume', claudeId],
        });

        await vi.waitFor(() => {
            expect(mockLoop).toHaveBeenCalled();
        });

        expect(api.getOrCreateSession).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({
                name: 'DROVER',
                summary: expect.objectContaining({ text: 'DROVER' }),
            }),
        }));

        await finishRun(runPromise, loopDeferred);
        if (droverAccount !== undefined) process.env.DROVER_ACCOUNT = droverAccount;
    });

    it('takes the name the SessionStart hook carries', async () => {
        // DROVE-15. Every SessionStart hook payload already carries
        // session_title — the authoritative current name, handed to the CLI
        // and thrown away. It covers the picker (`drover --resume` with no id,
        // where nothing knows the session id until this very hook) and a
        // session renamed before it ever wrote a custom-title record.
        const { sessionClient, loopDeferred } = createReattachHarness();

        const runPromise = runClaude({
            token: 'token',
            encryption: { type: 'legacy', secret: new Uint8Array(32) },
        } as any, {
            startingMode: 'local',
            shouldStartDaemon: false,
        });

        await vi.waitFor(() => {
            expect(mockLoop).toHaveBeenCalled();
            expect(mockStartHookServer).toHaveBeenCalled();
        });

        const onSessionHook = mockStartHookServer.mock.calls.at(-1)?.[0]?.onSessionHook;
        expect(onSessionHook).toBeTypeOf('function');
        const runtimeSession = {
            sessionId: null as string | null,
            thinking: false,
            cleanup: vi.fn(),
            client: sessionClient,
            onSessionFound: vi.fn(),
        };
        mockLoop.mock.calls.at(-1)?.[0].onSessionReady(runtimeSession);

        sessionClient.updateMetadata.mockClear();
        onSessionHook('9ae61ba4-8a3b-452f-a294-da49d0019c79', {
            session_id: '9ae61ba4-8a3b-452f-a294-da49d0019c79',
            hook_event_name: 'SessionStart',
            source: 'resume',
            session_title: 'DROVER',
        });

        expect(sessionClient.updateMetadata).toHaveBeenCalled();
        const updater = sessionClient.updateMetadata.mock.calls.at(-1)![0] as (m: any) => any;
        expect(updater({ name: 'cattle-drover' })).toMatchObject({
            name: 'DROVER',
            summary: expect.objectContaining({ text: 'DROVER' }),
        });

        await finishRun(runPromise, loopDeferred);
    });
    /**
     * DROVE-237. `/skills` from the phone answered nothing at all on a local
     * session: it was forwarded to the pane, where Claude Code's own answer is
     * terminal UI the transcript never sees, and it queued behind whatever the
     * pane was already running. The remote branch was no better, reading
     * `metadata.skills`, which only the remote launcher ever writes.
     */
    describe('/skills from the phone', () => {
        it('answers off the disk scan in local mode, with nothing pushed at the pane', async () => {
            const configDir = process.env.CLAUDE_CONFIG_DIR!;
            mkdirSync(join(configDir, 'skills', 'huly-ticket'), { recursive: true });
            writeFileSync(
                join(configDir, 'skills', 'huly-ticket', 'SKILL.md'),
                '---\ndescription: File and update Huly tickets\n---\nbody\n',
            );

            const harness = await startRemoteRunClaudeHarness({
                metadata: { claudeSessionId: 'claude-session-1', droverAccount: 'jamrizzi' },
            });
            harness.loopOptions.onModeChange('local');
            harness.runtimeSession.paneSlashCommandCarrier = vi.fn(async () => true);

            const userMessageHandler = harness.sessionClient.onUserMessage.mock.calls[0][0] as
                (message: unknown) => Promise<void>;
            await userMessageHandler({ content: { text: '/skills ' }, meta: {} });

            const sent = harness.sessionClient.sendClaudeSessionMessage.mock.calls.at(-1)?.[0] as any;
            const text = sent?.message?.content?.[0]?.text as string;
            expect(text).toContain('/huly-ticket');
            expect(text).toContain('File and update Huly tickets');
            expect(text).toContain('account `jamrizzi`');
            expect(text).not.toMatch(/initializ/i);
            // Forwarding it was the bug: the pane owns the prompt and holds
            // the command behind any running agent, and its answer is never
            // written to the transcript the app reads.
            expect(harness.loopOptions.messageQueue.queue).toEqual([]);
            expect(harness.runtimeSession.paneSlashCommandCarrier).not.toHaveBeenCalled();
            await harness.finish();
        });
    });
});
