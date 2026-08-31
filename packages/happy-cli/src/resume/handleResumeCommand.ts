import { existsSync } from 'node:fs';

import type { Metadata } from '@/api/types';
import { encodeBase64 } from '@/api/encryption';
import { hasLocalHappyAgentAuth } from '@/resume/localHappyAgentAuth';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { buildSessionChildEnvironment, sanitizeSessionEnvironment } from '@/daemon/sessionEnvironment';

import { LocalResumeSessionError, resolveLocalReconnectableSession } from './localResumeStore';
import { resolveHappySession, type ReconnectableHappySession, type ResumableHappySession } from './resolveHappySession';

export type ResumeLaunch = {
    cwd: string;
    args: string[];
};

export type ResumeLaunchOptions = {
    claudeStartingMode?: 'local' | 'remote';
    startedBy?: 'daemon' | 'terminal';
};

export function parseResumeCommandArgs(args: string[]): { showHelp: boolean; sessionId: string } {
    if (args.includes('-h') || args.includes('--help')) {
        return {
            showHelp: true,
            sessionId: '',
        };
    }

    if (args.length === 0) {
        throw new Error('Happy session ID is required: drover resume <session-id>');
    }
    if (args.length > 1) {
        throw new Error(`Unexpected arguments for drover resume: ${args.slice(1).join(' ')}`);
    }

    return {
        showHelp: false,
        sessionId: args[0],
    };
}

/** Which agent a Happy session belongs to, from its metadata. Shared with the daemon's resume (DROVE-76). */
export function resolveResumeFlavor(metadata: Metadata): 'codex' | 'claude' | null {
    if (metadata.flavor === 'codex' || metadata.codexThreadId) {
        return 'codex';
    }
    if (metadata.flavor === 'claude' || metadata.claudeSessionId) {
        return 'claude';
    }
    return null;
}

/**
 * Why a resume is refused, in the harness's own terms (DROVE-56).
 *
 * Both resume paths threw `uses unsupported flavor "opencode"`, which reads as
 * a gap somebody forgot to fill. For OpenCode it is not a gap, it is measured:
 * on 1.18.20 `opencode --session <id>` will not create or adopt an id the
 * server does not already own and kills the pane at startup, and `opencode
 * attach --session <id>` connects but draws an EMPTY transcript. So there is
 * nothing to reopen a conversation ONTO. A pane that looked like the session
 * and held none of it would be worse than the refusal.
 *
 * Cursor has no resume flag of its own either, and nothing has been measured,
 * so it gets the plain sentence rather than a confident one.
 */
export function unsupportedResumeReason(sessionId: string, flavor: string | null | undefined): string {
    const named = flavor ?? 'unknown';
    if (flavor === 'opencode') {
        return (
            `Happy session ${sessionId} is an OpenCode session, and OpenCode cannot reopen one. `
            + '`opencode --session <id>` refuses an id its server does not already hold, and `attach` '
            + 'draws an empty transcript (measured on 1.18.20). Start a fresh one with `drover opencode`, '
            + 'or carry this conversation over with `drover clone ' + sessionId + ' --to opencode`.'
        );
    }
    return `Happy session ${sessionId} uses unsupported flavor "${named}".`;
}

export function buildResumeLaunch(session: ResumableHappySession, options: ResumeLaunchOptions = {}): ResumeLaunch {
    const { metadata } = session;
    const flavor = resolveResumeFlavor(metadata);

    if (flavor === 'codex') {
        if (!metadata.codexThreadId) {
            throw new Error(`Happy session ${session.id} is missing its Codex thread ID.`);
        }
        const args = ['codex', '--resume', metadata.codexThreadId];
        if (options.startedBy) {
            args.push('--started-by', options.startedBy);
        }
        return {
            cwd: metadata.path,
            args,
        };
    }

    if (flavor === 'claude') {
        if (!metadata.claudeSessionId) {
            throw new Error(`Happy session ${session.id} is missing its Claude session ID.`);
        }
        const args = ['claude'];
        if (options.claudeStartingMode) {
            args.push('--happy-starting-mode', options.claudeStartingMode);
        }
        if (options.startedBy) {
            args.push('--started-by', options.startedBy);
        }
        args.push('--resume', metadata.claudeSessionId);
        return {
            cwd: metadata.path,
            args,
        };
    }

    throw new Error(unsupportedResumeReason(session.id, metadata.flavor));
}

export function formatResumeHelp(): string {
    return [
        'drover resume - Resume a previous Happy session',
        '',
        'Usage:',
        '  drover resume <happy-session-id>',
        '',
        'Examples:',
        '  drover resume cmmij8olq00dp5jcxr3wtbpau',
        '  drover resume cmmij8',
        '',
        'This reuses the saved worktree/path and resumes the underlying agent session',
        'when the backend supports it.',
    ].join('\n');
}

function buildReconnectEnv(session: ReconnectableHappySession): NodeJS.ProcessEnv {
    return buildSessionChildEnvironment(process.env, {
        HAPPY_RECONNECT_SESSION_ID: session.id,
        HAPPY_RECONNECT_ENCRYPTION_KEY: encodeBase64(session.encryptionKey),
        HAPPY_RECONNECT_ENCRYPTION_VARIANT: session.encryptionVariant,
        HAPPY_RECONNECT_SEQ: String(session.seq),
        HAPPY_RECONNECT_METADATA_VERSION: String(session.metadataVersion),
        HAPPY_RECONNECT_AGENT_STATE_VERSION: String(session.agentStateVersion),
    });
}

function spawnResumeChild(launch: ResumeLaunch, env: NodeJS.ProcessEnv = sanitizeSessionEnvironment(process.env)): Promise<number | null> {
    return new Promise((resolve, reject) => {
        const child = spawnHappyCLI(launch.args, {
            cwd: launch.cwd,
            env,
            stdio: 'inherit',
        });

        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (signal) {
                reject(new Error(`Resumed session exited via signal ${signal}`));
                return;
            }
            resolve(code);
        });
    });
}

async function resolveLegacySessionIfAvailable(sessionId: string): Promise<ResumableHappySession | null> {
    if (!hasLocalHappyAgentAuth()) {
        return null;
    }
    return resolveHappySession(sessionId);
}

export async function handleResumeCommand(args: string[]): Promise<void> {
    const parsed = parseResumeCommandArgs(args);
    if (parsed.showHelp) {
        console.log(formatResumeHelp());
        return;
    }

    let localError: unknown;
    let reconnectableSession: ReconnectableHappySession | null = null;
    try {
        reconnectableSession = await resolveLocalReconnectableSession(parsed.sessionId);
    } catch (error) {
        localError = error;
        if (error instanceof LocalResumeSessionError && error.code === 'ambiguous') {
            throw error;
        }
    }

    if (reconnectableSession) {
        const launch = buildResumeLaunch(reconnectableSession);

        if (!existsSync(launch.cwd)) {
            throw new Error(`Saved session path does not exist: ${launch.cwd}`);
        }

        const exitCode = await spawnResumeChild(launch, buildReconnectEnv(reconnectableSession));
        if (typeof exitCode === 'number' && exitCode !== 0) {
            process.exit(exitCode);
        }
        return;
    }

    const session = await resolveLegacySessionIfAvailable(parsed.sessionId);
    if (!session) {
        throw localError;
    }
    const launch = buildResumeLaunch(session);

    if (!existsSync(launch.cwd)) {
        throw new Error(`Saved session path does not exist: ${launch.cwd}`);
    }

    const exitCode = await spawnResumeChild(launch);
    if (typeof exitCode === 'number' && exitCode !== 0) {
        process.exit(exitCode);
    }
}
