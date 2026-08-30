import { basename } from "node:path";

import { ApiClient, ApiSessionClient } from "@/lib";
import { MessageQueue2 } from "@/utils/MessageQueue2";
import { EnhancedMode } from "./loop";
import { logger } from "@/ui/logger";
import type { JsRuntime } from "./runClaude";
import type { SandboxConfig } from "@/persistence";
import type { FlipController } from "@/drover/flip/controller";
import type { UsageReporter } from "@/drover/flip/usage";

/**
 * The flags that point Claude Code at a transcript that ALREADY EXISTS, rather
 * than at a new one. One list, used by both readers below, because they went
 * out of step once already: consumeOneTimeFlags learned `-r`/`-c` after a flip
 * sent a `drover -r` session to Claude's picker, and anything else sniffing
 * for a resume has to learn the same lesson or it silently misjudges the run.
 */
const resumeFlags = new Set(['--resume', '-r', '--continue', '-c']);

/**
 * Is this run pointed at a transcript that already exists on disk?
 *
 * True for EVERY shape of resume, bare `--resume` included. Bare `--resume` is
 * the one that matters: it opens Claude's picker, so the transcript id does not
 * exist until the SessionStart hook fires — far too late for the reattach path
 * in @/resume/reattachClaudeSession to choose a Happy session for it. That is
 * the hole Clay fell down. `drover --resume` against a 190 MB transcript minted
 * a fresh Happy session every run and the scanner streamed days of old messages
 * into it as brand-new user prompts.
 *
 * Only meaningful BEFORE the first spawn: consumeOneTimeFlags() strips these
 * afterwards, which is what makes a second launcher run (a local -> remote ->
 * local switch) correctly answer no.
 */
export function resumesExistingTranscript(claudeArgs: string[] | undefined): boolean {
    return claudeArgs?.some((arg) => resumeFlags.has(arg)) ?? false;
}

/**
 * What a session is called before anything better exists.
 *
 * The working directory basename, prefixed with the drover account when there
 * is one, because `[account] basename` is the shape a flip already stamps. Both
 * ends share this function so the two cannot drift: a start name of a different
 * shape would make every flip read as a rename rather than an account change.
 *
 * Deliberately deterministic. A summarizer would be prettier and would also be
 * wrong for the first few turns, and this string only has to beat "New chat".
 */
export function defaultSessionName(workingDirectory: string, droverAccount?: string): string {
    const name = basename(workingDirectory) || workingDirectory;
    return droverAccount ? `[${droverAccount}] ${name}` : name;
}

/**
 * Is this title still one of ours, and therefore ours to restamp?
 *
 * True for `basename` and for `[anything] basename`, and for nothing else. A
 * title Claude Code or the app wrote is not default-shaped, so it survives both
 * a flip and a reattach: restamping one of those is how a session the user had
 * named turns back into a path.
 */
export function isDefaultSessionName(text: string | undefined | null, workingDirectory: string): boolean {
    if (!text) return true;
    return text.replace(/^\[[^\]]*\] /, '') === (basename(workingDirectory) || workingDirectory);
}

export class Session {
    readonly path: string;
    readonly logPath: string;
    readonly api: ApiClient;
    readonly client: ApiSessionClient;
    readonly queue: MessageQueue2<EnhancedMode>;
    // Mutable: a Cattle Drover flip (BASED-98) rewrites CLAUDE_CONFIG_DIR here
    // and the next relaunch of the child picks the new account up. The happy
    // process itself never restarts, which is what keeps the app's session id
    // stable across a flip.
    claudeEnvVars?: Record<string, string>;
    claudeArgs?: string[];  // Made mutable to allow filtering
    /** One-shot prompt handed to the next child, e.g. "carry on" after a flip. */
    pendingInitialPrompt?: string;
    /** Set for a session running under the drover's account controller. */
    flip?: FlipController;
    /** Keeps metadata.droverUsage in step with the usage caches (DROVE-47). */
    usage?: UsageReporter;
    /**
     * The Claude transcript this Happy session was reattached to at start-up
     * (BASED-98). The server already holds every message in it, so the local
     * scanner must pre-mark it rather than stream it to the phone as new.
     */
    reattachedClaudeSessionId?: string;
    readonly mcpServers: Record<string, any>;
    readonly allowedTools?: string[];
    readonly sandboxConfig?: SandboxConfig;
    readonly _onModeChange: (mode: 'local' | 'remote') => void;
    readonly _onAbort?: () => void;
    /** Path to temporary settings file with SessionStart hook (required for session tracking) */
    readonly hookSettingsPath: string;
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    readonly jsRuntime: JsRuntime;

    sessionId: string | null;
    mode: 'local' | 'remote' = 'local';
    thinking: boolean = false;
    
    /** Callbacks to be notified when session ID is found/changed */
    private sessionFoundCallbacks: ((sessionId: string) => void)[] = [];
    
    /** Keep alive interval reference for cleanup */
    private keepAliveInterval: NodeJS.Timeout;

    constructor(opts: {
        api: ApiClient,
        client: ApiSessionClient,
        path: string,
        logPath: string,
        sessionId: string | null,
        claudeEnvVars?: Record<string, string>,
        claudeArgs?: string[],
        mcpServers: Record<string, any>,
        messageQueue: MessageQueue2<EnhancedMode>,
        onModeChange: (mode: 'local' | 'remote') => void,
        onAbort?: () => void,
        allowedTools?: string[],
        sandboxConfig?: SandboxConfig,
        /** Path to temporary settings file with SessionStart hook (required for session tracking) */
        hookSettingsPath: string,
        /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
        jsRuntime?: JsRuntime,
        flip?: FlipController,
        usage?: UsageReporter,
        reattachedClaudeSessionId?: string,
    }) {
        this.flip = opts.flip;
        this.usage = opts.usage;
        this.reattachedClaudeSessionId = opts.reattachedClaudeSessionId;
        this.path = opts.path;
        this.api = opts.api;
        this.client = opts.client;
        this.logPath = opts.logPath;
        this.sessionId = opts.sessionId;
        this.queue = opts.messageQueue;
        this.claudeEnvVars = opts.claudeEnvVars;
        this.claudeArgs = opts.claudeArgs;
        this.mcpServers = opts.mcpServers;
        this.allowedTools = opts.allowedTools;
        this.sandboxConfig = opts.sandboxConfig;
        this._onModeChange = opts.onModeChange;
        this._onAbort = opts.onAbort;
        this.hookSettingsPath = opts.hookSettingsPath;
        this.jsRuntime = opts.jsRuntime ?? 'node';

        // Whether this session lives in a tmux pane, stamped once and never
        // revised: $TMUX_PANE is fixed for the life of the process, and the
        // phone reads it to know the terminal is the session (BASED-113). A
        // daemon-spawned session has no pane and gets `false`, which is the
        // answer the app needs — absent would be indistinguishable from an
        // older CLI that never said.
        this.client.updateMetadata((metadata) => ({
            ...metadata,
            hasPane: !!process.env.TMUX_PANE,
        }));

        // Start keep alive
        this.client.keepAlive(this.thinking, this.mode);
        this.keepAliveInterval = setInterval(() => {
            this.client.keepAlive(this.thinking, this.mode);
        }, 2000);
    }
    
    /**
     * Cleanup resources (call when session is no longer needed)
     */
    cleanup = (): void => {
        clearInterval(this.keepAliveInterval);
        this.sessionFoundCallbacks = [];
        logger.debug('[Session] Cleaned up resources');
    }

    onThinkingChange = (thinking: boolean) => {
        this.thinking = thinking;
        this.client.keepAlive(thinking, this.mode);
    }

    onModeChange = (mode: 'local' | 'remote') => {
        this.mode = mode;
        this.client.keepAlive(this.thinking, mode);
        this._onModeChange(mode);
    }

    onAbort = () => {
        this._onAbort?.();
    }

    /**
     * Called when Claude session ID is discovered or changed.
     * 
     * This is triggered by the SessionStart hook when:
     * - Claude starts a new session (fresh start)
     * - Claude resumes a session (--continue, --resume flags)
     * - Claude forks a session (/compact, double-escape fork)
     * 
     * Updates internal state, syncs to API metadata, and notifies
     * all registered callbacks (e.g., SessionScanner) about the change.
     */
    onSessionFound = (sessionId: string) => {
        this.sessionId = sessionId;
        // A flip resumes by claude session id, and bus frames may address the
        // session by it, so the controller has to learn it the moment Claude
        // reports it rather than waiting for the next flip to go looking.
        if (this.flip) this.flip.claudeSessionId = sessionId;

        // Update metadata with Claude Code session ID
        this.client.updateMetadata((metadata) => ({
            ...metadata,
            claudeSessionId: sessionId
        }));
        logger.debug(`[Session] Claude Code session ID ${sessionId} added to metadata`);
        
        // Notify all registered callbacks
        for (const callback of this.sessionFoundCallbacks) {
            callback(sessionId);
        }
    }
    
    /**
     * Register a callback to be notified when session ID is found/changed
     */
    addSessionFoundCallback = (callback: (sessionId: string) => void): void => {
        this.sessionFoundCallbacks.push(callback);
    }
    
    /**
     * Remove a session found callback
     */
    removeSessionFoundCallback = (callback: (sessionId: string) => void): void => {
        const index = this.sessionFoundCallbacks.indexOf(callback);
        if (index !== -1) {
            this.sessionFoundCallbacks.splice(index, 1);
        }
    }

    /**
     * Clear the current session ID (used by /clear command)
     */
    clearSessionId = (): void => {
        this.sessionId = null;
        logger.debug('[Session] Session ID cleared');
    }

    /**
     * Consume one-time Claude flags from claudeArgs after Claude spawn
     * Handles: --resume/-r (with or without session ID), --continue/-c
     */
    consumeOneTimeFlags = (): void => {
        if (!this.claudeArgs) return;
        
        const filteredArgs: string[] = [];
        for (let i = 0; i < this.claudeArgs.length; i++) {
            const arg = this.claudeArgs[i];
            
            // The short forms are the same one-time flags. A session started
            // with `drover -r` kept the bare -r after a flip and Claude opened
            // its resume picker, same as the long form did before :262/:304.
            // resumeFlags above is the same list, so the launcher's "is this a
            // resume?" question and this stripping can never disagree.
            if (arg === '--continue' || arg === '-c') {
                logger.debug(`[Session] Consumed ${arg} flag`);
                continue;
            }
            
            if (arg === '--resume' || arg === '-r') {
                // Check if next arg looks like a UUID (contains dashes and alphanumeric)
                if (i + 1 < this.claudeArgs.length) {
                    const nextArg = this.claudeArgs[i + 1];
                    // Simple UUID pattern check - contains dashes and is not another flag
                    if (!nextArg.startsWith('-') && nextArg.includes('-')) {
                        // Skip both --resume and the UUID
                        i++; // Skip the UUID
                        logger.debug(`[Session] Consumed --resume flag with session ID: ${nextArg}`);
                    } else {
                        // Just --resume without UUID
                        logger.debug('[Session] Consumed --resume flag (no session ID)');
                    }
                } else {
                    // --resume at the end of args
                    logger.debug('[Session] Consumed --resume flag (no session ID)');
                }
                continue;
            }
            
            filteredArgs.push(arg);
        }
        
        this.claudeArgs = filteredArgs.length > 0 ? filteredArgs : undefined;
        logger.debug(`[Session] Consumed one-time flags, remaining args:`, this.claudeArgs);
    }
}

/**
 * Mirror Claude Code's own `/rename` into the Happy session title.
 *
 * Both `name` and `summary` are stamped, and this is the whole point: the
 * phone's list reads metadata.summary.text (getSessionName in
 * happy-app/sources/utils/sessionUtils.ts) and nothing else, so writing only
 * `name` renames the session everywhere EXCEPT the screen you are looking at.
 * That is exactly what /rename appeared to do — Clay renamed a session to
 * "zap" and the app went on calling it "Greeting / no task yet".
 *
 * Unconditional, unlike the flip's restamp, which only overwrites
 * default-shaped titles. A flip is the machine relabelling a session you did
 * not ask it to touch; /rename is you naming it by hand, so it outranks
 * whatever change_title guessed earlier.
 */
export function applyCustomTitle(session: Session, title: string): void {
    const text = title.trim();
    if (!text) return;
    session.client.updateMetadata((metadata) => ({
        ...metadata,
        name: text,
        summary: { text, updatedAt: Date.now() },
    }));
}
