/**
 * WebSocket client for machine/daemon communication with Happy server
 * Similar to ApiSessionClient but for machine-scoped connections
 */

import { join } from 'node:path';

import { io, Socket } from 'socket.io-client';
import { logger } from '@/ui/logger';
import { pickForLog } from '@slopus/happy-wire';
import { configuration } from '@/configuration';
import { MachineMetadata, DaemonState, Machine, Update, UpdateMachineBody } from './types';
import { registerCommonHandlers, SpawnSessionOptions, SpawnSessionResult } from '../modules/common/registerCommonHandlers';
import { encodeBase64, decodeBase64, encrypt, decrypt } from './encryption';
import { backoff } from '@/utils/time';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { registerDroverPolicyHandler } from '@/drover/flip/policyRpc';
import { registerListWorktreesHandler } from '@/daemon/listWorktrees';
import { registerMachineAccountsHandlers } from '@/drover/machineAccounts';
import { registerMachineMcpsHandlers } from '@/drover/machineMcps';
import { registerMachineFilesHandlers } from '@/drover/machineFiles';
import { registerDroverDemoPushHandler } from '@/drover/demo';
import { PushNotificationClient } from './pushNotifications';
import { detectCLIAvailability, CLIAvailability } from '@/utils/detectCLI';
import { detectResumeSupport, type ResumeSupport } from '@/resume/localHappyAgentAuth';
import { shouldReconnect } from '@/utils/lidState';
import { getProjectPath } from '@/claude/utils/path';
import {
    forkSession as claudeForkSession,
    forkAndTruncateSession as claudeForkAndTruncateSession,
    listClaudeRewindPoints,
    ForkTruncateUuidNotFoundError,
    ForkSourceMissingError,
} from '@/claude/utils/claudeSessionFork';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import {
    CodexForkRewindPointNotFoundError,
    forkCodexThread,
    listCodexRewindPoints,
} from '@/codex/codexThreadFork';
import { startAccountLogin, type AccountLoginRequest } from '@/drover/accountLogin';
import { exportCloneSeed, isCloneTargetHarness, cloneTargetHarnesses } from '@/drover/cloneSeed';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ServerToDaemonEvents {
    update: (data: Update) => void;
    'rpc-request': (data: { method: string, params: string }, callback: (response: string) => void) => void;
    'rpc-registered': (data: { method: string }) => void;
    'rpc-unregistered': (data: { method: string }) => void;
    'rpc-error': (data: { type: string, error: string }) => void;
    auth: (data: { success: boolean, user: string }) => void;
    error: (data: { message: string }) => void;
}

interface DaemonToServerEvents {
    'machine-alive': (data: {
        machineId: string;
        time: number;
    }) => void;

    'machine-update-metadata': (data: {
        machineId: string;
        metadata: string; // Encrypted MachineMetadata
        expectedVersion: number
    }, cb: (answer: {
        result: 'error'
    } | {
        result: 'version-mismatch'
        version: number,
        metadata: string
    } | {
        result: 'success',
        version: number,
        metadata: string
    }) => void) => void;

    'machine-update-state': (data: {
        machineId: string;
        daemonState: string; // Encrypted DaemonState
        expectedVersion: number
    }, cb: (answer: {
        result: 'error'
    } | {
        result: 'version-mismatch'
        version: number,
        daemonState: string
    } | {
        result: 'success',
        version: number,
        daemonState: string
    }) => void) => void;

    'rpc-register': (data: { method: string }) => void;
    'rpc-unregister': (data: { method: string }) => void;
    'rpc-call': (data: { method: string, params: any }, callback: (response: {
        ok: boolean
        result?: any
        error?: string
    }) => void) => void;
}

type MachineRpcHandlers = {
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    resumeSession?: (sessionId: string, options?: { model?: string; permissionMode?: string }) => Promise<SpawnSessionResult>;
    stopSession: (sessionId: string) => boolean;
    requestShutdown: () => void;
}

function requireNonEmptyString(value: unknown, name: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`${name} is required`);
    }
    return value;
}

async function withCodexAppServerClient<T>(handler: (client: CodexAppServerClient) => Promise<T>): Promise<T> {
    const client = new CodexAppServerClient();
    await client.connect();
    try {
        return await handler(client);
    } finally {
        await client.disconnect();
    }
}

export class ApiMachineClient {
    private socket!: Socket<ServerToDaemonEvents, DaemonToServerEvents>;
    private keepAliveInterval: NodeJS.Timeout | null = null;
    private lastKnownCLIAvailability: CLIAvailability | null = null;
    private lastKnownResumeSupport: ResumeSupport | null = null;
    private rpcHandlerManager: RpcHandlerManager;
    private resumeSessionHandler: ((sessionId: string, options?: { model?: string; permissionMode?: string }) => Promise<SpawnSessionResult>) | null = null;
    private reconnectInterval: NodeJS.Timeout | null = null;

    constructor(
        private token: string,
        private machine: Machine
    ) {
        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.machine.id,
            encryptionKey: this.machine.encryptionKey,
            encryptionVariant: this.machine.encryptionVariant,
            logger: (msg, data) => logger.debug(msg, data)
        });

        // null = unrestricted: the daemon serves the whole machine, and its
        // process.cwd() is an accident of where it was started, not a workspace.
        registerCommonHandlers(this.rpcHandlerManager, null);

        // The machine-wide flip policy defaults (DROVE-3). Registered on the
        // DAEMON as well as on each session, because an app-level default has
        // to be settable when nothing is running — that is the case where it
        // matters, since it is what the next session will pick up. The session
        // handler cannot serve it: there is no session to address.
        registerDroverPolicyHandler(this.rpcHandlerManager, () => null);

        // The repo's worktrees, for the branch sheet in the session header (DROVE-90).
        registerListWorktreesHandler(this.rpcHandlerManager);

        // This machine's Claude accounts, listed and removed from the phone
        // (DROVE-165). On the DAEMON, like the policy handler and for the same
        // reason: an account belongs to the machine, not to a session, and the
        // Accounts screen has to answer with nothing running.
        registerMachineAccountsHandlers(this.rpcHandlerManager);

        // What MCP servers each harness on this machine is configured with
        // (DROVE-274). On the daemon for the third time and the same reason —
        // MCP config belongs to the machine, and Claude's is per ACCOUNT, so
        // it sits beside the accounts handler that already answers for those.
        registerMachineMcpsHandlers(this.rpcHandlerManager);
        // A worktree's files and a session's pane, for the worktree sheet's
        // Files and Terminal tabs (DROVE-330). On the daemon for the fourth
        // time and the same reason: the worktree Clay tapped may have no
        // session in it to ask, and the reading is the drover's anyway.
        registerMachineFilesHandlers(this.rpcHandlerManager);
        // The channel demo's test push (DROVE-75). On the daemon for the same
        // reason the policy handler is: the phone wants to prove the push path
        // while nothing is running. Its own push client rather than the
        // ApiClient's, because this class only ever sees the token; the client
        // is stateless apart from the wake throttle, which the demo never uses.
        registerDroverDemoPushHandler(
            this.rpcHandlerManager,
            new PushNotificationClient(this.token, configuration.serverUrl),
        );
    }

    setRPCHandlers({
        spawnSession,
        resumeSession,
        stopSession,
        requestShutdown
    }: MachineRpcHandlers) {
        this.resumeSessionHandler = resumeSession ?? null;

        // Register spawn session handler
        this.rpcHandlerManager.registerHandler('spawn-happy-session', async (params: any) => {
            const { directory, sessionId, machineId, approvedNewDirectoryCreation, agent, permissionMode, modelMode, effortLevel, environmentVariables, token, resumeClaudeSessionId, resumeCodexThreadId, seedFile, parentSessionId, forkedFromMessageId, isSideChat } = params || {};
            // THE LEAK (DROVE-304). This line was
            // `JSON.stringify(params)` and it ran on EVERY spawn, behind no
            // flag at all. `params.token` is the session's bearer token and
            // `params.environmentVariables` is whatever the phone sent to run
            // the harness with, which is where an ANTHROPIC_API_KEY lives. Both
            // went to `~/.happy/logs/*-daemon.log` in the clear, and with
            // DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING set they went
            // unencrypted off the machine as well.
            //
            // An ALLOWLIST, not a redactor pass over the same object. A
            // denylist here would be one unfamiliar param name away from
            // leaking again the next time spawn learns a field, and this is the
            // one line in the tree that has already proved that can happen.
            // What is actually wanted from this line when debugging a failed
            // spawn is which directory, which agent and which mode -- none of
            // which is a credential.
            //
            // The COUNT rather than the names for the env: knowing something
            // was passed is what tells you the phone sent an override at all,
            // and the names alone have been enough to identify a private
            // deployment before now.
            logger.debug(`[API MACHINE] Spawning session: ${JSON.stringify({
                ...pickForLog(params ?? {}, [
                    'directory', 'sessionId', 'machineId', 'agent', 'permissionMode',
                    'modelMode', 'effortLevel', 'approvedNewDirectoryCreation',
                    'parentSessionId', 'forkedFromMessageId', 'isSideChat',
                    // A path this daemon wrote itself, under the drover state
                    // dir. Not a credential, and the one thing worth having in
                    // the log when a clone starts with no context in it.
                    'seedFile',
                ]),
                environmentVariableCount: Object.keys(environmentVariables ?? {}).length,
                hasToken: Boolean(token),
                resuming: Boolean(resumeClaudeSessionId || resumeCodexThreadId),
            })}`);

            if (!directory) {
                throw new Error('Directory is required');
            }

            const result = await spawnSession({ directory, sessionId, machineId, approvedNewDirectoryCreation, agent, permissionMode, modelMode, effortLevel, environmentVariables, token, resumeClaudeSessionId, resumeCodexThreadId, seedFile, parentSessionId, forkedFromMessageId, isSideChat });

            switch (result.type) {
                case 'success':
                    logger.debug(`[API MACHINE] Spawned session ${result.sessionId}`);
                    return { type: 'success', sessionId: result.sessionId };

                case 'requestToApproveDirectoryCreation':
                    logger.debug(`[API MACHINE] Requesting directory creation approval for: ${result.directory}`);
                    return { type: 'requestToApproveDirectoryCreation', directory: result.directory };

                case 'error':
                    throw new Error(result.errorMessage);
            }
        });

        this.syncResumeSessionRpcRegistration();

        // Register stop session handler
        this.rpcHandlerManager.registerHandler('stop-session', (params: any) => {
            const { sessionId } = params || {};

            if (!sessionId) {
                throw new Error('Session ID is required');
            }

            const success = stopSession(sessionId);
            if (!success) {
                throw new Error('Session not found or failed to stop');
            }

            logger.debug(`[API MACHINE] Stopped session ${sessionId}`);
            return { message: 'Session stopped' };
        });

        // Register Claude session fork handlers (used by app-side fork /
        // duplicate flows). These take the source session's working
        // directory and underlying Claude UUID, copy the on-disk JSONL
        // — optionally truncated at a chosen message — and return the new
        // Claude UUID. The caller then spawns a fresh Happy session with
        // `resumeClaudeSessionId` set so `claude --resume <newUuid>`
        // continues the conversation.
        this.rpcHandlerManager.registerHandler('claude-fork-session', async (params: any) => {
            const { directory, claudeSessionId } = params || {};
            if (typeof directory !== 'string' || directory.length === 0) {
                throw new Error('directory is required');
            }
            if (typeof claudeSessionId !== 'string' || !UUID_RE.test(claudeSessionId)) {
                throw new Error('claudeSessionId must be a valid UUID');
            }
            try {
                const newClaudeSessionId = await claudeForkSession(getProjectPath(directory), claudeSessionId);
                return { type: 'success', newClaudeSessionId };
            } catch (error) {
                if (error instanceof ForkSourceMissingError) {
                    throw new Error('Claude session file not found on this machine');
                }
                throw error;
            }
        });

        // List user-text rewind points directly from the on-disk JSONL.
        // The server-side session log misses claudeUuid for messages typed
        // live in the app (legacy `sentFrom: 'web'` path); disk is the
        // source of truth and carries the right uuids for every message.
        this.rpcHandlerManager.registerHandler('claude-list-rewind-points', async (params: any) => {
            const { directory, claudeSessionId } = params || {};
            if (typeof directory !== 'string' || directory.length === 0) {
                throw new Error('directory is required');
            }
            if (typeof claudeSessionId !== 'string' || !UUID_RE.test(claudeSessionId)) {
                throw new Error('claudeSessionId must be a valid UUID');
            }
            try {
                const points = await listClaudeRewindPoints(getProjectPath(directory), claudeSessionId);
                return { type: 'success', points };
            } catch (error) {
                if (error instanceof ForkSourceMissingError) {
                    throw new Error('Claude session file not found on this machine');
                }
                throw error;
            }
        });

        this.rpcHandlerManager.registerHandler('claude-duplicate-session', async (params: any) => {
            const { directory, claudeSessionId, cutAfterUuid } = params || {};
            if (typeof directory !== 'string' || directory.length === 0) {
                throw new Error('directory is required');
            }
            if (typeof claudeSessionId !== 'string' || !UUID_RE.test(claudeSessionId)) {
                throw new Error('claudeSessionId must be a valid UUID');
            }
            if (typeof cutAfterUuid !== 'string' || !UUID_RE.test(cutAfterUuid)) {
                throw new Error('cutAfterUuid must be a valid UUID');
            }
            try {
                const newClaudeSessionId = await claudeForkAndTruncateSession(
                    getProjectPath(directory),
                    claudeSessionId,
                    cutAfterUuid,
                );
                return { type: 'success', newClaudeSessionId };
            } catch (error) {
                if (error instanceof ForkSourceMissingError) {
                    throw new Error('Claude session file not found on this machine');
                }
                if (error instanceof ForkTruncateUuidNotFoundError) {
                    throw new Error(
                        'The chosen rewind point is no longer present in the source session — try forking without truncation',
                    );
                }
                throw error;
            }
        });

        // Export a Claude conversation as a SEED for another harness (DROVE-337).
        //
        // The app's fork is same-harness by construction, because a fork
        // carries the transcript and only Claude Code can read a Claude Code
        // transcript. Crossing harnesses is a CLONE: the conversation is
        // exported and RETOLD. This handler is the export half, and it does
        // not start anything -- the caller then spawns the target harness with
        // `seedFile` set, so a clone takes the same window path, the same
        // precondition checks and the same account decision as every other
        // session started from the phone.
        //
        // Errors THROW rather than returning an error shape, which is what
        // every other handler on this class does. The app normalises the
        // daemon's `{ error }` envelope back into a result it can print
        // (`machineRpcResult.ts`), so the sentence `drover clone` wrote is
        // what Clay reads on the phone. Before DROVE-337 it was swallowed and
        // replaced with "Failed to fork the session."
        this.rpcHandlerManager.registerHandler('drover-clone-seed', async (params: any) => {
            const { directory, claudeSessionId, harness, turns } = params || {};
            if (typeof directory !== 'string' || directory.length === 0) {
                throw new Error('directory is required');
            }
            if (typeof claudeSessionId !== 'string' || !UUID_RE.test(claudeSessionId)) {
                throw new Error('claudeSessionId must be a valid UUID');
            }
            if (!isCloneTargetHarness(harness)) {
                throw new Error(
                    `Cannot clone into '${harness}'. Known harnesses: ${cloneTargetHarnesses.join(', ')}.`,
                );
            }
            const result = await exportCloneSeed({
                transcriptPath: join(getProjectPath(directory), `${claudeSessionId}.jsonl`),
                sessionId: claudeSessionId,
                directory,
                harness,
                turns: typeof turns === 'number' ? turns : undefined,
            });
            if (result.type === 'error') {
                throw new Error(result.errorMessage);
            }
            return { type: 'success', seedPath: result.seedPath };
        });

        this.rpcHandlerManager.registerHandler('codex-fork-thread', async (params: any) => {
            const directory = requireNonEmptyString(params?.directory, 'directory');
            const codexThreadId = requireNonEmptyString(params?.codexThreadId, 'codexThreadId');

            const result = await withCodexAppServerClient((client) => forkCodexThread(client, {
                threadId: codexThreadId,
                cwd: directory,
            }));
            return result;
        });

        this.rpcHandlerManager.registerHandler('codex-list-rewind-points', async (params: any) => {
            const codexThreadId = requireNonEmptyString(params?.codexThreadId, 'codexThreadId');

            return withCodexAppServerClient(async (client) => {
                const { thread } = await client.readThread({
                    threadId: codexThreadId,
                    includeTurns: true,
                });
                return {
                    type: 'success',
                    points: listCodexRewindPoints(thread),
                };
            });
        });

        this.rpcHandlerManager.registerHandler('codex-duplicate-thread', async (params: any) => {
            const directory = requireNonEmptyString(params?.directory, 'directory');
            const codexThreadId = requireNonEmptyString(params?.codexThreadId, 'codexThreadId');
            const cutAfterItemId = requireNonEmptyString(params?.cutAfterItemId, 'cutAfterItemId');

            try {
                return await withCodexAppServerClient((client) => forkCodexThread(client, {
                    threadId: codexThreadId,
                    cwd: directory,
                    cutAfterItemId,
                }));
            } catch (error) {
                if (error instanceof CodexForkRewindPointNotFoundError) {
                    throw new Error(
                        'The chosen rewind point is no longer present in the source Codex thread — try forking without truncation',
                    );
                }
                throw error;
            }
        });

        // Add a Claude account from the phone (DROVE-61).
        //
        // It STARTS the login and returns. The rest of the flow is on the bus:
        // the URL Claude Code prints comes back to the phone as a question with
        // origin.gate "account-login", and the code is that question's answer.
        // Holding this RPC open for the fifteen minutes a human takes would
        // time out long before the card was answered.
        this.rpcHandlerManager.registerHandler('drover-account-login', async (params: AccountLoginRequest) => {
            logger.debug('[API MACHINE] Received drover-account-login RPC request');
            return await startAccountLogin(params ?? {});
        });

        // Register stop daemon handler
        this.rpcHandlerManager.registerHandler('stop-daemon', () => {
            logger.debug('[API MACHINE] Received stop-daemon RPC request');

            // Trigger shutdown callback after a delay
            setTimeout(() => {
                logger.debug('[API MACHINE] Initiating daemon shutdown from RPC');
                requestShutdown();
            }, 100);

            return { message: 'Daemon stop request acknowledged, starting shutdown sequence...' };
        });
    }

    private syncResumeSessionRpcRegistration(): void {
        const method = 'resume-happy-session';

        if (this.resumeSessionHandler) {
            if (!this.rpcHandlerManager.hasHandler(method)) {
                this.rpcHandlerManager.registerHandler(method, async (params: any) => {
                    const { sessionId, model, permissionMode } = params || {};

                    if (!sessionId || typeof sessionId !== 'string') {
                        throw new Error('Session ID is required');
                    }

                    const handler = this.resumeSessionHandler;
                    if (!handler) {
                        throw new Error('Resume session handler not available');
                    }

                    const result = await handler(sessionId, { model, permissionMode });
                    switch (result.type) {
                        case 'success':
                            return { type: 'success', sessionId: result.sessionId };
                        case 'requestToApproveDirectoryCreation':
                            return result;
                        case 'error':
                            throw new Error(result.errorMessage);
                    }
                });
            }
            return;
        }

        if (this.rpcHandlerManager.hasHandler(method)) {
            this.rpcHandlerManager.unregisterHandler(method);
        }
    }

    /**
     * Update machine metadata
     * Currently unused, changes from the mobile client are more likely
     * for example to set a custom name.
     */
    async updateMachineMetadata(handler: (metadata: MachineMetadata | null) => MachineMetadata): Promise<void> {
        await backoff(async () => {
            const updated = handler(this.machine.metadata);

            const answer = await this.socket.emitWithAck('machine-update-metadata', {
                machineId: this.machine.id,
                metadata: encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, updated)),
                expectedVersion: this.machine.metadataVersion
            });

            if (answer.result === 'success') {
                this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.metadata));
                this.machine.metadataVersion = answer.version;
                logger.debug('[API MACHINE] Metadata updated successfully');
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.machine.metadataVersion) {
                    this.machine.metadataVersion = answer.version;
                    this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.metadata));
                }
                throw new Error('Metadata version mismatch'); // Triggers retry
            }
        });
    }

    /**
     * Update daemon state (runtime info) - similar to session updateAgentState
     * Simplified without lock - relies on backoff for retry
     */
    async updateDaemonState(handler: (state: DaemonState | null) => DaemonState): Promise<void> {
        await backoff(async () => {
            const updated = handler(this.machine.daemonState);

            const answer = await this.socket.emitWithAck('machine-update-state', {
                machineId: this.machine.id,
                daemonState: encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, updated)),
                expectedVersion: this.machine.daemonStateVersion
            });

            if (answer.result === 'success') {
                this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.daemonState));
                this.machine.daemonStateVersion = answer.version;
                logger.debug('[API MACHINE] Daemon state updated successfully');
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.machine.daemonStateVersion) {
                    this.machine.daemonStateVersion = answer.version;
                    this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.daemonState));
                }
                throw new Error('Daemon state version mismatch'); // Triggers retry
            }
        });
    }

    connect() {
        const serverUrl = configuration.serverUrl.replace(/^http/, 'ws');
        logger.debug(`[API MACHINE] Connecting to ${serverUrl}`);

        this.socket = io(serverUrl, {
            transports: ['websocket'],
            auth: {
                token: this.token,
                clientType: 'machine-scoped' as const,
                machineId: this.machine.id,
                happyClient: `cli-daemon/${configuration.currentCliVersion}`
            },
            path: '/v1/updates',
            reconnection: false,
        });

        this.socket.on('connect', () => {
            logger.debug('[API MACHINE] Connected to server');

            if (this.reconnectInterval) {
                clearInterval(this.reconnectInterval);
                this.reconnectInterval = null;
            }

            this.updateDaemonState((state) => ({
                ...state,
                status: 'running',
                pid: process.pid,
                httpPort: this.machine.daemonState?.httpPort,
                startedAt: Date.now()
            }));

            this.rpcHandlerManager.onSocketConnect(this.socket);
            this.syncResumeSessionRpcRegistration();
            this.startKeepAlive();
        });

        this.socket.on('disconnect', (reason) => {
            logger.debug(`[API MACHINE] Disconnected from server — reason: ${reason}`);
            this.rpcHandlerManager.onSocketDisconnect();
            this.stopKeepAlive();
            this.startSmartReconnect();
        });

        // Single consolidated RPC handler
        this.socket.on('rpc-request', async (data: { method: string, params: string }, callback: (response: string) => void) => {
            logger.debugLargeJson(`[API MACHINE] Received RPC request:`, data);
            callback(await this.rpcHandlerManager.handleRequest(data));
        });

        // Handle update events from server
        this.socket.on('update', (data: Update) => {
            // Machine clients should only care about machine updates
            if (data.body.t === 'update-machine' && (data.body as UpdateMachineBody).machineId === this.machine.id) {
                // Handle machine metadata or daemon state updates from other clients (e.g., mobile app)
                const update = data.body as UpdateMachineBody;

                if (update.metadata) {
                    logger.debug('[API MACHINE] Received external metadata update');
                    this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(update.metadata.value));
                    this.machine.metadataVersion = update.metadata.version;
                }

                if (update.daemonState) {
                    logger.debug('[API MACHINE] Received external daemon state update');
                    this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(update.daemonState.value));
                    this.machine.daemonStateVersion = update.daemonState.version;
                }
            } else {
                logger.debug(`[API MACHINE] Received unknown update type: ${(data.body as any).t}`);
            }
        });

        this.socket.on('connect_error', (error) => {
            logger.debug(`[API MACHINE] Connection error: ${error.message}`);
            this.startSmartReconnect();
        });

        this.socket.io.on('error', (error: any) => {
            logger.debug('[API MACHINE] Socket error:', error);
        });
    }

    private sendKeepAlive() {
        const payload = {
            machineId: this.machine.id,
            time: Date.now()
        };
        if (process.env.DEBUG) {
            logger.debugLargeJson(`[API MACHINE] Emitting machine-alive`, payload);
        }
        this.socket.emit('machine-alive', payload);

        // Re-detect CLI availability and push metadata update if changed
        const newAvailability = detectCLIAvailability();
        const prev = this.lastKnownCLIAvailability;
        const newResumeSupport = detectResumeSupport();
        const prevResume = this.lastKnownResumeSupport;
        // Every detected CLI has to be compared here. A key left out is never
        // republished after startup, so installing or removing that agent goes
        // unnoticed for the life of the daemon — and the app hides agents it is
        // not told about.
        const cliAvailabilityChanged = !prev
            || prev.claude !== newAvailability.claude
            || prev.codex !== newAvailability.codex
            || prev.gemini !== newAvailability.gemini
            || prev.openclaw !== newAvailability.openclaw
            || prev.agy !== newAvailability.agy;
        const resumeSupportChanged = !prevResume
            || prevResume.rpcAvailable !== newResumeSupport.rpcAvailable
            || prevResume.happyAgentAuthenticated !== newResumeSupport.happyAgentAuthenticated;

        if (cliAvailabilityChanged || resumeSupportChanged) {
            this.lastKnownCLIAvailability = newAvailability;
            this.lastKnownResumeSupport = newResumeSupport;
            this.updateMachineMetadata((metadata) => ({
                ...(metadata || {} as any),
                cliAvailability: newAvailability,
                resumeSupport: { ...newResumeSupport, rpcAvailable: !!this.resumeSessionHandler },
            })).catch((err) => {
                logger.debug('[API MACHINE] Failed to update machine capabilities:', err);
            });
        }
    }

    private startKeepAlive() {
        this.stopKeepAlive();
        this.sendKeepAlive();
        this.keepAliveInterval = setInterval(() => {
            this.sendKeepAlive();
        }, 20000);
        logger.debug('[API MACHINE] Keep-alive started (20s interval)');
    }

    private startSmartReconnect() {
        if (this.reconnectInterval) return;

        this.reconnectInterval = setInterval(() => {
            if (this.socket.connected) {
                clearInterval(this.reconnectInterval!);
                this.reconnectInterval = null;
                return;
            }
            if (!shouldReconnect()) {
                logger.debug('[API MACHINE] Still not ready to reconnect');
                return;
            }
            logger.debug('[API MACHINE] Attempting reconnect');
            this.socket.connect();
        }, 3000);

        if (shouldReconnect()) {
            logger.debug('[API MACHINE] Network up + lid open — reconnecting in 1s');
            setTimeout(() => { if (!this.socket.connected) this.socket.connect() }, 1000);
        }
    }

    private stopKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
            logger.debug('[API MACHINE] Keep-alive stopped');
        }
    }

    shutdown() {
        logger.debug('[API MACHINE] Shutting down');
        this.stopKeepAlive();
        if (this.reconnectInterval) {
            clearInterval(this.reconnectInterval);
            this.reconnectInterval = null;
        }
        if (this.socket) {
            this.socket.close();
            logger.debug('[API MACHINE] Socket closed');
        }
    }
}
