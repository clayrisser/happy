import os from 'node:os';
import { randomUUID } from 'node:crypto';

import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { loop } from '@/claude/loop';
import { AgentGoalStatus, AgentState, Metadata } from '@/api/types';
import packageJson from '../../package.json';
import { Credentials, readSettings } from '@/persistence';
import { ClaudeEffort, EnhancedMode, PermissionMode } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { parseSpecialCommand } from '@/parsers/specialCommands';
import { getEnvironmentInfo } from '@/ui/doctor';
import { configuration } from '@/configuration';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { initialMachineMetadata } from '@/daemon/run';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { startHookServer } from '@/claude/utils/startHookServer';
import { compactionLatch } from '@/claude/utils/compaction';
import { generateHookSettingsFile, cleanupHookSettingsFile } from '@/claude/utils/generateHookSettings';
import { registerKillSessionHandler } from './registerKillSessionHandler';
import { projectPath } from '../projectPath';
import { resolve } from 'node:path';
import { startOfflineReconnection, connectionState } from '@/utils/serverConnectionErrors';
import { claudeLocal } from '@/claude/claudeLocal';
import { createSessionScanner } from '@/claude/utils/sessionScanner';
import {
    CLAUDE_GOAL_ACTION_CONFIRMATIONS,
    claudeGoalActionCapabilities,
    mapClaudeGoalStatusEventToAgentGoalStatus,
    parseClaudeGoalActionParams,
    type ClaudeGoalStatusTranscriptEvent,
} from '@/claude/claudeGoalStatus';
import { applyCustomTitle, defaultSessionName, isDefaultSessionName, Session } from './session';
import { findCustomTitle } from './utils/customTitle';
import { applySandboxPermissionPolicy, normalizeRemotePermissionMode, resolveInitialClaudePermissionMode, resolveRemoteClaudePermissionMode } from './utils/permissionMode';
import { decodeBase64, encodeBase64 } from '@/api/encryption';
import type { Session as ApiSession } from '@/api/types';
import { getProjectPath, resolveClaudeConfigDir } from './utils/path';
import { discoverSessionInventory, formatSkillsAnswer, type SessionInventoryResponse } from '@/utils/sessionInventory';
import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RawJSONLinesSchema, type RawJSONLines } from './types';
import { FlipController, parseFlipCommand } from '@/drover/flip/controller';
import { modeCarryArgs, type ModeRequest } from './utils/modeCarry';
import { currentAccount, flippableAccounts, readAccounts } from '@/drover/flip/accounts';
import { CloneReporter, readSeedPrompt } from '@/drover/flip/clones';
import { UsageReporter } from '@/drover/flip/usage';
import { PolicyReporter } from '@/drover/flip/policy';
import { registerDroverPolicyHandler } from '@/drover/flip/policyRpc';
import { findHappySessionForClaudeSession, resumedClaudeSessionId } from '@/resume/reattachClaudeSession';
import type { ReconnectableHappySession } from '@/resume/resolveHappySession';
import { buildRelaunchArgv, relaunchExitCode, relaunchFileEnv, type RelaunchRequest } from '@/drover/relaunch/handover';
import { distEntrypoint, loadedDistStamp } from '@/drover/relaunch/stamp';

/** JavaScript runtime to use for spawning Claude Code */
export type JsRuntime = 'node' | 'bun'

export interface StartOptions {
    model?: string
    permissionMode?: PermissionMode
    effort?: ClaudeEffort
    startingMode?: 'local' | 'remote'
    shouldStartDaemon?: boolean
    claudeEnvVars?: Record<string, string>
    claudeArgs?: string[]
    startedBy?: 'daemon' | 'terminal'
    noSandbox?: boolean
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    jsRuntime?: JsRuntime
    /**
     * A file holding this session's first prompt (DROVE-58).
     *
     * `drover clone` writes one — a whole exported conversation — and passes
     * the PATH, because a seed is tens of kilobytes and a command line is
     * where one stray quote turns it into a syntax error. Read once, handed to
     * the first child only.
     */
    seedFile?: string
}

// No default permission mode. "Default" in the picker means "whatever this
// harness is already configured to do", so the mode is left unset and Claude
// applies its own settings. Substituting a value here — this used to be
// 'yolo' — silently overrode every user's Claude config with full access.
// The model works the same way: no default. This used to be 'opus', which
// pinned every remote turn to the 200K model even when the user's own Claude
// config (settings.json, ANTHROPIC_MODEL) said e.g. claude-opus-5[1m] (#1721).
const DEFAULT_CLAUDE_EFFORT: ClaudeEffort = 'medium';
type ClaudeGoalCommand = NonNullable<ReturnType<typeof parseClaudeGoalActionParams>>;
type PendingClaudeGoalAction = {
    command: ClaudeGoalCommand;
    resolve: (value: { ok: true }) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
};

/**
 * Should this launch refuse local mode? (DROVE-2)
 *
 * True only for a daemon spawn that got no pane. A daemon spawn that landed in
 * a tmux window reads its own `TMUX_PANE` and is a terminal session in every
 * way that matters.
 */
export function refusesDaemonLocalStart(
    startedBy: string | undefined,
    startingMode: string | undefined,
    tmuxPane: string | undefined,
): boolean {
    return startedBy === 'daemon' && startingMode === 'local' && !tmuxPane;
}

export async function runClaude(credentials: Credentials, options: StartOptions = {}): Promise<void> {
    logger.debug(`[CLAUDE] ===== CLAUDE MODE STARTING =====`);
    logger.debug(`[CLAUDE] This is the Claude agent, NOT Gemini`);
    
    const workingDirectory = process.cwd();
    const sessionTag = randomUUID();

    // Log environment info at startup
    logger.debugLargeJson('[START] Happy process started', getEnvironmentInfo());
    logger.debug(`[START] Options: startedBy=${options.startedBy}, startingMode=${options.startingMode}`);

    // Validate daemon spawn requirements - fail fast on invalid config
    //
    // DROVE-2: the daemon now spawns into a tmux window of the user's own
    // server, so a daemon-started session HAS a pane and local mode is exactly
    // right for it — that is what makes the terminal and the app one session.
    // The refusal stands only where its premise still holds: a daemon spawn
    // with no pane has no keyboard, so local mode would leave it with no input
    // at all.
    if (refusesDaemonLocalStart(options.startedBy, options.startingMode, process.env.TMUX_PANE)) {
        throw new Error('A daemon-spawned session with no tmux pane cannot use local/interactive mode. Use --happy-starting-mode remote, or spawn it into a tmux window.');
    }

    // Set backend for offline warnings (before any API calls)
    connectionState.setBackend('Claude');

    // Create session service
    const api = await ApiClient.create(credentials);

    // Create a new session
    let state: AgentState = {};

    // Get machine ID from settings (should already be set up)
    const settings = await readSettings();
    let machineId = settings?.machineId
    const sandboxConfig = options.noSandbox ? undefined : settings?.sandboxConfig;
    const sandboxEnabled = Boolean(sandboxConfig?.enabled);
    const initialPermissionMode = applySandboxPermissionPolicy(
        resolveInitialClaudePermissionMode(options.permissionMode, options.claudeArgs),
        sandboxEnabled,
    );
    const dangerouslySkipPermissions =
        initialPermissionMode === 'bypassPermissions' ||
        initialPermissionMode === 'yolo' ||
        sandboxEnabled ||
        Boolean(options.claudeArgs?.includes('--dangerously-skip-permissions'));
    if (!machineId) {
        console.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/slopus/happy-cli/issues`);
        process.exit(1);
    }
    logger.debug(`Using machineId: ${machineId}`);

    // Create machine if it doesn't exist
    await api.getOrCreateMachine({
        machineId,
        metadata: initialMachineMetadata
    });

    // Lineage from the daemon's spawn RPC (set by app-side fork / duplicate).
    const forkedFromSessionId = process.env.HAPPY_FORKED_FROM_SESSION_ID;
    const forkedFromMessageId = process.env.HAPPY_FORKED_FROM_MESSAGE_ID;
    const isSideChat = process.env.HAPPY_SIDE_CHAT === '1';

    // Name the session NOW, rather than leaving it "New chat" until something
    // happens to name it. Nothing ever did on the Claude path: the phone's
    // title is metadata.summary.text (getSessionName, happy-app
    // sources/utils/sessionUtils.ts) and the only writers of that are Claude's
    // own transcript summaries — which claudeLocalLauncher deliberately drops —
    // and the change_title MCP tool, which is only wired up for Gemini. So a
    // local session showed "New chat" over the project path for its whole life
    // unless a flip renamed it. `name` and `summary` are both stamped because
    // they feed different screens: `summary` is the title and the push body,
    // `name` is the command palette and the projects sidebar.
    // The account this session is on, NOT the stamp alone (DROVE-31). A bare
    // `drover` with no -a exports no DROVER_ACCOUNT, and `happy` never has,
    // so the stamp is absent for most sessions and both the name below and
    // metadata.droverAccount came out blank. currentAccount falls back to the
    // config dir this process is actually reading, which is what the account
    // IS. Undefined only when the registry knows nothing about it, and then
    // the name goes back to being unprefixed exactly as before.
    const startedOnAccount = process.env.DROVER_ACCOUNT || currentAccount()?.name;
    const startingSessionName = defaultSessionName(workingDirectory, startedOnAccount);

    // The picks the command line itself carried (DROVE-278). `--model` and
    // `--effort` parse into StartOptions and then went NOWHERE for a pane
    // session: nothing put them on the child's argv and the initial metadata
    // said nothing, so `drover --model X --effort Y` — the daemon-spawned
    // shape the phone uses included — quietly booted on defaults. Seeding
    // metadata below is the fix, because the launcher already routes EVERY
    // spawn, the first included, through `modeCarryArgs(session.claudeArgs,
    // requestedModes())`, and requestedModes() reads exactly these two
    // fields. One seed makes the argv carry, the app's display and
    // modeReconcileCommands' observed-vs-requested comparison all start
    // truthful instead of empty. The model skips `default` by the same rule
    // spawnModeArgs applies on the way in: Claude's "default" means "no
    // harness override", not a model to pin.
    const argvModeRequest: ModeRequest = {
        ...(options.model && options.model !== 'default' ? { modelMode: options.model } : {}),
        ...(options.effort ? { effortLevel: options.effort } : {}),
    };

    let metadata: Metadata = {
        path: workingDirectory,
        host: os.hostname(),
        version: packageJson.version,
        os: os.platform(),
        machineId: machineId,
        homeDir: os.homedir(),
        happyHomeDir: configuration.happyHomeDir,
        happyLibDir: projectPath(),
        happyToolsDir: resolve(projectPath(), 'tools', 'unpacked'),
        startedFromDaemon: options.startedBy === 'daemon',
        hostPid: process.pid,
        startedBy: options.startedBy || 'terminal',
        // Initialize lifecycle state
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor: 'claude',
        sandbox: sandboxConfig?.enabled ? sandboxConfig : null,
        dangerouslySkipPermissions,
        name: startingSessionName,
        summary: { text: startingSessionName, updatedAt: Date.now() },
        // Multi-account (BASED-98): `drover account` exports DROVER_ACCOUNT next to
        // CLAUDE_CONFIG_DIR; carrying it in the metadata gives the app a
        // per-account identity to show and filter on, and the account prefix
        // defaultSessionName puts on the two names above makes the account
        // visible today with no app changes.
        ...(startedOnAccount ? { droverAccount: startedOnAccount } : {}),
        ...(forkedFromSessionId ? { parentSessionId: forkedFromSessionId } : {}),
        ...(forkedFromMessageId ? { forkedFromMessageId } : {}),
        ...(isSideChat ? { isSideChat: true } : {}),
        // Spread as keys-only-when-present, so a reattach below — which lays
        // this fresh metadata over the stored session's — cannot erase a pick
        // the app already holds with an absent one (DROVE-278).
        ...argvModeRequest,
    };

    // Check for session reconnection env vars (set by daemon for resume-in-place)
    const reconnectSessionId = process.env.HAPPY_RECONNECT_SESSION_ID;
    const reconnectKeyBase64 = process.env.HAPPY_RECONNECT_ENCRYPTION_KEY;
    const reconnectVariant = process.env.HAPPY_RECONNECT_ENCRYPTION_VARIANT as 'legacy' | 'dataKey' | undefined;
    const reconnectSeq = process.env.HAPPY_RECONNECT_SEQ;
    const reconnectMetadataVersion = process.env.HAPPY_RECONNECT_METADATA_VERSION;
    const reconnectAgentStateVersion = process.env.HAPPY_RECONNECT_AGENT_STATE_VERSION;

    // Cattle Drover (BASED-98): `drover --resume <id>` used to mint a NEW Happy
    // session and the local scanner then replayed the whole transcript into it,
    // so the phone got a second copy of the conversation with old messages
    // streaming in as if new. The Claude id is known before the Happy session
    // exists, so reattach to the Happy session already holding that transcript
    // on the same path the daemon's resume takes through HAPPY_RECONNECT_*.
    // Nothing found (never tracked here, server down, another wrapper live on
    // it) falls back to a fresh session as before. A fork or side chat is a
    // new Happy session by definition, and an explicit reconnect already knows
    // where it is going.
    const forkClaudeSessionId = process.env.HAPPY_FORK_CLAUDE_SESSION_ID;
    let reattached: ReconnectableHappySession | null = null;
    // Which Claude transcript this run is resuming, when that is knowable
    // before the child starts. Kept beyond the reattach block because it is
    // also how the session's NAME is found below.
    let resumingClaudeSessionId: string | null = null;
    if (!reconnectSessionId && !forkClaudeSessionId && !isSideChat) {
        const claudeSessionId = resumedClaudeSessionId(options.claudeArgs, workingDirectory);
        resumingClaudeSessionId = claudeSessionId;
        if (claudeSessionId) {
            reattached = await findHappySessionForClaudeSession(claudeSessionId);
            if (reattached) {
                logger.debug(`[START] Reattaching to Happy session ${reattached.id} for Claude session ${claudeSessionId}`);
                // Keep what the app wrote (title, summary) under the runtime
                // fields this process owns, and bind the Claude id now so the
                // remote scanner pre-marks the transcript instead of replaying it.
                //
                // name/summary are pulled back out of that spread by hand,
                // because they are the one pair where the fresh value is a SEED
                // rather than a fact: startingSessionName exists only so a
                // brand-new session is not called "New chat", and letting it
                // win here would rename a session the user had already named,
                // on every resume. A default-shaped name is still ours though —
                // it may carry the wrong account's prefix now — so that one is
                // restamped rather than kept.
                metadata = {
                    ...reattached.metadata,
                    ...metadata,
                    name: isDefaultSessionName(reattached.metadata.name, workingDirectory)
                        ? startingSessionName
                        : reattached.metadata.name,
                    summary: isDefaultSessionName(reattached.metadata.summary?.text, workingDirectory)
                        ? { text: startingSessionName, updatedAt: Date.now() }
                        : reattached.metadata.summary,
                    claudeSessionId,
                };
            } else {
                logger.debug(`[START] No Happy session holds Claude session ${claudeSessionId}, starting a fresh one`);
            }
        }
    }

    // The name Claude Code is showing beats both of ours (DROVE-15).
    //
    // startingSessionName is a seed for a session nobody has named, and the
    // reattached title is whatever the app last knew — but `/rename` in an
    // earlier run wrote the real name to disk and neither of those reads it.
    // Clay renamed a session DROVER, quit, ran `drover --resume`, and the app
    // header said "cattle-drover" while the terminal said DROVER. Only a title
    // that actually exists overrides anything: no file means no opinion.
    //
    // Bare `--resume` (the picker) has no id to look up yet, so it is the
    // SessionStart hook below that names those.
    const resumingCustomTitle = resumingClaudeSessionId
        ? findCustomTitle({
            sessionId: resumingClaudeSessionId,
            workingDirectory,
            claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
        })
        : null;
    if (resumingCustomTitle) {
        logger.debug(`[START] Claude Code calls this session "${resumingCustomTitle}"`);
        metadata = {
            ...metadata,
            name: resumingCustomTitle,
            summary: { text: resumingCustomTitle, updatedAt: Date.now() },
        };
    }

    let response: ApiSession | null;
    if (reconnectSessionId && reconnectKeyBase64 && reconnectVariant) {
        logger.debug(`[START] Reconnecting to existing session ${reconnectSessionId}`);
        response = {
            id: reconnectSessionId,
            seq: parseInt(reconnectSeq || '0', 10),
            encryptionKey: decodeBase64(reconnectKeyBase64),
            encryptionVariant: reconnectVariant,
            metadata,
            metadataVersion: parseInt(reconnectMetadataVersion || '0', 10),
            agentState: state,
            agentStateVersion: parseInt(reconnectAgentStateVersion || '0', 10),
        };
    } else if (reattached) {
        response = {
            id: reattached.id,
            seq: reattached.seq,
            encryptionKey: reattached.encryptionKey,
            encryptionVariant: reattached.encryptionVariant,
            metadata,
            metadataVersion: reattached.metadataVersion,
            agentState: state,
            agentStateVersion: reattached.agentStateVersion,
        };
    } else {
        response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    }

    // Handle server unreachable case - run Claude locally with hot reconnection
    // Note: connectionState.notifyOffline() was already called by api.ts with error details
    if (!response) {
        let offlineSessionId: string | null = null;

        const reconnection = startOfflineReconnection({
            serverUrl: configuration.serverUrl,
            onReconnected: async () => {
                const resp = await api.getOrCreateSession({ tag: randomUUID(), metadata, state });
                if (!resp) throw new Error('Server unavailable');
                const session = api.sessionSyncClient(resp);
                let latestClaudeGoalStatus: AgentGoalStatus | null = null;
                const observedClaudeGoalRevisions = new Set<string>();
                const goalCommandSupported = () => {
                    const slashCommands = session.getMetadata()?.slashCommands ?? [];
                    return slashCommands.includes('goal') || slashCommands.includes('/goal');
                };
                const currentClaudeSessionId = () => session.getMetadata()?.claudeSessionId ?? null;
                const updateClaudeGoalState = (event: ClaudeGoalStatusTranscriptEvent) => {
                    if (observedClaudeGoalRevisions.has(event.sourceRevision)) {
                        return;
                    }
                    const capabilities = claudeGoalActionCapabilities({
                        goalCommandSupported: goalCommandSupported(),
                        observedGoalStatus: true,
                        confirmedActions: CLAUDE_GOAL_ACTION_CONFIRMATIONS,
                    });
                    const goalStatus = mapClaudeGoalStatusEventToAgentGoalStatus(
                        event,
                        currentClaudeSessionId(),
                        capabilities ? { capabilities } : undefined,
                    );
                    if (!goalStatus) {
                        return;
                    }
                    observedClaudeGoalRevisions.add(event.sourceRevision);
                    latestClaudeGoalStatus = goalStatus;
                    session.updateAgentState((current) => ({
                        ...current,
                        agentGoalStatus: latestClaudeGoalStatus ?? goalStatus,
                    }));
                };
                const scanner = await createSessionScanner({
                    sessionId: null,
                    workingDirectory,
                    onMessage: (msg) => {
                        void session.sendClaudeSessionMessageFromLocalTranscript(msg);
                    },
                    onTranscriptEvent: updateClaudeGoalState,
                });
                if (offlineSessionId) scanner.onNewSession(offlineSessionId);
                return { session, scanner };
            },
            onNotify: console.log,
            onCleanup: () => {
                // Scanner cleanup handled automatically when process exits
            }
        });

        try {
            await claudeLocal({
                path: workingDirectory,
                sessionId: null,
                onSessionFound: (id) => { offlineSessionId = id; },
                onThinkingChange: () => {},
                abort: new AbortController().signal,
                claudeEnvVars: options.claudeEnvVars,
                // Offline has no session metadata for the launcher's carry to
                // read, so the argv-borne picks go on here through the same
                // helper the flip path uses (DROVE-278).
                claudeArgs: modeCarryArgs(options.claudeArgs, argvModeRequest),
                mcpServers: {},
                allowedTools: [],
                sandboxConfig,
            });
        } finally {
            reconnection.cancel();
        }
        process.exit(0);
    }

    logger.debug(`Session created: ${response.id}`);

    // Always report to daemon if it exists
    try {
        logger.debug(`[START] Reporting session ${response.id} to daemon`);
        const result = await notifyDaemonSessionStarted(response.id, metadata, {
            encryptionKey: encodeBase64(response.encryptionKey),
            encryptionVariant: response.encryptionVariant,
            seq: response.seq,
            metadataVersion: response.metadataVersion,
            agentStateVersion: response.agentStateVersion,
        });
        if (result.error) {
            logger.debug(`[START] Failed to report to daemon (may not be running):`, result.error);
        } else {
            logger.debug(`[START] Reported session ${response.id} to daemon`);
        }
    } catch (error) {
        logger.debug('[START] Failed to report to daemon (may not be running):', error);
    }

    // SDK metadata (tools, slash commands) is now extracted from the
    // system.init message in claudeRemote.ts via onSDKMetadata callback

    // Create realtime session
    const session = api.sessionSyncClient(response);

    // On reconnect, un-archive the session and skip replaying old messages.
    // A reattached resume is a reconnect the wrapper worked out for itself.
    if (reconnectSessionId || reattached) {
        session.suppressNextArchiveSignal();
        session.skipExistingMessages();
        session.updateMetadata((meta) => ({
            ...meta,
            lifecycleState: 'running',
            archivedBy: undefined,
        }));
    }

    // Fork backfill: when this Happy session was just spawned as a fork
    // of another (HAPPY_FORK_CLAUDE_SESSION_ID is set by the daemon at
    // spawn time), the fresh server-side message log is empty but the
    // copied Claude JSONL on disk has the full prior conversation. The
    // SDK with `resume:` reads that JSONL silently — it never re-emits
    // historical messages back to the Happy client — so without an
    // explicit backfill the user lands in an empty chat.
    //
    // Read the JSONL once before any SDK invocation and push every line
    // through sendClaudeSessionMessage so the protocol mapper produces
    // proper user/agent envelopes. SDK messages from later turns then
    // continue from the same mapper state.
    //
    // Skipped on reconnect (HAPPY_RECONNECT_*) — that path reattaches
    // to the existing Happy session, where the server already has every
    // message it needs.
    if (!reconnectSessionId && forkClaudeSessionId) {
        // Side chats resume the forked JSONL for full model context via the
        // SDK (`resume:`), but we deliberately do NOT replay the pre-fork
        // history into the UI — a side chat starts empty from the moment it
        // was opened, so the user only sees the aside they began.
        if (!isSideChat) {
            const jsonlPath = join(getProjectPath(workingDirectory), `${forkClaudeSessionId}.jsonl`);
            try {
                const file = await readFile(jsonlPath, 'utf-8');
                const lines = file.split('\n');
                let backfilled = 0;
                for (const line of lines) {
                    if (line.trim().length === 0) continue;
                    let parsed: unknown;
                    try { parsed = JSON.parse(line); } catch { continue; }
                    const result = RawJSONLinesSchema.safeParse(parsed);
                    if (!result.success) continue;
                    await session.sendClaudeSessionMessageFromLocalTranscript(result.data as RawJSONLines);
                    backfilled += 1;
                }
                logger.debug(`[FORK BACKFILL] Replayed ${backfilled} historical messages from ${jsonlPath}`);
            } catch (error) {
                logger.debug(`[FORK BACKFILL] Failed to read ${jsonlPath}:`, error);
            }
        }
        // Bind the new Happy session to the forked Claude UUID up front so the
        // metadata is consistent the moment the app opens this session — even
        // before the SDK's hook callback fires. Done regardless of backfill.
        session.updateMetadata((meta) => ({ ...meta, claudeSessionId: forkClaudeSessionId }));
    }

    // Ring buffer of user prompts that just arrived from the app via the
    // legacy `sentFrom: 'web'` channel. The remote-mode session scanner
    // (started below) walks the on-disk Claude JSONL looking for prompts
    // that landed in the file but never reached the server — i.e. the
    // ones the user typed in a `claude --resume <id>` terminal sitting
    // alongside this Happy session. App-sent prompts also land in the
    // JSONL once the SDK writes them, so we'd double-forward them
    // without this dedupe. Match by content within a short time window;
    // entries older than 5 minutes roll off so unrelated future prompts
    // with identical text still get through from the terminal side.
    const recentAppPromptsMaxAgeMs = 5 * 60 * 1000;
    const recentAppPrompts: Array<{ text: string; addedAt: number }> = [];
    const recordAppPrompt = (text: string) => {
        const now = Date.now();
        recentAppPrompts.push({ text, addedAt: now });
        const cutoff = now - recentAppPromptsMaxAgeMs;
        while (recentAppPrompts.length > 0 && recentAppPrompts[0].addedAt < cutoff) {
            recentAppPrompts.shift();
        }
    };
    const consumeAppPrompt = (text: string): boolean => {
        const cutoff = Date.now() - recentAppPromptsMaxAgeMs;
        for (let i = 0; i < recentAppPrompts.length; i++) {
            const entry = recentAppPrompts[i];
            if (entry.addedAt < cutoff) continue;
            if (entry.text === text) {
                recentAppPrompts.splice(i, 1);
                return true;
            }
        }
        return false;
    };

    let currentRunMode: 'local' | 'remote' = options.startingMode ?? 'local';
    // The running Session, set by the onSessionReady callback loop() fires.
    // Declared before the goal state below rather than beside the hook server,
    // because the goal carrier has to ask it whether a pane is listening and
    // the scanner can report a goal before that far down the file (DROVE-78).
    let currentSession: Session | null = null;
    let latestClaudeGoalStatus: AgentGoalStatus | null = null;
    const observedClaudeGoalRevisions = new Set<string>();
    let pendingClaudeGoalAction: PendingClaudeGoalAction | null = null;
    /**
     * The carrier that would run `/goal` for this session right now, or null.
     *
     * Remote mode has one always: the message queue, which the SDK drains.
     * Local mode has one only while claudeLocalLauncher owns a tmux pane
     * (DROVE-78). A paneless local run has no terminal and no query(), so
     * there is genuinely nowhere to send the command, and saying so is the
     * point of returning null rather than throwing later.
     */
    const goalActionCarrier = (): 'queue' | 'pane' | null => {
        if (currentRunMode === 'remote') return 'queue';
        return (currentSession as Session | null)?.paneSlashCommandCarrier ? 'pane' : null;
    };
    const goalCommandSupported = () => {
        const slashCommands = session.getMetadata()?.slashCommands ?? [];
        if (slashCommands.includes('goal') || slashCommands.includes('/goal')) {
            return true;
        }
        // metadata.slashCommands is written from the SDK's system init, which
        // only the remote launcher ever runs. A pane session has no query()
        // to enumerate its commands, so the list is empty for every session
        // under one mode and this used to read as "no /goal here" (DROVE-78).
        // The pane's Claude is the same binary that wrote the goal_status
        // record we are answering, so a live pane carrier IS the answer.
        return goalActionCarrier() === 'pane';
    };
    const currentClaudeSessionId = () => session.getMetadata()?.claudeSessionId ?? null;
    const settlePendingClaudeGoalAction = (goalStatus: AgentGoalStatus) => {
        if (!pendingClaudeGoalAction) {
            return;
        }

        const pending = pendingClaudeGoalAction;
        if (pending.command.type === 'clear' && goalStatus.status === 'inactive') {
            clearTimeout(pending.timeout);
            pendingClaudeGoalAction = null;
            pending.resolve({ ok: true });
            return;
        }

        if (
            pending.command.type === 'set'
            && goalStatus.status === 'active'
            && goalStatus.text.trim() === pending.command.objective.trim()
        ) {
            clearTimeout(pending.timeout);
            pendingClaudeGoalAction = null;
            pending.resolve({ ok: true });
        }
    };
    const updateClaudeGoalState = (event: ClaudeGoalStatusTranscriptEvent) => {
        if (observedClaudeGoalRevisions.has(event.sourceRevision)) {
            return;
        }
        const capabilities = claudeGoalActionCapabilities({
            goalCommandSupported: goalCommandSupported(),
            observedGoalStatus: true,
            confirmedActions: CLAUDE_GOAL_ACTION_CONFIRMATIONS,
        });
        const goalStatus = mapClaudeGoalStatusEventToAgentGoalStatus(
            event,
            currentClaudeSessionId(),
            capabilities ? { capabilities } : undefined,
        );
        if (!goalStatus) {
            return;
        }
        observedClaudeGoalRevisions.add(event.sourceRevision);
        latestClaudeGoalStatus = goalStatus;
        settlePendingClaudeGoalAction(goalStatus);
        session.updateAgentState((current) => ({
            ...current,
            agentGoalStatus: latestClaudeGoalStatus ?? goalStatus,
        }));
    };

    // Remote-mode session scanner: catches user-typed prompts that
    // appeared in the Claude JSONL while we weren't looking — typically
    // because the user opened `claude --resume <id>` in a terminal next
    // to the running Happy session. SDK-emitted assistant + tool_result
    // user messages keep flowing through the existing sdkToLogConverter
    // pipeline; the scanner here only forwards things that pipeline
    // can't see.
    const initialScannerSessionId = forkClaudeSessionId
        ?? (metadata.claudeSessionId ?? null);
    const remoteScanner = await createSessionScanner({
        sessionId: initialScannerSessionId,
        workingDirectory,
        onMessage: (raw) => {
            if (currentRunMode !== 'remote') return;
            // Only user-typed prompts. SDK pipeline owns assistant and
            // tool_result-bearing user messages.
            if (raw.type !== 'user') return;
            if ((raw as any).isSidechain) return;
            const content = (raw as any).message?.content;
            if (typeof content !== 'string') return;
            // Drop empty / whitespace-only lines.
            if (content.trim().length === 0) return;
            // App-sent prompts will show up here because the SDK
            // writes them to the JSONL — dedupe by content.
            if (consumeAppPrompt(content)) return;
            session.sendClaudeSessionMessage(raw);
        },
        onTranscriptEvent: updateClaudeGoalState,
    });

    // DROVE-93: the subagent transcript RPC, answered off the remote-mode
    // scanner until a local launch registers its own (which follows a flip).
    session.rpcHandlerManager.registerHandler('subagentTranscript', async (params: unknown) =>
        remoteScanner.readSubagentTranscript((params ?? {}) as Parameters<typeof remoteScanner.readSubagentTranscript>[0]));

    // DROVE-290: the wave view of one workflow run, answered off the same
    // scanner until a local launch registers its own.
    session.rpcHandlerManager.registerHandler('workflowDetail', async (params: unknown) =>
        remoteScanner.readWorkflowDetail((params ?? {}) as Parameters<typeof remoteScanner.readWorkflowDetail>[0]));

    // DROVE-170: what THIS session can be asked to run. registerCommonHandlers
    // already answered it from the ambient environment; this replaces it with
    // one that reads the account the session is on right now. A drover flip
    // (BASED-98) rewrites CLAUDE_CONFIG_DIR on the Session and never on this
    // process's env, and each account is its own commands/ and skills/ tree, so
    // asking the environment would keep answering with the account we left.
    session.rpcHandlerManager.registerHandler<Record<string, never>, SessionInventoryResponse>(
        'sessionInventory',
        async () => {
            try {
                return {
                    success: true,
                    inventory: await discoverSessionInventory({
                        flavor: 'claude',
                        cwd: workingDirectory,
                        configDir: resolveClaudeConfigDir(
                            (currentSession as Session | null)?.claudeEnvVars?.CLAUDE_CONFIG_DIR,
                        ),
                    }),
                };
            } catch (error) {
                logger.debug('[INVENTORY] Failed to read session inventory:', error);
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Failed to read session inventory',
                };
            }
        },
    );

    // Start Happy MCP server
    const happyServer = await startHappyServer(session);
    logger.debug(`[START] Happy MCP server started at ${happyServer.url}`);

    // Declared up here because the SessionStart hook below has to tell it when
    // Claude mints a new session id, and the hook is installed long before the
    // reporter is built (DROVE-3). A new id is a new key in the settings store,
    // so the overrides have to move with it or a flip drops its own policy.
    let policyReporter: PolicyReporter | undefined;

    // Start Hook server for receiving Claude session notifications
    const hookServer = await startHookServer({
        // DROVE-257: the compaction has started. Nothing else in this process
        // can tell — the transcript stops moving for the length of the pass —
        // so this is the whole of how the purple dot ever lights.
        onPreCompact: (data) => {
            const trigger = data.trigger === 'manual' || data.trigger === 'auto' ? data.trigger : undefined;
            logger.debug(`[START] PreCompact hook received (trigger: ${trigger ?? 'unknown'})`);
            compactionLatch.begin(trigger);
        },
        onSessionHook: (sessionId, data) => {
            logger.debug(`[START] Session hook received: ${sessionId}`, data);

            // A SESSION THAT STARTS ON A COMPACTED TRANSCRIPT IS PAST THE PASS
            // (DROVE-257). The live status reader closes the latch on the
            // `compact_boundary` record, which is the reliable end; this is the
            // second one, and it earns its place because a compaction mints a
            // fresh session id and the reader is re-pointed at the NEW
            // transcript — which has no boundary line in it — the moment this
            // hook fires.
            if (data.source === 'compact') {
                logger.debug('[START] Session restarted on a compacted transcript — compaction is over');
                compactionLatch.end();
            }

            // Tell the remote scanner about this sessionId so it knows
            // which JSONL to watch (and so it can fire onNewSession for
            // claude --resume hand-offs that mint a fresh session id).
            //
            // In remote mode every user prompt arrives via the SDK or the
            // app channel — both of which already deliver their messages
            // to the server before they hit disk. Anything the scanner
            // finds in the JSONL at the moment it learns the session id
            // is therefore already on the server; treating it as fresh
            // (the previous behavior) replayed the whole history back to
            // the chat on reconnect. The scanner's real job is forwarding
            // *future* JSONL writes from a parallel `claude --resume`
            // terminal, which the file watcher will pick up.
            remoteScanner.onNewSession(sessionId, { treatExistingAsProcessed: true });

            // Update session ID in the Session instance
            if (currentSession) {
                const previousSessionId = currentSession.sessionId;
                if (previousSessionId !== sessionId) {
                    logger.debug(`[START] Claude session ID changed: ${previousSessionId} -> ${sessionId}`);
                    currentSession.onSessionFound(sessionId);
                    // The settings store is keyed by this id (DROVE-3), so the
                    // policy follows the session across a flip, a resume or a
                    // /clear instead of silently reverting to the defaults.
                    void policyReporter?.sessionFound(sessionId);
                }
            }

            // And take the name it came with (DROVE-15). Every SessionStart
            // payload carries session_title — what Claude Code is calling this
            // session RIGHT NOW — and it was read by nothing, so a rename made
            // in an earlier run never reached the app. This is the only source
            // that covers a bare `drover --resume`, where the picker means the
            // session id does not exist until this hook fires, and a session
            // renamed before its transcript carried a custom-title record.
            const hookTitle = typeof data.session_title === 'string' ? data.session_title.trim() : '';
            if (hookTitle && currentSession) {
                applyCustomTitle(currentSession, hookTitle);
            }
        }
    });
    logger.debug(`[START] Hook server started on port ${hookServer.port}`);

    // Generate hook settings file for Claude
    const hookSettingsPath = generateHookSettingsFile(hookServer.port);
    logger.debug(`[START] Generated hook settings file: ${hookSettingsPath}`);

    // Print log file path
    const logPath = logger.logFilePath;
    logger.infoDeveloper(`Session: ${response.id}`);
    logger.infoDeveloper(`Logs: ${logPath}`);

    // Set initial agent state
    session.updateAgentState((currentState) => ({
        ...currentState,
        controlledByUser: options.startingMode !== 'remote'
    }));

    // Import MessageQueue2 and create message queue
    const messageQueue = new MessageQueue2<EnhancedMode>(mode => hashObject({
        isPlan: mode.permissionMode === 'plan',
        model: mode.model,
        fallbackModel: mode.fallbackModel,
        customSystemPrompt: mode.customSystemPrompt,
        appendSystemPrompt: mode.appendSystemPrompt,
        allowedTools: mode.allowedTools,
        disallowedTools: mode.disallowedTools,
        effort: mode.effort,
    }));

    // Forward messages to the queue
    // Permission modes: Use the unified 7-mode type, mapping happens at SDK boundary in claudeRemote.ts
    let currentPermissionMode: PermissionMode | undefined = initialPermissionMode;
    // Undefined means "no override" and lets Claude resolve the model itself —
    // same contract as the mid-session reset below (meta.model null → undefined).
    let currentModel: string | undefined = options.model;
    let currentFallbackModel: string | undefined = undefined; // Track current fallback model
    let currentCustomSystemPrompt: string | undefined = undefined; // Track current custom system prompt
    let currentAppendSystemPrompt: string | undefined = undefined; // Track current append system prompt
    let currentAllowedTools: string[] | undefined = undefined; // Track current allowed tools
    let currentDisallowedTools: string[] | undefined = undefined; // Track current disallowed tools
    let currentEffort: ClaudeEffort | undefined = options.effort ?? DEFAULT_CLAUDE_EFFORT; // Track current Claude effort (thinking depth)

    const resetCurrentModeDefaults = () => {
        // Model and effort are deliberately NOT reset here. The app sends them
        // only when the user changes the picker, so resetting them on abort
        // silently desyncs the picker from what the next turn actually runs.
        currentPermissionMode = initialPermissionMode;
        currentFallbackModel = undefined;
        currentCustomSystemPrompt = undefined;
        currentAppendSystemPrompt = undefined;
        currentAllowedTools = undefined;
        currentDisallowedTools = undefined;
        logger.debug('[loop] Reset current mode defaults after abort');
    };
    const currentEnhancedMode = (): EnhancedMode => ({
        // Deliberately not coerced to 'default': undefined means "no override",
        // which the SDK reads as "use Claude's own configuration". Coercing it
        // would pin every unset session to prompting mode.
        permissionMode: currentPermissionMode,
        model: currentModel,
        fallbackModel: currentFallbackModel,
        customSystemPrompt: currentCustomSystemPrompt,
        appendSystemPrompt: currentAppendSystemPrompt,
        allowedTools: currentAllowedTools,
        disallowedTools: currentDisallowedTools,
        effort: currentEffort,
    });

    session.rpcHandlerManager.registerHandler('goal-action', async (params: unknown) => {
        const actionParams = params && typeof params === 'object' && !Array.isArray(params)
            ? params as Record<string, unknown>
            : null;
        const command = actionParams ? parseClaudeGoalActionParams(actionParams) : null;
        if (!command) {
            throw new Error('Unsupported Claude goal action');
        }
        if (pendingClaudeGoalAction) {
            throw new Error('Claude goal action already in progress');
        }
        if (!latestClaudeGoalStatus || latestClaudeGoalStatus.status !== 'active') {
            throw new Error('No active Claude goal');
        }

        const capabilities = latestClaudeGoalStatus.capabilities ?? {};
        if (command.type === 'clear' && !capabilities.clear) {
            throw new Error('Claude clear goal action is not supported');
        }
        if (command.type === 'set' && !capabilities.edit) {
            throw new Error('Claude edit goal action is not supported');
        }
        const slashCommand = command.type === 'clear'
            ? '/goal clear'
            : `/goal ${command.objective}`;

        // DROVE-78: a local session used to stop here, and under one mode
        // (DROVE-1) EVERY session is local, so the app's goal card was dead for
        // every real session. The pane has a carrier: the same idle-gated
        // command queue `/model` takes (DROVE-45) and the same one a slash
        // command typed on the phone takes (DROVE-49). It is not the inbox
        // socket that carries an ordinary message (DROVE-77): Claude Code's
        // uds handler hardcodes `skipSlashCommands:true` on everything it
        // reads off that socket, so `/goal ship it` written there arrives as
        // three words of prose (see the header of utils/inboxSocket.ts).
        //
        // Nothing is pasted on hope. The queue waits for Claude's own registry
        // to say idle, for the bus to hold no pending question, for the pane
        // to still be running Claude, and for every async subagent to have
        // reported in, so the command cannot land on whichever agent the
        // terminal is showing. Held, never drafted.
        const carrier = goalActionCarrier();
        if (carrier === 'pane') {
            const deliver = (currentSession as Session | null)?.paneSlashCommandCarrier;
            if (!deliver) {
                throw new Error('Claude goal action is not ready: the terminal is not listening');
            }
            const accepted = await deliver(slashCommand);
            if (!accepted) {
                throw new Error(
                    'Claude goal action did not reach the terminal: nothing is running in this '
                    + 'session\'s pane right now',
                );
            }
            // Resolved on acceptance, not on confirmation. The command may be
            // held for the prompt for as long as a subagent runs, which is
            // longer than any RPC should sit open, and the launcher tells the
            // phone it is waiting. The goal itself comes back the way it
            // always does, as a goal_status record the scanner reads.
            return { ok: true };
        }
        if (!carrier) {
            // A local session with no pane: no query() and no terminal, so
            // there is no way at all to run /goal. Said plainly rather than
            // dressed up as "not ready": nothing is going to make it ready.
            throw new Error(
                'Claude goal action needs a terminal: this session has no pane to run /goal in',
            );
        }
        if (!currentSession || currentSession.thinking) {
            throw new Error('Claude goal action is not ready while Claude is thinking');
        }
        if (messageQueue.size() > 0) {
            throw new Error('Claude message queue is busy');
        }

        const mode = currentEnhancedMode();

        return await new Promise<{ ok: true }>((resolve, reject) => {
            const timeout = setTimeout(() => {
                pendingClaudeGoalAction = null;
                reject(new Error('Timed out waiting for Claude goal confirmation'));
            }, 30000);

            pendingClaudeGoalAction = { command, resolve, reject, timeout };
            try {
                messageQueue.pushIsolated(slashCommand, mode);
            } catch (error) {
                clearTimeout(timeout);
                pendingClaudeGoalAction = null;
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    });

    // Exit when session is archived from web/mobile
    session.on('archived', () => {
        logger.debug('[loop] Session archived from web/mobile, cleaning up...');
        cleanup();
    });

    // Handle file events — each download promise resolves to its own decoded
    // attachment (or null). drainAttachmentsForUserMessage on the next text
    // claims the in-flight set atomically; later file events go into a fresh
    // bucket bound to the next message — no shared push-array between batches.
    session.onFileEvent((fileEvent) => {
        const ev = fileEvent.content.data.ev;
        logger.debug(`[loop] File event received: ${ev.name} (${ev.size} bytes, ref: ${ev.ref})`);
        const downloadPromise = (async (): Promise<{ data: Uint8Array; mimeType: string; name: string } | null> => {
            try {
                const decrypted = await session.downloadAndDecryptAttachment(ev.ref);
                if (!decrypted) {
                    logger.debug(`[loop] Failed to decrypt attachment: ${ev.name}`);
                    return null;
                }
                logger.debug(`[loop] Attachment decrypted: ${ev.name} (${decrypted.length} bytes)`);
                return { data: decrypted, mimeType: ev.mimeType ?? 'image/jpeg', name: ev.name };
            } catch (error) {
                logger.debug(`[loop] Failed to download attachment: ${ev.name}`, { error });
                return null;
            }
        })();
        session.trackAttachmentDownload(downloadPromise);
    });

    session.onUserMessage(async (message) => {

        // Stamp the prompt so the remote-mode JSONL scanner can dedupe
        // it later — the SDK is about to write this same text to disk
        // with a real Claude uuid, and we don't want to re-forward it.
        if (message?.content?.text) {
            recordAppPrompt(message.content.text);
        }

        // Claim every file attachment that arrived strictly before this text.
        // New file events from this point on belong to the next user message.
        const attachmentsForThisMessage = await session.drainAttachmentsForUserMessage();

        // Resolve permission mode from meta - pass through as-is, mapping happens at SDK boundary
        let messagePermissionMode: PermissionMode | undefined = currentPermissionMode;
        if (message.meta?.permissionMode) {
            const previousPermissionMode = currentPermissionMode;
            messagePermissionMode = resolveRemoteClaudePermissionMode(
                currentPermissionMode,
                normalizeRemotePermissionMode(message.meta.permissionMode),
                sandboxEnabled,
            );
            currentPermissionMode = messagePermissionMode;
            const ignoredDefaultDowngrade =
                (previousPermissionMode === 'bypassPermissions' || previousPermissionMode === 'yolo')
                && message.meta.permissionMode === 'default'
                && currentPermissionMode === previousPermissionMode;
            if (ignoredDefaultDowngrade) {
                logger.debug(`[loop] Ignoring permission mode downgrade from ${previousPermissionMode} to default`);
            } else {
                logger.debug(`[loop] Permission mode updated from user message to: ${currentPermissionMode}`);
            }
        } else {
            logger.debug(`[loop] User message received with no permission mode override, using current: ${currentPermissionMode}`);
        }

        // Resolve model - use message.meta.model if provided, otherwise use current model
        let messageModel = currentModel;
        if (message.meta?.hasOwnProperty('model')) {
            messageModel = message.meta.model || undefined; // null becomes undefined
            currentModel = messageModel;
            logger.debug(`[loop] Model updated from user message: ${messageModel || 'reset to default'}`);
        } else {
            logger.debug(`[loop] User message received with no model override, using current: ${currentModel || 'default'}`);
        }

        // Resolve custom system prompt - use message.meta.customSystemPrompt if provided, otherwise use current
        let messageCustomSystemPrompt = currentCustomSystemPrompt;
        if (message.meta?.hasOwnProperty('customSystemPrompt')) {
            messageCustomSystemPrompt = message.meta.customSystemPrompt || undefined; // null becomes undefined
            currentCustomSystemPrompt = messageCustomSystemPrompt;
            logger.debug(`[loop] Custom system prompt updated from user message: ${messageCustomSystemPrompt ? 'set' : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no custom system prompt override, using current: ${currentCustomSystemPrompt ? 'set' : 'none'}`);
        }

        // Resolve fallback model - use message.meta.fallbackModel if provided, otherwise use current fallback model
        let messageFallbackModel = currentFallbackModel;
        if (message.meta?.hasOwnProperty('fallbackModel')) {
            messageFallbackModel = message.meta.fallbackModel || undefined; // null becomes undefined
            currentFallbackModel = messageFallbackModel;
            logger.debug(`[loop] Fallback model updated from user message: ${messageFallbackModel || 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no fallback model override, using current: ${currentFallbackModel || 'none'}`);
        }

        // Resolve append system prompt - use message.meta.appendSystemPrompt if provided, otherwise use current
        let messageAppendSystemPrompt = currentAppendSystemPrompt;
        if (message.meta?.hasOwnProperty('appendSystemPrompt')) {
            messageAppendSystemPrompt = message.meta.appendSystemPrompt || undefined; // null becomes undefined
            currentAppendSystemPrompt = messageAppendSystemPrompt;
            logger.debug(`[loop] Append system prompt updated from user message: ${messageAppendSystemPrompt ? 'set' : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no append system prompt override, using current: ${currentAppendSystemPrompt ? 'set' : 'none'}`);
        }

        // Resolve allowed tools - use message.meta.allowedTools if provided, otherwise use current
        let messageAllowedTools = currentAllowedTools;
        if (message.meta?.hasOwnProperty('allowedTools')) {
            messageAllowedTools = message.meta.allowedTools || undefined; // null becomes undefined
            currentAllowedTools = messageAllowedTools;
            logger.debug(`[loop] Allowed tools updated from user message: ${messageAllowedTools ? messageAllowedTools.join(', ') : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no allowed tools override, using current: ${currentAllowedTools ? currentAllowedTools.join(', ') : 'none'}`);
        }

        // Resolve disallowed tools - use message.meta.disallowedTools if provided, otherwise use current
        let messageDisallowedTools = currentDisallowedTools;
        if (message.meta?.hasOwnProperty('disallowedTools')) {
            messageDisallowedTools = message.meta.disallowedTools || undefined; // null becomes undefined
            currentDisallowedTools = messageDisallowedTools;
            logger.debug(`[loop] Disallowed tools updated from user message: ${messageDisallowedTools ? messageDisallowedTools.join(', ') : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no disallowed tools override, using current: ${currentDisallowedTools ? currentDisallowedTools.join(', ') : 'none'}`);
        }

        // Resolve effort — pass through to Claude SDK as the `effort` option.
        // Validate against the SDK's accepted set so a stale/garbage value
        // from the wire doesn't poison the session.
        let messageEffort = currentEffort;
        const VALID_EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
        if (message.meta?.hasOwnProperty('effort')) {
            const incoming = (message.meta as Record<string, unknown>).effort;
            if (incoming === null || incoming === undefined) {
                messageEffort = undefined;
                currentEffort = undefined;
                logger.debug(`[loop] Effort reset to default`);
            } else if (typeof incoming === 'string' && VALID_EFFORTS.has(incoming)) {
                messageEffort = incoming as ClaudeEffort;
                currentEffort = messageEffort;
                logger.debug(`[loop] Effort updated from user message: ${messageEffort}`);
            } else {
                logger.debug(`[loop] Ignoring invalid effort from user message: ${String(incoming)}`);
            }
        } else {
            logger.debug(`[loop] User message received with no effort override, using current: ${currentEffort ?? 'default'}`);
        }

        // Cattle Drover (BASED-98): `/flip` is a command to the WRAPPER, never
        // a turn for Claude, so it is taken here — before the queue — and not
        // only in the local launcher.
        //
        // The local launcher intercepts it too, and that is not redundant: it
        // catches a message already sitting in the queue. But local-only was a
        // real hole, because the phone's and the watch's flip buttons send
        // exactly this string, and in REMOTE mode it sailed past into the
        // conversation and Claude answered a slash command at Clay instead of
        // the session changing account.
        if (flipController) {
            const flipRequest = parseFlipCommand(message.content.text);
            if (flipRequest) {
                logger.debug('[flip] /flip received from the app');
                flipController.request(flipRequest);
                return;
            }
        }

        // Check for special commands before processing
        const specialCommand = parseSpecialCommand(message.content.text);

        if (specialCommand.type === 'compact') {
            logger.debug('[start] Detected /compact command');
            messageQueue.pushIsolateAndClear(specialCommand.originalMessage || message.content.text, currentEnhancedMode(), attachmentsForThisMessage);
            logger.debugLargeJson('[start] /compact command pushed to queue:', message);
            return;
        }

        if (specialCommand.type === 'clear') {
            logger.debug('[start] Detected /clear command');
            messageQueue.pushIsolateAndClear(specialCommand.originalMessage || message.content.text, currentEnhancedMode(), attachmentsForThisMessage);
            logger.debugLargeJson('[start] /clear command pushed to queue:', message);
            return;
        }

        // DROVE-237: `/skills` is answered HERE, in BOTH modes, off the same
        // disk scan the app's `/` dropdown reads.
        //
        // Both of the paths it replaces were dead ends. Local mode forwarded
        // it to the tmux pane, where Claude Code's answer is terminal UI that
        // never reaches the transcript — so the phone got nothing at all, and
        // on a busy pane the command sat queued behind the running agents on
        // top of that (measured 2026-08-31: "holding /skills for the pane's
        // prompt (2 agent(s) running)"). Remote mode read `metadata.skills`,
        // which only the remote launcher's `system.init` ever writes, so a
        // pane session answered "may still be initializing" for the life of
        // the session. Nothing was initializing; the list was never coming.
        if (specialCommand.type === 'skills') {
            logger.debug(`[start] Detected /skills command in ${currentRunMode} mode — answering from the disk scan`);
            const configDir = resolveClaudeConfigDir(
                (currentSession as Session | null)?.claudeEnvVars?.CLAUDE_CONFIG_DIR,
            );
            let responseText: string;
            try {
                const inventory = await discoverSessionInventory({
                    flavor: 'claude',
                    cwd: workingDirectory,
                    configDir,
                });
                // Only when this account has none: a flip (BASED-98) carries
                // the destination account's own commands/ and skills/, so an
                // empty answer is usually "you are on another account", not
                // "you have no skills". Say which.
                let elsewhere: { configDir: string; skills: number } | null = null;
                const defaultConfigDir = join(os.homedir(), '.claude');
                if (inventory.skills.length === 0 && configDir !== defaultConfigDir) {
                    const fallback = await discoverSessionInventory({
                        flavor: 'claude',
                        cwd: workingDirectory,
                        configDir: defaultConfigDir,
                    });
                    elsewhere = { configDir: defaultConfigDir, skills: fallback.skills.length };
                }
                responseText = formatSkillsAnswer(inventory, {
                    account: session.getMetadata()?.droverAccount,
                    configDir,
                    elsewhere,
                });
            } catch (error) {
                logger.debug('[start] /skills scan failed:', error);
                responseText = `Could not read the skills tree under \`${configDir}\`.`;
            }

            session.sendClaudeSessionMessage({
                type: 'assistant',
                uuid: randomUUID(),
                parentUuid: null,
                isSidechain: false,
                sessionId: session.sessionId || 'unknown',
                timestamp: new Date().toISOString(),
                message: {
                    role: 'assistant',
                    model: 'system',
                    content: [{ type: 'text', text: responseText }],
                },
            } as any);
            return;
        }

        if (specialCommand.type === 'mcp') {
            // In local mode, let Claude Code handle this natively.
            if (currentRunMode === 'local') {
                logger.debug('[start] /mcp in local mode — passing through to Claude Code');
            } else {
                logger.debug('[start] Detected /mcp command in remote mode');
                const metadata = session.getMetadata();
                const servers = metadata?.mcpServers;
                const responseText = servers && servers.length > 0
                    ? '**MCP Servers**\n\n' + servers.map(s => `- **${s.name}** — ${s.status}`).join('\n')
                    : 'No MCP servers configured. Session may still be initializing — try again after sending a message.';

                session.sendClaudeSessionMessage({
                    type: 'assistant',
                    uuid: randomUUID(),
                    parentUuid: null,
                    isSidechain: false,
                    sessionId: session.sessionId || 'unknown',
                    timestamp: new Date().toISOString(),
                    message: {
                        role: 'assistant',
                        model: 'system',
                        content: [{ type: 'text', text: responseText }],
                    },
                } as any);
                return;
            }
        }

        // Push with resolved permission mode, model, system prompts, and tools
        messageQueue.push(message.content.text, currentEnhancedMode(), attachmentsForThisMessage);
        logger.debugLargeJson('User message pushed to queue:', message)
    });

    // Setup signal handlers for graceful shutdown
    //
    // `archive`: whether to stamp lifecycleState='archived' on the way
    // out. Two reasons we'd want to skip it:
    //   - The user pressed Ctrl-C in their terminal. They almost
    //     certainly want to come back to this session later — pinning
    //     it as `archived` would hide it from the active sessions list
    //     and force them to dig it up by URL just to hit Resume.
    //   - Same for SIGTERM (e.g. the system shutting us down).
    //
    // Browser-side "Archive" is intentionally explicit and DOES want
    // the metadata stamped — it routes through the killSession RPC
    // handler which calls cleanup({ archive: true }).
    //
    // Crashes (uncaughtException / unhandledRejection) keep archiving
    // because the session is genuinely toast at that point.
    const cleanup = async (opts: { archive?: boolean } = { archive: true }) => {
        logger.debug(`[START] Received termination signal, cleaning up (archive=${opts.archive ?? true})...`);

        try {
            // Update lifecycle state to archived before closing — only
            // when explicitly archiving. On Ctrl-C / SIGTERM we leave
            // lifecycleState alone so the server treats this exactly
            // like a network blip: active=false via missed keepalives,
            // but the session stays visible and resumable in the app.
            if (session) {
                if (opts.archive ?? true) {
                    session.updateMetadata((currentMetadata) => ({
                        ...currentMetadata,
                        lifecycleState: 'archived',
                        lifecycleStateSince: Date.now(),
                        archivedBy: 'cli',
                        archiveReason: 'User terminated'
                    }));
                }

                // Cleanup session resources (intervals, callbacks)
                currentSession?.cleanup();

                // Send session death message
                session.sendSessionDeath();

                // Belt-and-braces: also POST /v1/sessions/<id>/archive so
                // the server flips active=false even if the socket emit
                // didn't drain before close. The HTTP endpoint touches
                // only `active` and `lastActiveAt` — it doesn't write
                // archive metadata — so this is safe in the archive=false
                // case too, and matches the "session goes inactive but
                // stays resumable" semantics we want for Ctrl-C.
                try {
                    await api.deactivateSession(session.sessionId);
                } catch (err) {
                    logger.debug('[START] deactivateSession during cleanup failed:', err);
                }

                await session.flush();
                await session.close();
            }

            // Stop Happy MCP server
            happyServer.stop();

            // Stop Hook server and cleanup settings file
            hookServer.stop();
            cleanupHookSettingsFile(hookSettingsPath);

            // Stop the remote JSONL scanner (file watchers + intervals).
            await remoteScanner.cleanup();

            logger.debug('[START] Cleanup complete, exiting');
            process.exit(0);
        } catch (error) {
            logger.debug('[START] Error during cleanup:', error);
            process.exit(1);
        }
    };

    // Handle termination signals — Ctrl-C / SIGTERM are user-initiated
    // exits, treat as "I'll come back to this session later" rather than
    // "archive forever".
    process.on('SIGTERM', () => { void cleanup({ archive: false }); });
    process.on('SIGINT', () => { void cleanup({ archive: false }); });

    // Crashes archive on the way out so the session shows up correctly
    // in the app rather than masquerading as live.
    process.on('uncaughtException', (error) => {
        logger.debug('[START] Uncaught exception:', error);
        void cleanup({ archive: true });
    });

    process.on('unhandledRejection', (reason) => {
        logger.debug('[START] Unhandled rejection:', reason);
        void cleanup({ archive: true });
    });

    // Browser-side "Archive" button routes through this RPC and DOES
    // want the metadata stamped — it's the user explicitly choosing to
    // retire the session, not just disconnecting.
    registerKillSessionHandler(session.rpcHandlerManager, () => cleanup({ archive: true }));

    // Create claude loop
    // Cattle Drover account flip (BASED-98). Built only when a registry
    // actually names more than one account: with one account there is nowhere
    // to flip to, and an idle bus subscription per session would be cost for
    // nothing. Everything it does is local — the server is never involved.
    const flipController = flippableAccounts().length > 1
        ? new FlipController(workingDirectory, (message) => {
            session.sendSessionEvent({ type: 'message', message });
        })
        : undefined;
    if (flipController) {
        flipController.happySessionId = response.id;
        // Tell it where we started rather than letting it infer from the
        // environment twice — the environment is only right until the first
        // flip, and a stale answer there loses the transcript.
        // The STAMP, deliberately, not startedOnAccount: startedOn() sets the
        // controller's `stamped` flag, which is what suppresses the
        // whereabouts recall a daemon spawn depends on (DROVE-43). An account
        // derived from the config dir is not a stamp and must not pretend to
        // be one — the controller reaches the same answer through
        // currentAccount() without claiming a wrapper put it there.
        flipController.startedOn(process.env.DROVER_ACCOUNT);
        // What model and effort this session is set to, asked fresh (DROVE-187).
        // The controller needs it to keep a `[1m]` context across a downgrade
        // and to clamp an effort the model it drops to cannot take.
        flipController.setSelectionProbe(() => ({
            model: session.getMetadata()?.modelMode ?? null,
            effort: session.getMetadata()?.effortLevel ?? null,
        }));
        flipController.start();
        logger.debug('[flip] account flip armed');
    }

    // The usage strip (DROVE-47). Built whenever a registry exists at all —
    // one account still has a quota worth seeing — and NOT gated on the flip
    // controller, which only exists with two. The account asked of the
    // controller first, because after a flip it is the only thing that knows;
    // the environment names the account this process was BORN on.
    const usageReporter = readAccounts().length > 0
        ? new UsageReporter({
            current: () => flipController?.account() ?? currentAccount()?.name,
            // Headroom is computed for the model this session is running
            // (DROVE-173). Only the flip controller tracks it; with no
            // controller the snapshot stays model-blind, as it always was.
            family: () => flipController?.modelFamily(),
            publish: (droverUsage) => {
                session.updateMetadata((meta) => ({ ...meta, droverUsage }));
            },
        })
        : undefined;
    if (usageReporter) {
        usageReporter.start();
        logger.debug('[flip] usage reporter started');
    }

    // The flip and model-fallback policy on the phone (DROVE-3). Built
    // whenever a registry exists, on the same reasoning as the usage strip:
    // one account still has an onFamilyExhausted worth setting, and with none
    // there is no drover install to have settings for.
    //
    // The key is the CLAUDE session id, so the phone and `drover settings`
    // write the same row. It is null until Claude names the session, and the
    // reporter reports the defaults meanwhile rather than nothing.
    if (readAccounts().length > 0) {
        const claudeSessionId = () =>
            (currentSession as Session | null)?.sessionId ?? metadata.claudeSessionId ?? null;
        policyReporter = new PolicyReporter({
            sessionId: claudeSessionId,
            publish: (droverPolicy) => {
                session.updateMetadata((meta) => ({ ...meta, droverPolicy }));
                // The Account switching setting the flip controller decides on
                // (DROVE-187). Handed over from the poll that was already
                // happening rather than read again: apply() is synchronous and
                // the store is behind HTTP, and two readers of one store is how
                // `drover accounts` came to contradict the picker.
                flipController?.setPolicy(droverPolicy.effective);
            },
        });
        policyReporter.start();
        // The app's writes come back through here and re-stamp at once, so a
        // toggle does not sit unconfirmed until the next 30s poll.
        registerDroverPolicyHandler(session.rpcHandlerManager, claudeSessionId, (policy) => {
            policyReporter?.publishNow(policy);
        });
        logger.debug('[flip] policy reporter started');
    }

    // Clone lineage (DROVE-58). A flip is ONE session on another account; a
    // clone is TWO sessions, because no harness but Claude Code can read a
    // Claude Code transcript. Two rows in the app, and neither can say on its
    // own what it is — so both read the ledger `drover clone` writes and show
    // the other end of the pair.
    //
    // POLLED, not read once. `drover clone` writes the row BEFORE it opens the
    // window, with the clone's own session id still unknown, and the bus fills
    // that in from the clone's first SessionStart hook. A snapshot taken at
    // start-up would be taken before that happened, every time.
    //
    // Not gated on the registry the way the two above are: a clone has nothing
    // to do with how many accounts exist.
    const cloneReporter = new CloneReporter({
        current: currentClaudeSessionId,
        publish: (droverClone) => {
            session.updateMetadata((meta) => {
                if (!droverClone) {
                    const { droverClone: _gone, ...rest } = meta as Metadata;
                    return rest as Metadata;
                }
                return { ...meta, droverClone };
            });
        },
    });
    cloneReporter.start();

    // The clone's seed (DROVE-58). Read HERE rather than in the shell so it
    // travels as a path through `pick-account` and the `drover account use`
    // re-entry, and delivered as `pendingInitialPrompt` rather than an argv:
    // an argv survives every relaunch, so a seed there would paste the whole
    // conversation in again after each flip.
    //
    // An unreadable seed is a FAILURE, not a session that starts with no
    // context and looks like it worked. `bin/drover` checks first, so this
    // only fires for a CLI invoked directly.
    let seedPrompt: string | undefined;
    if (options.seedFile) {
        seedPrompt = readSeedPrompt(options.seedFile);
        logger.debug(`[clone] seeded from ${options.seedFile} (${seedPrompt.length} chars)`);
    }

    /**
     * Which build of the CLI this session is actually running (DROVE-172).
     *
     * The whole failure was that nobody -- not Clay, not the log -- could tell.
     * A rebuild rewrites `dist/index.mjs` and every open session keeps
     * executing the bytes node read at spawn, and there was no line anywhere
     * saying which those were. This is that line, and after a handover it is
     * the proof the new bundle is the one running.
     */
    logger.debug(`[relaunch] running dist ${distEntrypoint()} stamp=${loadedDistStamp === null
        ? 'none (dev)'
        : `${new Date(loadedDistStamp.mtimeMs).toISOString()}/${loadedDistStamp.size}`}`);

    const exitCode = await loop({
        path: workingDirectory,
        initialPrompt: seedPrompt,
        model: options.model,
        permissionMode: initialPermissionMode,
        startingMode: options.startingMode,
        messageQueue,
        api,
        allowedTools: happyServer.toolNames.map(toolName => `mcp__happy__${toolName}`),
        onModeChange: (newMode) => {
            currentRunMode = newMode;
            session.sendSessionEvent({ type: 'switch', mode: newMode });
            session.updateAgentState((currentState) => ({
                ...currentState,
                controlledByUser: newMode === 'local'
            }));
        },
        onSessionReady: (sessionInstance) => {
            // Store reference for hook server callback
            currentSession = sessionInstance;
            // DROVE-78: the local scanner is the one that follows a flip into
            // another account's config dir. The remote scanner above reads the
            // dir this PROCESS was started on, which after a flip is the
            // account we left, so the goal quietly stopped updating there.
            // Both feed the same reducer; duplicate revisions are dropped.
            sessionInstance.onGoalStatusEvent = updateClaudeGoalState;
        },
        onAbort: resetCurrentModeDefaults,
        mcpServers: {
            'happy': {
                type: 'http' as const,
                url: happyServer.url,
            }
        },
        session,
        // DROVER_WRAPPER_PID (BASED-98): the child — and every Bash it runs,
        // which includes the injected /flip slash command — can tell it is
        // inside a drover wrapper by checking this pid is alive. Without the
        // stamp, /flip typed into a PLAIN `claude` posts a request nothing is
        // listening for, which reads as the flip silently not working; with
        // it, the command says "not drover-managed" in as many words. Stamped
        // even with one account, so /flip can explain THAT case too.
        //
        // DROVER_ORIGIN (BASED-140): the session hook adapter forwards it, so
        // `drover sessions` can say a paneless row is a session started from
        // the phone rather than one whose pane simply could not be resolved.
        claudeEnvVars: {
            // CLAUDE_CONFIG_DIR (DROVE-77): seven readers take the account's
            // config dir from THIS record and fall back to ~/.claude when it is
            // absent — findInbox, the pane idle gate, the scanner, apply.ts.
            // A flip writes it (apply.ts), so a flipped session was fine, and
            // until DROVE-21 every fresh start was ambient, so the miss was
            // invisible. DROVE-21 now stamps every start with the account it
            // was last on, and the first stamped start showed the hole at
            // once: claude announced its socket under jamrizzi/sessions/,
            // findInbox read ~/.claude/sessions/, and five phone messages in
            // two minutes came back "did NOT reach the terminal". Seeded from
            // the process env, which is what claude itself was launched with.
            // Unset stays unset — that is the ambient spelling every reader
            // already understands — never coerced to '' or to ~/.claude.
            ...(process.env.CLAUDE_CONFIG_DIR !== undefined
                ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }
                : {}),
            ...(options.claudeEnvVars ?? {}),
            DROVER_WRAPPER_PID: String(process.pid),
            DROVER_ORIGIN: options.startedBy === 'daemon' ? 'daemon' : 'terminal',
        },
        claudeArgs: options.claudeArgs,
        sandboxConfig,
        hookSettingsPath,
        jsRuntime: options.jsRuntime,
        flip: flipController,
        usage: usageReporter,
        reattachedClaudeSessionId: reattached ? metadata.claudeSessionId : undefined,
    });

    flipController?.stop();
    usageReporter?.stop();
    policyReporter?.stop();
    cloneReporter.stop();

    /**
     * The bundle was rebuilt under us and the launcher stopped the child at a
     * quiet moment so the new one could take over (DROVE-172).
     *
     * Everything below this point tears the session DOWN, and a handover is
     * the opposite of that. `sendSessionDeath` in particular is skipped: the
     * phone must not see the session end and come back, because from the app's
     * side nothing is ending. What it does see is the same session id going
     * quiet for the couple of seconds the new process takes to reconnect --
     * which is what a flip already looks like.
     */
    if (exitCode === relaunchExitCode) {
        const claudeSessionId = (currentSession as Session | null)?.sessionId ?? null;
        const relaunchFile = process.env[relaunchFileEnv];
        if (claudeSessionId !== null && relaunchFile) {
            const request: RelaunchRequest = {
                argv: buildRelaunchArgv(process.argv.slice(2), claudeSessionId),
                happySessionId: session.sessionId,
            };
            writeFileSync(relaunchFile, JSON.stringify(request), 'utf8');
            logger.debug(`[relaunch] handing ${session.sessionId} to the new bundle: ${request.argv.join(' ')}`);
            (currentSession as Session | null)?.cleanup();
            await session.flush();
            await session.close();
            happyServer.stop();
            hookServer.stop();
            cleanupHookSettingsFile(hookSettingsPath);
            process.exit(relaunchExitCode);
        }
        // Nothing to resume onto, or nobody to relaunch us. Falling through
        // ends the session the ordinary way rather than pretending.
        logger.debug('[relaunch] asked for, but not possible here — exiting normally');
        process.exitCode = 0;
    }

    // Cleanup session resources (intervals, callbacks) - prevents memory leak
    // Note: currentSession is set by onSessionReady callback during loop()
    (currentSession as Session | null)?.cleanup();

    // Send session death message
    session.sendSessionDeath();

    // Wait for socket to flush
    logger.debug('Waiting for socket to flush...');
    await session.flush();

    // Close session
    logger.debug('Closing session...');
    await session.close();

    // Stop Happy MCP server
    happyServer.stop();
    logger.debug('Stopped Happy MCP server');

    // Stop Hook server and cleanup settings file
    hookServer.stop();
    cleanupHookSettingsFile(hookSettingsPath);
    logger.debug('Stopped Hook server and cleaned up settings file');

    // Exit with the code from Claude
    process.exit(exitCode === relaunchExitCode ? 0 : exitCode);
}
