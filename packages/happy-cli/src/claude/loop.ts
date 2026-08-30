import { ApiSessionClient } from "@/api/apiSession"
import { MessageQueue2 } from "@/utils/MessageQueue2"
import { logger } from "@/ui/logger"
import { Session } from "./session"
import { claudeLocalLauncher, LauncherResult } from "./claudeLocalLauncher"
import { claudeRemoteLauncher } from "./claudeRemoteLauncher"
import { ApiClient } from "@/lib"
import type { JsRuntime } from "./runClaude"
import type { SandboxConfig } from "@/persistence"
import type { FlipController } from "@/drover/flip/controller"
import type { UsageReporter } from "@/drover/flip/usage"

// Re-export permission mode type from api/types
// Single unified type with 7 modes - Codex modes mapped at SDK boundary
export type { PermissionMode } from "@/api/types"
import type { PermissionMode } from "@/api/types"

// `ultracode` is not one more notch: Claude Code 2.1.251 parses
// `--effort ultracode` as xhigh plus dynamic workflow orchestration for that
// process (alias table T={ultracode:"xhigh"} in the binary; `--help` lists
// only low..max). Session-only by design, which suits us: remote mode spawns
// a fresh child on every effort change anyway.
export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultracode';

export interface EnhancedMode {
    /** Unset means "no override" — Claude uses its own configured mode. */
    permissionMode?: PermissionMode;
    model?: string;
    fallbackModel?: string;
    customSystemPrompt?: string;
    appendSystemPrompt?: string;
    allowedTools?: string[];
    disallowedTools?: string[];
    /** Effort level passed through to the Claude Agent SDK as the `effort` option. */
    effort?: ClaudeEffort;
}

interface LoopOptions {
    path: string
    model?: string
    permissionMode?: PermissionMode
    startingMode?: 'local' | 'remote'
    onModeChange: (mode: 'local' | 'remote') => void
    mcpServers: Record<string, any>
    session: ApiSessionClient
    api: ApiClient,
    claudeEnvVars?: Record<string, string>
    claudeArgs?: string[]
    messageQueue: MessageQueue2<EnhancedMode>
    allowedTools?: string[]
    sandboxConfig?: SandboxConfig
    onSessionReady?: (session: Session) => void
    onAbort?: () => void
    /** Path to temporary settings file with SessionStart hook (required for session tracking) */
    hookSettingsPath: string
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    jsRuntime?: JsRuntime
    /** Cattle Drover account flip controller, when more than one account exists. */
    flip?: FlipController
    /** Publishes every account's headroom onto the session's metadata (DROVE-47). */
    usage?: UsageReporter
    /** Set when runClaude reattached to the Happy session holding this transcript (BASED-98). */
    reattachedClaudeSessionId?: string
}

export async function loop(opts: LoopOptions): Promise<number> {

    // Get log path for debug display
    const logPath = logger.logFilePath;
    let session = new Session({
        api: opts.api,
        client: opts.session,
        path: opts.path,
        sessionId: null,
        claudeEnvVars: opts.claudeEnvVars,
        claudeArgs: opts.claudeArgs,
        mcpServers: opts.mcpServers,
        logPath: logPath,
        messageQueue: opts.messageQueue,
        allowedTools: opts.allowedTools,
        sandboxConfig: opts.sandboxConfig,
        startingMode: opts.startingMode,
        onModeChange: opts.onModeChange,
        onAbort: opts.onAbort,
        hookSettingsPath: opts.hookSettingsPath,
        jsRuntime: opts.jsRuntime,
        flip: opts.flip,
        usage: opts.usage,
        reattachedClaudeSessionId: opts.reattachedClaudeSessionId,
    });

    opts.onSessionReady?.(session)

    let mode: 'local' | 'remote' = opts.startingMode ?? 'local';
    while (true) {
        logger.debug(`[loop] Iteration with mode: ${mode}`);

        switch (mode) {
            case 'local': {
                const result = await claudeLocalLauncher(session);
                switch (result.type ) {
                    case 'switch':
                        mode = 'remote';
                        // Through the session, not straight to the callback
                        // (DROVE-8): Session.onModeChange records the new mode,
                        // fires one heartbeat carrying it, THEN calls this same
                        // callback. Calling opts.onModeChange directly left
                        // session-alive saying 'local' for the life of the
                        // process, whichever launcher was actually running.
                        session.onModeChange(mode);
                        break;
                    case 'exit':
                        return result.code;
                    default:
                        const _: never = result satisfies never;
                }
                break;
            }

            case 'remote': {
                const reason = await claudeRemoteLauncher(session);
                switch (reason) {
                    case 'exit':
                        return 0;
                    case 'switch':
                        mode = 'local';
                        session.onModeChange(mode);
                        break;
                    default:
                        const _: never = reason satisfies never;
                }
                break;
            }

            default: {
                const _: never = mode satisfies never;
            }
        }
    }
}
