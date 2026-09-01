/**
 * Session operations for remote procedure calls
 * Provides strictly typed functions for all session-related RPC operations
 */

import { apiSocket } from './apiSocket';
import { sync } from './sync';
import { storage } from './storage';
import { describeDemoInput, isDroverDemoId, recordDemoAnswer } from './droverDemo';
import { withdrawnGates } from './droverWithdrawn';
import type { AgentQuestionAnswer, MachineMetadata, SessionAgentModesPatch } from './storageTypes';
import type { SessionInventoryPayload } from './sessionInventory';
import { markAgentModePushPending, clearAgentModePushPending, type AgentModeField } from './agentModesPending';
import {
    AGENT_MODE_CONTROLS,
    noteAgentModeRequest,
    paneDisagreesWithRequest,
    paneObservedMode,
    type AgentModeControl,
} from './agentModeRequests';
import {
    isRigMetadata,
    rigCanAbort,
    rigCanReadFiles,
    rigCanSearchFiles,
    rigCanUseShell,
    rigCanWriteFiles,
    rigHasRpcMethod,
} from './rig';

export type { SessionAgentModesPatch };

// Strict type definitions for all operations

// Permission operation types
interface SessionPermissionRequest {
    id: string;
    approved: boolean;
    reason?: string;
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    allowTools?: string[];
    updatedInput?: Record<string, unknown>;
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
}

/**
 * Reply to an agent-to-user communication. Separate from the permission channel
 * on purpose: nothing here approves or denies an action, it carries information
 * the agent asked for. `kind` mirrors the request so the agent can route the
 * reply once other kinds of communication exist.
 */
interface SessionCommunicationReply {
    id: string;
    kind: string;
    status: 'answered' | 'cancelled';
    answers?: Record<string, AgentQuestionAnswer>;
}

// Mode change operation types
interface SessionModeChangeRequest {
    to: 'remote' | 'local';
}

interface SessionGoalActionRequest {
    action: 'clear' | 'stop' | 'edit';
    objective?: string;
}

// Bash operation types
interface SessionBashRequest {
    command: string;
    cwd?: string;
    timeout?: number;
}

interface SessionBashResponse {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    error?: string;
}

// Read file operation types
interface SessionReadFileRequest {
    path: string;
}

interface SessionReadFileResponse {
    success: boolean;
    content?: string; // base64 encoded
    error?: string;
}

// Write file operation types
interface SessionWriteFileRequest {
    path: string;
    content: string; // base64 encoded
    expectedHash?: string | null;
}

interface SessionWriteFileResponse {
    success: boolean;
    hash?: string;
    error?: string;
}

// List directory operation types
interface SessionListDirectoryRequest {
    path: string;
}

interface DirectoryEntry {
    name: string;
    type: 'file' | 'directory' | 'other';
    size?: number;
    modified?: number;
}

interface SessionListDirectoryResponse {
    success: boolean;
    entries?: DirectoryEntry[];
    error?: string;
}

// Directory tree operation types
interface SessionGetDirectoryTreeRequest {
    path: string;
    maxDepth: number;
}

interface TreeNode {
    name: string;
    path: string;
    type: 'file' | 'directory';
    size?: number;
    modified?: number;
    children?: TreeNode[];
}

interface SessionGetDirectoryTreeResponse {
    success: boolean;
    tree?: TreeNode;
    error?: string;
}

// Ripgrep operation types
interface SessionRipgrepRequest {
    args: string[];
    cwd?: string;
}

interface SessionRipgrepResponse {
    success: boolean;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    error?: string;
}

interface SessionInventoryResponse {
    success: boolean;
    inventory?: SessionInventoryPayload;
    error?: string;
}

// Kill session operation types
interface SessionKillRequest {
    // No parameters needed
}

interface SessionKillResponse {
    success: boolean;
    message: string;
}

// Response types for spawn session
export type SpawnSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'pending'; clientRequestId: string; retryAfterMs: number }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; errorMessage: string };

// Options for spawning a session
export interface SpawnSessionOptions {
    machineId: string;
    directory: string;
    approvedNewDirectoryCreation?: boolean;
    token?: string;
    agent?: 'codex' | 'claude' | 'cursor' | 'gemini' | 'openclaw' | 'agy' | 'rig' | 'pi';
    permissionMode?: string;
    modelMode?: string;
    effortLevel?: string;
    /** Stable idempotency key required by Rig's machine RPC. */
    clientRequestId?: string;
    /** Rig-native provider/model selection. */
    providerId?: string;
    modelId?: string;
    effort?: string;
    /**
     * If set, the daemon spawns the agent with `--resume <id>` so the new
     * Happy session attaches to a pre-existing on-disk Claude conversation
     * file. Used by the session fork / duplicate flow.
     */
    resumeClaudeSessionId?: string;
    /**
     * If set, the daemon spawns Codex with `--resume <id>` so the new Happy
     * session attaches to an app-server thread created by fork / duplicate.
     */
    resumeCodexThreadId?: string;
    /** Happy session id this fork was branched from (lineage). */
    parentSessionId?: string;
    /** Happy message id used as the rewind point (only set for "duplicate"). */
    forkedFromMessageId?: string;
    /** Marks the spawned session as a hidden side chat of `parentSessionId`. */
    isSideChat?: boolean;
}

// Options for forking a Claude session on a machine
export interface ClaudeForkSessionOptions {
    machineId: string;
    /** Working directory of the source session — used to derive the Claude project dir. */
    directory: string;
    /** Source Claude session UUID (Session.metadata.claudeSessionId on the parent). */
    claudeSessionId: string;
}

export type ClaudeForkSessionResult =
    | { type: 'success'; newClaudeSessionId: string }
    | { type: 'error'; errorMessage: string };

export interface ClaudeRewindPoint {
    uuid: string;
    text: string;
    timestamp: number;
}

export type ClaudeListRewindPointsResult =
    | { type: 'success'; points: ClaudeRewindPoint[] }
    | { type: 'error'; errorMessage: string };

export interface CodexForkThreadOptions {
    machineId: string;
    /** Working directory of the source session, passed to Codex thread/fork. */
    directory: string;
    /** Source Codex app-server thread id (Session.metadata.codexThreadId). */
    codexThreadId: string;
}

export type CodexForkThreadResult =
    | { type: 'success'; newCodexThreadId: string }
    | { type: 'error'; errorMessage: string };

export interface CodexRewindPoint {
    itemId: string;
    text: string;
    timestamp: number;
}

export type CodexListRewindPointsResult =
    | { type: 'success'; points: CodexRewindPoint[] }
    | { type: 'error'; errorMessage: string };

export interface ResumeSessionOptions {
    machineId: string;
    sessionId: string;
}

// Exported session operation functions

/**
 * Spawn a new remote session on a specific machine
 */
export async function machineSpawnNewSession(options: SpawnSessionOptions): Promise<SpawnSessionResult> {

    const { machineId, directory, approvedNewDirectoryCreation = false, token, agent, permissionMode, modelMode, effortLevel, clientRequestId, providerId, modelId, effort, resumeClaudeSessionId, resumeCodexThreadId, parentSessionId, forkedFromMessageId, isSideChat } = options;

    try {
        if (agent === 'rig' && !clientRequestId) {
            throw new Error('Rig session creation requires a client request ID');
        }
        type SpawnRequest = {
            type: 'spawn-in-directory'
            directory: string
            approvedNewDirectoryCreation?: boolean,
            token?: string,
            agent?: 'codex' | 'claude' | 'cursor' | 'gemini' | 'openclaw' | 'agy' | 'rig' | 'pi',
            permissionMode?: string,
            modelMode?: string,
            effortLevel?: string,
            clientRequestId?: string,
            providerId?: string,
            modelId?: string,
            effort?: string,
            resumeClaudeSessionId?: string,
            resumeCodexThreadId?: string,
            parentSessionId?: string,
            forkedFromMessageId?: string,
            isSideChat?: boolean,
        };
        const request: SpawnRequest = agent === 'rig'
            ? {
                type: 'spawn-in-directory',
                agent: 'rig',
                directory,
                approvedNewDirectoryCreation,
                ...(clientRequestId ? { clientRequestId } : {}),
                ...(permissionMode ? { permissionMode } : {}),
                ...(providerId ? { providerId } : {}),
                ...(modelId ? { modelId } : {}),
                ...((effort ?? effortLevel) ? { effort: effort ?? effortLevel } : {}),
            }
            : { type: 'spawn-in-directory', directory, approvedNewDirectoryCreation, token, agent, permissionMode, modelMode, effortLevel, resumeClaudeSessionId, resumeCodexThreadId, parentSessionId, forkedFromMessageId, isSideChat };
        const result = await apiSocket.machineRPC<SpawnSessionResult, SpawnRequest>(
            machineId,
            'spawn-happy-session',
            request,
        );
        return result;
    } catch (error) {
        // Handle RPC errors
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to spawn session'
        };
    }
}

/**
 * Copy the source session's Claude JSONL on the daemon machine and return
 * the new Claude session UUID. Caller then spawns a fresh Happy session
 * with `resumeClaudeSessionId` set to that UUID to attach a new Happy
 * session row to the copied conversation.
 */
export async function claudeForkSession(options: ClaudeForkSessionOptions): Promise<ClaudeForkSessionResult> {
    const { machineId, directory, claudeSessionId } = options;
    try {
        const result = await apiSocket.machineRPC<ClaudeForkSessionResult, {
            directory: string;
            claudeSessionId: string;
        }>(
            machineId,
            'claude-fork-session',
            { directory, claudeSessionId },
        );
        return result;
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to fork session',
        };
    }
}

/**
 * Read the on-disk Claude JSONL on the daemon machine and return user-text
 * messages with their underlying claudeUuid + timestamp. Disk is the
 * source of truth for the rewind picker — server-side envelopes miss
 * claudeUuid for any user message that travelled via the legacy
 * `sentFrom: 'web'` path.
 */
export async function claudeListRewindPoints(
    options: ClaudeForkSessionOptions,
): Promise<ClaudeListRewindPointsResult> {
    const { machineId, directory, claudeSessionId } = options;
    try {
        const result = await apiSocket.machineRPC<ClaudeListRewindPointsResult, {
            directory: string;
            claudeSessionId: string;
        }>(
            machineId,
            'claude-list-rewind-points',
            { directory, claudeSessionId },
        );
        return result;
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to list rewind points',
        };
    }
}

/**
 * Same as claudeForkSession, but truncates the copied JSONL right after the
 * line with `cutAfterUuid` (keeping the chosen message as the last entry,
 * dropping every line after — including the agent's response). Use this
 * for "rewind to message N and try again" flows. Daemon hard-fails if the
 * UUID isn't present in the source — never silently produces a
 * non-truncated copy.
 */
export async function claudeDuplicateSession(
    options: ClaudeForkSessionOptions & { cutAfterUuid: string },
): Promise<ClaudeForkSessionResult> {
    const { machineId, directory, claudeSessionId, cutAfterUuid } = options;
    try {
        const result = await apiSocket.machineRPC<ClaudeForkSessionResult, {
            directory: string;
            claudeSessionId: string;
            cutAfterUuid: string;
        }>(
            machineId,
            'claude-duplicate-session',
            { directory, claudeSessionId, cutAfterUuid },
        );
        return result;
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to duplicate session',
        };
    }
}

export async function codexForkThread(options: CodexForkThreadOptions): Promise<CodexForkThreadResult> {
    const { machineId, directory, codexThreadId } = options;
    try {
        const result = await apiSocket.machineRPC<CodexForkThreadResult, {
            directory: string;
            codexThreadId: string;
        }>(
            machineId,
            'codex-fork-thread',
            { directory, codexThreadId },
        );
        return result;
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to fork Codex thread',
        };
    }
}

export async function codexDuplicateThread(
    options: CodexForkThreadOptions & { cutAfterItemId: string },
): Promise<CodexForkThreadResult> {
    const { machineId, directory, codexThreadId, cutAfterItemId } = options;
    try {
        const result = await apiSocket.machineRPC<CodexForkThreadResult, {
            directory: string;
            codexThreadId: string;
            cutAfterItemId: string;
        }>(
            machineId,
            'codex-duplicate-thread',
            { directory, codexThreadId, cutAfterItemId },
        );
        return result;
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to duplicate Codex thread',
        };
    }
}

export async function codexListRewindPoints(
    options: CodexForkThreadOptions,
): Promise<CodexListRewindPointsResult> {
    const { machineId, directory, codexThreadId } = options;
    try {
        const result = await apiSocket.machineRPC<CodexListRewindPointsResult, {
            directory: string;
            codexThreadId: string;
        }>(
            machineId,
            'codex-list-rewind-points',
            { directory, codexThreadId },
        );
        return result;
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to list Codex rewind points',
        };
    }
}

export async function machineResumeSession(options: ResumeSessionOptions & { model?: string; permissionMode?: string }): Promise<SpawnSessionResult> {
    const { machineId, sessionId, model, permissionMode } = options;

    try {
        const result = await apiSocket.machineRPC<SpawnSessionResult, { sessionId: string; model?: string; permissionMode?: string }>(
            machineId,
            'resume-happy-session',
            { sessionId, model, permissionMode },
        );
        return result;
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to resume session',
        };
    }
}

/**
 * Permanently remove a machine from the server. Sessions spawned by the
 * machine are preserved; only the Machine row and its AccessKeys are deleted.
 */
export async function machineDelete(machineId: string): Promise<{ success: boolean; message?: string }> {
    try {
        const response = await apiSocket.request(`/v1/machines/${machineId}`, {
            method: 'DELETE'
        });
        if (response.ok) {
            return { success: true };
        }
        const error = await response.text();
        return { success: false, message: error || 'Failed to delete machine' };
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Ask the daemon that started a session to stop it, by SIGTERM to the process
 * it is tracking.
 *
 * This is the only stop that reaches a session which has only just been
 * spawned. `sessionKill` talks to the session's own RPC handler, which does not
 * exist until that process is up and has registered it, and it needs the
 * session's encryption key, which arrives with the sessions list — so for the
 * first seconds of a session's life it fails on both counts. The daemon's
 * socket, by contrast, is the one we just spawned through.
 */
export async function machineStopSession(
    machineId: string,
    sessionId: string,
): Promise<{ success: boolean; message?: string }> {
    try {
        const result = await apiSocket.machineRPC<{ message: string }, { sessionId: string }>(
            machineId,
            'stop-session',
            { sessionId },
        );
        return { success: true, message: result?.message };
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Failed to stop session',
        };
    }
}

/**
 * Stop the daemon on a specific machine
 */
/**
 * Add a subscription on that machine, from here (DROVE-61, DROVE-270).
 *
 * It only STARTS the login. What comes back is a card carrying the URL the
 * machine printed, over the drover bridge as a DroverAccountLogin request.
 * Nothing about a credential travels through this call.
 *
 * `harness` picks WHICH subscription, and the two finish differently — which
 * is why the Accounts screen's wording depends on it. Claude prints a URL and
 * then blocks on a code typed back into the card; cursor prints a URL and then
 * polls its own API until a browser approves, so there is no code at all.
 *
 * Omitted means claude, so a caller that predates the second harness gets
 * exactly what it always got, and a daemon that predates it ignores a field it
 * does not read.
 *
 * `name` is optional on purpose — left out, the account is named after the
 * address it logs in as, so there is nothing to invent. Clay has said three
 * times that an account must not be named by typing, and neither login asks.
 */
export async function machineDroverAccountLogin(
    machineId: string,
    options: { name?: string; harness?: 'claude' | 'cursor' } = {},
): Promise<{ started: boolean; name: string | null }> {
    return await apiSocket.machineRPC<
        { started: boolean; name: string | null },
        { name?: string; harness?: string }
    >(
        machineId,
        'drover-account-login',
        {
            ...(options.name ? { name: options.name } : {}),
            // Sent only for cursor. A daemon predating DROVE-270 would pass an
            // unknown `--harness claude` straight to a wrapper that predates
            // DROVE-256, and the phone cannot see which end it is talking to.
            ...(options.harness && options.harness !== 'claude' ? { harness: options.harness } : {}),
        },
    );
}

export async function machineStopDaemon(machineId: string): Promise<{ message: string }> {
    const result = await apiSocket.machineRPC<{ message: string }, {}>(
        machineId,
        'stop-daemon',
        {}
    );
    return result;
}

export type MachineWorktree = {
    path: string;
    branch: string | null;
    head: string;
    dirty: boolean;
    isMain: boolean;
    bare: boolean;
    detached: boolean;
};

export type MachineListWorktreesResult =
    | { ok: true; worktrees: MachineWorktree[] }
    | { ok: false; error: string };

/**
 * The worktrees of the repo around `repoRoot`, from the daemon's
 * `list-worktrees` (DROVE-90). Any directory inside the repo will do; the
 * session's cwd is what the branch sheet sends.
 */
export async function machineListWorktrees(machineId: string, repoRoot: string): Promise<MachineListWorktreesResult> {
    try {
        return await apiSocket.machineRPC<MachineListWorktreesResult, { repoRoot: string }>(
            machineId,
            'list-worktrees',
            { repoRoot },
        );
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Failed to list worktrees',
        };
    }
}

/**
 * Execute a bash command on a specific machine
 */
export async function machineBash(
    machineId: string,
    command: string,
    cwd: string
): Promise<{
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
}> {
    try {
        const result = await apiSocket.machineRPC<{
            success: boolean;
            stdout: string;
            stderr: string;
            exitCode: number;
        }, {
            command: string;
            cwd: string;
        }>(
            machineId,
            'bash',
            { command, cwd }
        );
        return result;
    } catch (error) {
        return {
            success: false,
            stdout: '',
            stderr: error instanceof Error ? error.message : 'Unknown error',
            exitCode: -1
        };
    }
}

/**
 * Update machine metadata with optimistic concurrency control and automatic retry
 */
export async function machineUpdateMetadata(
    machineId: string,
    metadata: MachineMetadata,
    expectedVersion: number,
    maxRetries: number = 3
): Promise<{ version: number; metadata: string }> {
    let currentVersion = expectedVersion;
    let currentMetadata = { ...metadata };
    let retryCount = 0;

    const machineEncryption = sync.encryption.getMachineEncryption(machineId);
    if (!machineEncryption) {
        throw new Error(`Machine encryption not found for ${machineId}`);
    }

    while (retryCount < maxRetries) {
        const encryptedMetadata = await machineEncryption.encryptRaw(currentMetadata);

        const result = await apiSocket.emitWithAck<{
            result: 'success' | 'version-mismatch' | 'error';
            version?: number;
            metadata?: string;
            message?: string;
        }>('machine-update-metadata', {
            machineId,
            metadata: encryptedMetadata,
            expectedVersion: currentVersion
        });

        if (result.result === 'success') {
            return {
                version: result.version!,
                metadata: result.metadata!
            };
        } else if (result.result === 'version-mismatch') {
            // Get the latest version and metadata from the response
            currentVersion = result.version!;
            const latestMetadata = await machineEncryption.decryptRaw(result.metadata!) as MachineMetadata;

            // Merge our changes with the latest metadata
            // Preserve the displayName we're trying to set, but use latest values for other fields
            currentMetadata = {
                ...latestMetadata,
                displayName: metadata.displayName // Keep our intended displayName change
            };

            retryCount++;

            // If we've exhausted retries, throw error
            if (retryCount >= maxRetries) {
                throw new Error(`Failed to update after ${maxRetries} retries due to version conflicts`);
            }

            // Otherwise, loop will retry with updated version and merged metadata
        } else {
            throw new Error(result.message || 'Failed to update machine metadata');
        }
    }

    throw new Error('Unexpected error in machineUpdateMetadata');
}

/**
 * Persist per-session mode picks into synced session metadata with optimistic
 * concurrency and automatic retry. On version conflict the latest metadata is
 * taken from the server via the schema-free raw decrypt, so fields this app
 * version doesn't know about survive the read-modify-write.
 */
async function sessionUpdateAgentModesMetadata(
    sessionId: string,
    patch: SessionAgentModesPatch,
    maxRetries: number = 3
): Promise<void> {
    const encryption = sync.encryption.getSessionEncryption(sessionId);
    const session = storage.getState().sessions[sessionId];
    if (!encryption || !session?.metadata) {
        throw new Error(`Session ${sessionId} is not ready for metadata updates`);
    }

    // Defensive copy: retries drop fields from the patch (see below)
    let pendingPatch: SessionAgentModesPatch = { ...patch };
    let currentVersion = session.metadataVersion;
    let currentMetadata: Record<string, unknown> = { ...session.metadata, ...pendingPatch };

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const encrypted = await encryption.encryptRaw(currentMetadata);
        const result = await apiSocket.emitWithAck<{
            result: 'success' | 'version-mismatch' | 'error';
            version?: number;
            metadata?: string;
        }>('update-metadata', {
            sid: sessionId,
            metadata: encrypted,
            expectedVersion: currentVersion
        });

        if (result.result === 'success') {
            return;
        }
        if (result.result === 'version-mismatch') {
            currentVersion = result.version!;
            const latest = await encryption.decryptRaw(result.metadata!);
            if (!latest) {
                throw new Error('Failed to decrypt latest session metadata');
            }
            // A newer local action (another pick, an abort clearing modes) may
            // have changed the mirror since this push started — that action
            // owns the field now, and blindly replaying the original patch
            // would resurrect a pick the user already cleared.
            const liveSession = storage.getState().sessions[sessionId];
            for (const field of Object.keys(pendingPatch) as (keyof SessionAgentModesPatch)[]) {
                if ((liveSession?.[field] ?? null) !== (pendingPatch[field] ?? null)) {
                    delete pendingPatch[field];
                }
            }
            if (Object.keys(pendingPatch).length === 0) {
                return;
            }
            currentMetadata = { ...latest, ...pendingPatch };
            continue;
        }
        throw new Error('Failed to update session metadata');
    }

    throw new Error(`Failed to update session metadata after ${maxRetries} retries due to version conflicts`);
}

/**
 * Apply a per-session model / effort pick: updates local state immediately for
 * a snappy UI and pushes the pick into synced session metadata so other
 * devices receive it through the update-session broadcast. Never throws — a
 * failed push leaves the optimistic local value, and the next inbound
 * metadata update reconciles the UI.
 */
export function sessionSetAgentModes(sessionId: string, patch: SessionAgentModesPatch): void {
    // PermissionFooter follows an "allow all edits" with a mode change for the
    // session. On a demo card there is no session to change, and without this
    // the write below would mint a metadata update for a session id that does
    // not exist (DROVE-75).
    if (isDroverDemoId(sessionId)) return;
    const state = storage.getState();
    const session = state.sessions[sessionId];

    // Only touch fields that actually change — clearing modes on a session
    // with no picks (e.g. every abort) must not cost a metadata round-trip.
    // A pick counts as changed when it differs from the local mirror OR from
    // synced metadata: a local-only value (e.g. the EnterPlanMode auto-switch
    // writes the mirror without metadata) must still be pushed when the user
    // picks it explicitly, or other devices never see it.
    const isChanged = (value: string | null, field: keyof SessionAgentModesPatch): boolean => {
        const mirror = session?.[field] ?? null;
        const metaRaw = session?.metadata?.[field];
        const meta = metaRaw === undefined ? null : (metaRaw ?? null);
        return value !== mirror || value !== meta;
    };
    // DROVE-191: for a pane session the stored pick is not the last word on
    // what is running — `/model` typed at the keyboard, a flip, or a limit
    // downgrade moves the pane and leaves `modelMode` behind. Tapping the row
    // the app shows then matched the stale request and sent nothing, so the
    // picker was dead from the phone. A pick the PANE disagrees with is always
    // a change, whatever the mirror says.
    //
    // DROVE-199: the third field is the one Clay moves by hand most — shift+tab
    // is a key on his own keyboard, so the pane leaves the stored request
    // behind every time he presses it. The composer correctly showed the pane's
    // mode (resolveCurrentOption prefers panePermissionMode), so the row he
    // tapped was the row already displayed, `isChanged` compared it against a
    // request that had not moved, and the pick was dropped before it ever
    // reached the wire.
    //
    // DROVE-217 moved the comparison itself into agentModeRequests.ts, because
    // the composer now needs the SAME question answered to colour a pick that
    // has not landed yet. One rule, two readers.
    const paneDisagrees = (value: string | null, field: AgentModeControl): boolean =>
        paneDisagreesWithRequest(session?.metadata, field, value);
    const changed: SessionAgentModesPatch = {};
    if (patch.permissionMode !== undefined && (isChanged(patch.permissionMode, 'permissionMode') || paneDisagrees(patch.permissionMode, 'permissionMode'))) {
        changed.permissionMode = patch.permissionMode;
    }
    if (patch.modelMode !== undefined && (isChanged(patch.modelMode, 'modelMode') || paneDisagrees(patch.modelMode, 'modelMode'))) {
        changed.modelMode = patch.modelMode;
    }
    if (patch.effortLevel !== undefined && (isChanged(patch.effortLevel, 'effortLevel') || paneDisagrees(patch.effortLevel, 'effortLevel'))) {
        changed.effortLevel = patch.effortLevel;
    }
    if (patch.remoteControl !== undefined && isChanged(patch.remoteControl, 'remoteControl')) {
        changed.remoteControl = patch.remoteControl;
    }
    if (Object.keys(changed).length === 0) {
        return;
    }

    state.updateSessionAgentModes(sessionId, changed);

    // Write down what was asked for, and what the pane held when it was asked
    // (DROVE-217). This is what lets the composer show the pick AT ONCE and
    // draw it as unconfirmed until the pane catches up — measured at a median
    // under two seconds and a tail past a minute, which is why it has to be
    // drawn at all. Only the three fields the composer's capsule has a control
    // for; `remoteControl` is a toggle in a sheet, not a value in that row.
    const askedAt = Date.now();
    for (const field of AGENT_MODE_CONTROLS) {
        const value = changed[field];
        if (value === undefined) continue;
        noteAgentModeRequest(sessionId, field, value, paneObservedMode(session?.metadata, field), askedAt);
    }

    // While the push is in flight, inbound updates still carry the OLD
    // metadata; mark the fields pending so applySessions keeps the fresher
    // local mirror instead of bouncing the pick back.
    const changedFields = Object.keys(changed) as AgentModeField[];
    markAgentModePushPending(sessionId, changedFields);
    sessionUpdateAgentModesMetadata(sessionId, changed)
        .catch((error) => {
            console.error(`Failed to sync agent modes for session ${sessionId}`, error);
        })
        .finally(() => {
            clearAgentModePushPending(sessionId, changedFields);
        });
}

/**
 * Abort the current session operation
 */
export async function sessionAbort(sessionId: string): Promise<void> {
    const metadata = storage.getState().sessions[sessionId]?.metadata;
    if (!rigCanAbort(metadata)) {
        throw new Error('Abort is not available for this session');
    }
    await apiSocket.sessionRPC(sessionId, 'abort', isRigMetadata(metadata) ? {} : {
        reason: `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.`
    });
}

/**
 * Allow a permission request
 */
export async function sessionAllow(sessionId: string, id: string, mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan', allowedTools?: string[], decision?: 'approved' | 'approved_for_session', updatedInput?: Record<string, unknown>): Promise<void> {
    // THE DEMO WALL (DROVE-75). Every card in the app answers through this
    // function and sessionDeny below, so this is the one place a demo card's
    // button can be turned aside. A demo id goes to the local sink and is
    // logged as a demo; it never reaches the socket, the bridge or the bus.
    if (isDroverDemoId(sessionId) || isDroverDemoId(id)) {
        recordDemoAnswer({
            sessionId,
            requestId: id,
            verdict: updatedInput ? 'answer' : 'allow',
            detail: describeDemoInput(updatedInput) ?? (decision === 'approved_for_session' || allowedTools?.length ? 'for session' : mode),
        });
        return;
    }
    const request: SessionPermissionRequest = { id, approved: true, mode, allowTools: allowedTools, decision, updatedInput };
    await apiSocket.sessionRPC(sessionId, 'permission', request);
}

/**
 * Answer a question the agent asked. The reply carries back the same `kind` the
 * agent published, so the agent can route it without guessing.
 */
export async function sessionAnswerQuestion(
    sessionId: string,
    id: string,
    answers: Record<string, AgentQuestionAnswer>,
    kind: string = 'form',
): Promise<void> {
    // No demo card uses the communication channel today, but a demo id must
    // not be able to reach ANY session RPC, so the wall covers it (DROVE-75).
    if (isDroverDemoId(sessionId) || isDroverDemoId(id)) {
        recordDemoAnswer({ sessionId, requestId: id, verdict: 'answer', detail: kind });
        return;
    }
    const reply: SessionCommunicationReply = { id, kind, status: 'answered', answers };
    await apiSocket.sessionRPC(sessionId, 'communication', reply);
}

/**
 * Dismiss a communication without answering it.
 */
export async function sessionCancelCommunication(
    sessionId: string,
    id: string,
    kind: string = 'form',
): Promise<void> {
    if (isDroverDemoId(sessionId) || isDroverDemoId(id)) {
        recordDemoAnswer({ sessionId, requestId: id, verdict: 'cancel', detail: kind });
        return;
    }
    const reply: SessionCommunicationReply = { id, kind, status: 'cancelled' };
    await apiSocket.sessionRPC(sessionId, 'communication', reply);
}

/**
 * WITHDRAW a prompt Clay does not want to answer, and drop its card (DROVE-218).
 *
 * "get the ability for me to get things unstuck like prompts stuck." A card
 * that will not come down is not a thing to wait out — this is the control
 * that clears it, from the phone, with nobody diagnosing anything first.
 *
 * It is a withdrawal and it cannot be an approval. The bridge answers this RPC
 * with `POST /v1/events/:id/cancel`, which is the one terminal transition that
 * leaves `resolution` NULL, and there is no branch from here to `/resolve`. So
 * a dismissal cannot allow the command the gate was raised to stop, which is
 * DROVE-203 and is the one thing a fix for a stuck card must not widen. If the
 * gate genuinely is still pending, cancelling it is the honest outcome and the
 * producer learns its gate went away.
 *
 * The card is dropped locally FIRST and whatever the bus says. A cancel that
 * 404s (the event is already gone) or 409s (another surface ended it) are both
 * reasons the card should not still be on the screen, and a bridge that cannot
 * answer at all is the very condition this control exists for.
 */
export async function sessionDismissGate(sessionId: string, id: string): Promise<void> {
    withdrawnGates.withdraw([`${sessionId}:${id}`, id]);
    if (isDroverDemoId(sessionId) || isDroverDemoId(id)) {
        recordDemoAnswer({ sessionId, requestId: id, verdict: 'cancel', detail: 'dismissed' });
        return;
    }
    await apiSocket.sessionRPC(sessionId, 'drover-dismiss', { id });
}

/**
 * Deny a permission request
 */
export async function sessionDeny(sessionId: string, id: string, mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan', allowedTools?: string[], decision?: 'denied' | 'abort'): Promise<void> {
    // The other half of the demo wall; see sessionAllow (DROVE-75).
    if (isDroverDemoId(sessionId) || isDroverDemoId(id)) {
        recordDemoAnswer({ sessionId, requestId: id, verdict: 'deny', detail: decision });
        return;
    }
    const request: SessionPermissionRequest = { id, approved: false, mode, allowTools: allowedTools, decision };
    await apiSocket.sessionRPC(sessionId, 'permission', request);
}

/**
 * Request mode change for a session.
 *
 * Nothing in this app calls it, and nothing should start: Cattle Drover has
 * ONE mode. A session lives in a tmux pane, the pane is the session, and the
 * CLI no longer registers a `switch` RPC for one (DROVE-79), so this resolves
 * "Method not found" against every pane session, which is the only kind the
 * daemon spawns. Wiring a control to it would offer a takeover that ends the
 * terminal instead of switching it. Kept only for the paneless sessions
 * upstream still has.
 */
export async function sessionSwitch(sessionId: string, to: 'remote' | 'local'): Promise<boolean> {
    const request: SessionModeChangeRequest = { to };
    const response = await apiSocket.sessionRPC<boolean, SessionModeChangeRequest>(
        sessionId,
        'switch',
        request,
    );
    return response;
}

/**
 * Request an agent-owned goal action.
 */
export async function sessionGoalAction(
    sessionId: string,
    action: SessionGoalActionRequest['action'],
    objective?: string,
): Promise<void> {
    await apiSocket.sessionRPC(sessionId, 'goal-action', {
        action,
        ...(objective !== undefined ? { objective } : {}),
    } satisfies SessionGoalActionRequest);
}

/**
 * Execute a bash command in the session
 */
export async function sessionBash(sessionId: string, request: SessionBashRequest): Promise<SessionBashResponse> {
    try {
        const metadata = storage.getState().sessions[sessionId]?.metadata;
        if (!rigCanUseShell(metadata)) {
            throw new Error('Shell access is not available for this session');
        }
        const response = await apiSocket.sessionRPC<SessionBashResponse, SessionBashRequest>(
            sessionId,
            'bash',
            request
        );
        return response;
    } catch (error) {
        return {
            success: false,
            stdout: '',
            stderr: error instanceof Error ? error.message : 'Unknown error',
            exitCode: -1,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Read a file from the session
 */
export async function sessionReadFile(sessionId: string, path: string): Promise<SessionReadFileResponse> {
    try {
        const metadata = storage.getState().sessions[sessionId]?.metadata;
        if (!rigCanReadFiles(metadata)) {
            throw new Error('File reading is not available for this session');
        }
        const request: SessionReadFileRequest = { path };
        const response = await apiSocket.sessionRPC<SessionReadFileResponse, SessionReadFileRequest>(
            sessionId,
            'readFile',
            request
        );
        return response;
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Write a file to the session
 */
export async function sessionWriteFile(
    sessionId: string,
    path: string,
    content: string,
    expectedHash?: string | null
): Promise<SessionWriteFileResponse> {
    try {
        const metadata = storage.getState().sessions[sessionId]?.metadata;
        if (!rigCanWriteFiles(metadata)) {
            throw new Error('File writing is not available for this session');
        }
        const request: SessionWriteFileRequest = { path, content, expectedHash };
        const response = await apiSocket.sessionRPC<SessionWriteFileResponse, SessionWriteFileRequest>(
            sessionId,
            'writeFile',
            request
        );
        return response;
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * List directory contents in the session
 */
export async function sessionListDirectory(sessionId: string, path: string): Promise<SessionListDirectoryResponse> {
    try {
        const metadata = storage.getState().sessions[sessionId]?.metadata;
        if (isRigMetadata(metadata) && !rigHasRpcMethod(metadata, 'listDirectory')) {
            throw new Error('Directory listing is not advertised by this Rig session');
        }
        const request: SessionListDirectoryRequest = { path };
        const response = await apiSocket.sessionRPC<SessionListDirectoryResponse, SessionListDirectoryRequest>(
            sessionId,
            'listDirectory',
            request
        );
        return response;
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Get directory tree from the session
 */
export async function sessionGetDirectoryTree(
    sessionId: string,
    path: string,
    maxDepth: number
): Promise<SessionGetDirectoryTreeResponse> {
    try {
        const metadata = storage.getState().sessions[sessionId]?.metadata;
        if (isRigMetadata(metadata) && !rigHasRpcMethod(metadata, 'getDirectoryTree')) {
            throw new Error('Directory tree is not advertised by this Rig session');
        }
        const request: SessionGetDirectoryTreeRequest = { path, maxDepth };
        const response = await apiSocket.sessionRPC<SessionGetDirectoryTreeResponse, SessionGetDirectoryTreeRequest>(
            sessionId,
            'getDirectoryTree',
            request
        );
        return response;
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Run ripgrep in the session
 */
export async function sessionRipgrep(
    sessionId: string,
    args: string[],
    cwd?: string
): Promise<SessionRipgrepResponse> {
    try {
        const metadata = storage.getState().sessions[sessionId]?.metadata;
        if (!rigCanSearchFiles(metadata)) {
            throw new Error('File search is not available for this session');
        }
        const request: SessionRipgrepRequest = { args, cwd };
        const response = await apiSocket.sessionRPC<SessionRipgrepResponse, SessionRipgrepRequest>(
            sessionId,
            'ripgrep',
            request
        );
        return response;
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * The commands and skills this session can actually be asked to run (DROVE-170).
 *
 * Answered by the machine the session runs on, reading the account and project
 * it is on at the moment of the call, so it needs no invalidation when a
 * session flips account or moves machine. A harness whose CLI predates the
 * handler answers nothing, and the caller falls back to the snapshot's flat
 * lists and then to the built-in five.
 */
export async function sessionInventory(sessionId: string): Promise<SessionInventoryResponse> {
    try {
        return await apiSocket.sessionRPC<SessionInventoryResponse, Record<string, never>>(
            sessionId,
            'sessionInventory',
            {}
        );
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Kill the session process immediately
 */
export async function sessionKill(sessionId: string): Promise<SessionKillResponse> {
    try {
        const response = await apiSocket.sessionRPC<SessionKillResponse, {}>(
            sessionId,
            'killSession',
            {}
        );
        return response;
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Archive a session by deactivating it on the server.
 * Use this when the CLI process is already dead and sessionKill can't reach it.
 */
export async function sessionArchive(sessionId: string): Promise<{ success: boolean; message?: string }> {
    try {
        const response = await apiSocket.request(`/v1/sessions/${sessionId}/archive`, {
            method: 'POST'
        });
        if (!response.ok) {
            return { success: false, message: `Server error: ${response.status}` };
        }
        return { success: true };
    } catch (error) {
        return { success: false, message: error instanceof Error ? error.message : 'Unknown error' };
    }
}

/**
 * Permanently delete a session from the server
 * This will remove the session and all its associated data (messages, usage reports, access keys)
 * The session should be inactive/archived before deletion
 */
export async function sessionDelete(sessionId: string): Promise<{ success: boolean; message?: string }> {
    try {
        const response = await apiSocket.request(`/v1/sessions/${sessionId}`, {
            method: 'DELETE'
        });
        
        if (response.ok) {
            const result = await response.json();
            return { success: true };
        } else {
            const error = await response.text();
            return {
                success: false,
                message: error || 'Failed to delete session'
            };
        }
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

type ClaudeForkSource = {
    kind?: 'claude';
    sessionId: string;
    machineId: string;
    directory: string;
    claudeSessionId: string;
};

type CodexForkSource = {
    kind: 'codex';
    sessionId: string;
    machineId: string;
    directory: string;
    codexThreadId: string;
};

// Forking source description used by forkAndSpawn.
export type ForkSource = ClaudeForkSource | CodexForkSource;

type ForkOptions = {
    cutAfterUuid?: string;
    cutAfterItemId?: string;
    forkedFromMessageId?: string;
    /** Marks the forked child as a hidden side chat (kept out of the session list). */
    isSideChat?: boolean;
};

/**
 * Two-step orchestrator for the session fork / duplicate flow:
 *   1. Ask the daemon to copy (and optionally truncate) the source Claude
 *      JSONL — returns a fresh Claude session UUID.
 *   2. Spawn a new Happy session on the same machine with
 *      `resumeClaudeSessionId` set to that UUID so `claude --resume` picks
 *      up the copied conversation.
 *
 * Lineage (parentSessionId, forkedFromMessageId) rides through the spawn
 * RPC into env vars, then into the new Happy session's metadata at start
 * — so the parent link survives without any server-side schema change.
 */
export async function forkAndSpawn(
    source: ForkSource,
    opts: ForkOptions = {},
): Promise<SpawnSessionResult> {
    if (source.kind === 'codex') {
        const forkResult = opts.cutAfterItemId
            ? await codexDuplicateThread({
                machineId: source.machineId,
                directory: source.directory,
                codexThreadId: source.codexThreadId,
                cutAfterItemId: opts.cutAfterItemId,
            })
            : await codexForkThread({
                machineId: source.machineId,
                directory: source.directory,
                codexThreadId: source.codexThreadId,
            });

        if (forkResult.type !== 'success') {
            return { type: 'error', errorMessage: forkResult.errorMessage };
        }

        const spawnResult = await machineSpawnNewSession({
            machineId: source.machineId,
            directory: source.directory,
            agent: 'codex',
            approvedNewDirectoryCreation: false,
            resumeCodexThreadId: forkResult.newCodexThreadId,
            parentSessionId: source.sessionId,
            forkedFromMessageId: opts.forkedFromMessageId,
            isSideChat: opts.isSideChat,
        });

        if (spawnResult.type === 'success') {
            try {
                await sync.refreshSessions();
            } catch {
                // Refresh is best-effort; broadcast sync will still hydrate.
            }
        }

        return spawnResult;
    }

    const forkResult = opts.cutAfterUuid
        ? await claudeDuplicateSession({
            machineId: source.machineId,
            directory: source.directory,
            claudeSessionId: source.claudeSessionId,
            cutAfterUuid: opts.cutAfterUuid,
        })
        : await claudeForkSession({
            machineId: source.machineId,
            directory: source.directory,
            claudeSessionId: source.claudeSessionId,
        });

    if (forkResult.type !== 'success') {
        return { type: 'error', errorMessage: forkResult.errorMessage };
    }

    const spawnResult = await machineSpawnNewSession({
        machineId: source.machineId,
        directory: source.directory,
        agent: 'claude',
        approvedNewDirectoryCreation: false,
        resumeClaudeSessionId: forkResult.newClaudeSessionId,
        parentSessionId: source.sessionId,
        forkedFromMessageId: opts.forkedFromMessageId,
        isSideChat: opts.isSideChat,
    });

    // Pull the newly-created session row into local sync state before we
    // hand control back to the caller — otherwise router.replace into the
    // new session id races the broadcast and the app screams
    // "Session X not found" until the next sync tick lands.
    if (spawnResult.type === 'success') {
        try {
            await sync.refreshSessions();
        } catch {
            // Refresh is best-effort; the broadcast will still hydrate the
            // session shortly even if this fetch flaked.
        }
    }

    return spawnResult;
}

/**
 * Create a "side chat" for a session: a forked child that inherits the
 * parent's full context but is provably isolated (writes only to its own
 * transcript, never back into the parent) and is flagged `isSideChat` so it
 * stays out of the top-level session list. Rendered only inside the parent's
 * sidebar panel. Reuses the fork/spawn machinery; the only difference from a
 * normal fork is the `isSideChat` marker.
 */
export async function spawnSideChat(source: ForkSource): Promise<SpawnSessionResult> {
    return forkAndSpawn(source, { isSideChat: true });
}

// Export types for external use
export type {
    SessionBashRequest,
    SessionBashResponse,
    SessionReadFileResponse,
    SessionWriteFileResponse,
    SessionListDirectoryResponse,
    DirectoryEntry,
    SessionGetDirectoryTreeResponse,
    TreeNode,
    SessionRipgrepResponse,
    SessionKillResponse
};
