/**
 * The ONE way the daemon starts a session: a tmux window on the user's own
 * server running the drover wrapper in LOCAL mode (DROVE-2, DROVE-76).
 *
 * DROVE-2 put a phone-started NEW session in a tmux pane. Resume did not
 * follow: `resumeSession` still built `--happy-starting-mode remote` and handed
 * it to a detached `spawnHappyCLI`, so tapping Resume on a dead session gave
 * Clay a headless remote session the terminal could not see, the inbox socket
 * could not reach and the pane commands could not type into. The DROVE-1 audit
 * measured it as the last remaining producer of that second kind of session.
 *
 * So the window-opening half of the spawn path lives here, shared by spawn and
 * resume, and it is the only path there is. There is no direct spawn to fall
 * back to: `spawnTrackedHappyProcess` is gone. tmux unreachable is a FAILURE
 * the phone shows, for a resume exactly as for a spawn.
 */

import type { Metadata } from '@/api/types';
import { encodeBase64 } from '@/api/encryption';
import type { SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { logger } from '@/ui/logger';
import type { TmuxUtilities } from '@/utils/tmux';
import type { DroverAccount } from '@/drover/flip/accounts';
import { resolveResumeFlavor } from '@/resume/handleResumeCommand';

import { buildSessionChildEnvironment, wrapTmuxCommandWithSessionEnvironmentSanitizer } from './sessionEnvironment';
import { appendDaemonPermissionArgs } from './spawnModeArgs';
import {
    droverBinExists as defaultDroverBinExists,
    droverBinPath as defaultDroverBinPath,
    formatDroverPaneCommand,
    spawnPreconditionError,
    tmuxWindowNameForDirectory,
    type DaemonAgent,
} from './tmuxSpawn';
import type { SessionEncryptionData, TrackedSession } from './types';

/**
 * What the daemon has to hand the window path. Every piece that touches the
 * machine is injectable so a test can drive the whole path with a fake tmux
 * and no wrapper on disk.
 */
export interface DroverWindowDeps {
    /** The daemon's environment with session lineage already stripped. */
    ambientEnvironment: NodeJS.ProcessEnv;
    isTmuxAvailable: () => Promise<boolean>;
    /** Resolved per call: `DROVER_BIN` can change under a running daemon. */
    droverBin?: () => string;
    droverExists?: (path: string) => boolean;
    tmuxFor: (sessionName: string) => Pick<TmuxUtilities, 'spawnInTmux'>;
    track: (pid: number, session: TrackedSession) => void;
    awaitWebhook: (pid: number, label: string) => Promise<SpawnSessionResult>;
}

export interface DroverWindowRequest {
    directory: string;
    /** The argv the pane runs, once the wrapper's path is known. */
    paneCommand: (droverBin: string) => string;
    /** Values set on the window: the request's env plus the session's own. */
    extraEnv: Record<string, string>;
    /**
     * Keys the window must NOT inherit from the daemon or from the tmux
     * server, on top of the session-scoped set every window sheds. A resume
     * onto the ambient account unsets CLAUDE_CONFIG_DIR this way.
     */
    unsetKeys?: string[];
    /** Override for WHICH tmux session; empty means the user's own server. */
    tmuxSessionName?: string;
    directoryCreated?: boolean;
    /** What the tracked record says, given the window it got. */
    message: (windowDesc: string) => string;
    /** Suffix on the awaiter's log lines. */
    label?: string;
}

export async function openDroverWindow(deps: DroverWindowDeps, request: DroverWindowRequest): Promise<SpawnSessionResult> {
    const droverBin = (deps.droverBin ?? defaultDroverBinPath)();
    const precondition = spawnPreconditionError({
        tmuxAvailable: await deps.isTmuxAvailable(),
        droverBin,
        droverExists: (deps.droverExists ?? defaultDroverBinExists)(droverBin),
    });
    if (precondition) {
        logger.debug(`[DAEMON RUN] Refusing to open a window: ${precondition}`);
        return { type: 'error', errorMessage: precondition };
    }

    // Unset means "the user's existing server" rather than "headless":
    // `spawnInTmux` resolves an empty name to the first session it lists.
    const tmuxSessionName = request.tmuxSessionName ?? '';
    logger.debug(`[DAEMON RUN] Opening a window in tmux session: ${tmuxSessionName || 'the first existing one'}`);
    const tmux = deps.tmuxFor(tmuxSessionName);

    const unsetKeys = request.unsetKeys ?? [];
    const command = wrapTmuxCommandWithSessionEnvironmentSanitizer(
        request.paneCommand(droverBin),
        request.extraEnv,
        unsetKeys,
    );

    // Named for the directory, so `tmux list-windows` reads like the work
    // instead of `happy-<epoch-ms>-<agent>`.
    const windowName = tmuxWindowNameForDirectory(request.directory);

    // The complete safe environment (ambient + extraEnv), because tmux needs
    // explicit -e values and the daemon's expanded auth variables have to
    // reach the window. The pane keys are deliberately NOT stripped (BASED-140):
    // tmux overrides TMUX_PANE when it spawns the pane, so the value passed
    // through -e never reaches the session.
    const tmuxEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(buildSessionChildEnvironment(deps.ambientEnvironment, request.extraEnv))) {
        if (value !== undefined && !unsetKeys.includes(key)) {
            tmuxEnv[key] = value;
        }
    }

    const tmuxResult = await tmux.spawnInTmux([command], {
        sessionName: tmuxSessionName,
        windowName,
        cwd: request.directory,
    }, tmuxEnv);

    if (!tmuxResult.success) {
        logger.debug(`[DAEMON RUN] Failed to open a tmux window: ${tmuxResult.error}`);
        return {
            type: 'error',
            errorMessage: `Could not open a tmux window for this session: ${tmuxResult.error ?? 'unknown tmux error'}. `
                + 'Nothing was started headless: a drover session is only a session when the terminal can see it.',
        };
    }

    logger.debug(`[DAEMON RUN] Opened tmux window ${tmuxResult.sessionId}, PID: ${tmuxResult.pid}`);

    if (!tmuxResult.pid) {
        throw new Error('Tmux window created but no PID returned');
    }

    // This PID is the pane's, which is the launcher chain's head rather than
    // the session process itself; `onHappySessionWebhook` walks up from the
    // reporting pid to find it and then re-keys the record.
    const trackedSession: TrackedSession = {
        startedBy: 'daemon',
        pid: tmuxResult.pid,
        tmuxSessionId: tmuxResult.sessionId,
        directoryCreated: request.directoryCreated ?? false,
        message: request.message(tmuxResult.sessionId ?? windowName),
    };
    deps.track(tmuxResult.pid, trackedSession);

    const label = request.label ?? ' (tmux)';
    logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${tmuxResult.pid}${label}`);
    return deps.awaitWebhook(tmuxResult.pid, label);
}

/**
 * The account a resumed session starts on, as environment for its window.
 *
 * Mirrors `drover account use` (libexec/drover-account): DROVER_ACCOUNT is
 * stamped, and CLAUDE_CONFIG_DIR is set to the account's dir, or UNSET for the
 * ambient account, because pointing it at ~/.claude moves the global config to
 * an empty file and lands in a login wizard. No account means no opinion: the
 * window keeps whatever the daemon runs on, as bin/drover does with no
 * registry. `runClaude` then seeds CLAUDE_CONFIG_DIR from the process env
 * into the session record (DROVE-77), so the inbox socket and the idle gate
 * read the account the resumed claude actually runs under.
 */
export function accountStartEnvironment(account: DroverAccount | undefined): { env: Record<string, string>; unset: string[] } {
    if (!account) return { env: {}, unset: [] };
    if (account.ambient) {
        return { env: { DROVER_ACCOUNT: account.name }, unset: ['CLAUDE_CONFIG_DIR'] };
    }
    return { env: { DROVER_ACCOUNT: account.name, CLAUDE_CONFIG_DIR: account.configDir }, unset: [] };
}

/**
 * The start-path account decision (DROVE-21) as the daemon asks it: where the
 * session was left, else the account last used in the directory, else the
 * first with headroom. `run.ts` wraps `pickStartAccount` in one of these.
 */
export type PickStartAccount = (pick: { cwd: string; sessionId?: string; model?: string }) => DroverAccount | undefined;

export interface StartAccountInput {
    agent: DaemonAgent;
    cwd: string;
    /** The provider conversation the pane resumes, when there is one. */
    resumeId?: string;
    /** The model the phone asked for, when it asked for one. */
    model?: string;
    /**
     * What the request itself set on the window. A request that already names
     * an account (DROVER_ACCOUNT or CLAUDE_CONFIG_DIR) keeps it, as bin/drover
     * keeps a start that arrives stamped.
     */
    requestEnv?: Record<string, string>;
    /** The daemon's own environment, for the DROVER_PICK_ACCOUNT=0 off switch. */
    ambientEnv?: NodeJS.ProcessEnv;
    pickAccount?: PickStartAccount;
}

/**
 * The ONE account decision for a session the daemon starts, spawn or resume
 * (DROVE-87).
 *
 * A terminal `drover` asks pick-account before it execs; a phone-started
 * window runs `drover claude ...`, which names the agent first, and bin/drover
 * deliberately makes no account decision for that shape. So the daemon makes
 * it, and it makes it HERE for both paths: a resume from the phone went
 * through this rule since DROVE-76 while a new session took whatever account
 * the daemon's environment carried, which is how a fresh phone session landed
 * on risserproperties when Clay was last on jamrizzi.
 *
 * Claude only: the registry is a registry of Claude logins. A request that
 * already carries a stamp or a config dir is left alone, and so is a start
 * with the picker switched off, the two skips bin/drover applies. Nothing
 * else decides: the wrapper sees the agent name first and asks nothing
 * (tests/start.bats in cattle-drover pins that), so the decision is made
 * exactly once.
 */
export function startAccountEnvironment(input: StartAccountInput): { env: Record<string, string>; unset: string[] } {
    const requestEnv = input.requestEnv ?? {};
    if (input.agent !== 'claude' || !input.pickAccount) return accountStartEnvironment(undefined);
    if (requestEnv.DROVER_ACCOUNT !== undefined || requestEnv.CLAUDE_CONFIG_DIR !== undefined) {
        return accountStartEnvironment(undefined);
    }
    if ((requestEnv.DROVER_PICK_ACCOUNT ?? input.ambientEnv?.DROVER_PICK_ACCOUNT) === '0') {
        return accountStartEnvironment(undefined);
    }
    return accountStartEnvironment(input.pickAccount({
        cwd: input.cwd,
        ...(input.resumeId ? { sessionId: input.resumeId } : {}),
        ...(input.model ? { model: input.model } : {}),
    }));
}

export interface DaemonResumeLaunch {
    agent: DaemonAgent;
    cwd: string;
    /** The provider conversation the pane resumes: `--resume <id>`. */
    resumeId: string;
    modeArgs: string[];
    extraEnv: Record<string, string>;
    unsetKeys: string[];
}

export interface DaemonResumeInput {
    happySessionId: string;
    metadata: Metadata;
    encryption: SessionEncryptionData;
    options?: { model?: string; permissionMode?: string };
    /**
     * The start-path account decision (DROVE-21), asked only for a Claude
     * resume, through `startAccountEnvironment`: the same call a spawn makes.
     */
    pickAccount?: PickStartAccount;
    skipPermissions?: boolean;
}

/**
 * Everything a resume needs before the window opens, as data.
 *
 * The pane runs `drover <agent> --happy-starting-mode local --started-by daemon
 * <modeArgs> --resume <id>`, the same shape a phone-started fork already runs.
 * HAPPY_RECONNECT_* rides in the window's environment so the resumed CLI
 * reattaches to the SAME Happy session id instead of minting a new one: the
 * app lands back on the session it tapped Resume on.
 */
export function buildDaemonResumeLaunch(input: DaemonResumeInput): DaemonResumeLaunch {
    const { happySessionId, metadata, encryption, options } = input;
    const flavor = resolveResumeFlavor(metadata);

    if (flavor !== 'claude' && flavor !== 'codex') {
        throw new Error(`Happy session ${happySessionId} uses unsupported flavor "${metadata.flavor ?? 'unknown'}".`);
    }
    const resumeId = flavor === 'codex' ? metadata.codexThreadId : metadata.claudeSessionId;
    if (!resumeId) {
        throw new Error(flavor === 'codex'
            ? `Happy session ${happySessionId} is missing its Codex thread ID.`
            : `Happy session ${happySessionId} is missing its Claude session ID.`);
    }

    const modeArgs: string[] = [];
    if (options?.model) {
        modeArgs.push('--model', options.model);
    }
    if (input.skipPermissions === undefined) {
        appendDaemonPermissionArgs(modeArgs, flavor, options?.permissionMode);
    } else {
        appendDaemonPermissionArgs(modeArgs, flavor, options?.permissionMode, input.skipPermissions);
    }

    const accountEnv = startAccountEnvironment({
        agent: flavor,
        cwd: metadata.path,
        resumeId,
        model: options?.model,
        pickAccount: input.pickAccount,
    });

    return {
        agent: flavor,
        cwd: metadata.path,
        resumeId,
        modeArgs,
        extraEnv: {
            ...accountEnv.env,
            HAPPY_RECONNECT_SESSION_ID: happySessionId,
            HAPPY_RECONNECT_ENCRYPTION_KEY: encodeBase64(encryption.encryptionKey),
            HAPPY_RECONNECT_ENCRYPTION_VARIANT: encryption.encryptionVariant,
            HAPPY_RECONNECT_SEQ: String(encryption.seq),
            HAPPY_RECONNECT_METADATA_VERSION: String(encryption.metadataVersion),
            HAPPY_RECONNECT_AGENT_STATE_VERSION: String(encryption.agentStateVersion),
        },
        unsetKeys: accountEnv.unset,
    };
}

/** The pane command for a resume: the wrapper, local mode, `--resume <id>`. */
export function resumePaneCommand(droverBin: string, launch: DaemonResumeLaunch): string {
    return formatDroverPaneCommand({
        droverBin,
        agent: launch.agent,
        modeArgs: launch.modeArgs,
        resumeId: launch.resumeId,
    });
}

/**
 * Resume a tracked session into a tmux window. The only resume path there is.
 */
export async function resumeInDroverWindow(
    deps: DroverWindowDeps,
    input: DaemonResumeInput,
    directoryExists: (path: string) => Promise<boolean>,
): Promise<SpawnSessionResult> {
    const launch = buildDaemonResumeLaunch(input);
    if (!(await directoryExists(launch.cwd))) {
        return { type: 'error', errorMessage: `Saved session path does not exist: ${launch.cwd}` };
    }
    return openDroverWindow(deps, {
        directory: launch.cwd,
        paneCommand: (droverBin) => resumePaneCommand(droverBin, launch),
        extraEnv: launch.extraEnv,
        unsetKeys: launch.unsetKeys,
        message: (windowDesc) => `Opened a tmux window '${windowDesc}' to resume the session. Attach with 'tmux attach'.`,
        label: ' (tmux resume)',
    });
}
