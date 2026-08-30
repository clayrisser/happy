import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The config dir Claude Code keeps its projects/transcripts under.
 *
 * The explicit argument exists because a Cattle Drover flip (BASED-98) moves a
 * live session onto another account without touching this process's own env:
 * the new dir is handed to the CHILD in `session.claudeEnvVars`, and the
 * wrapper's `process.env.CLAUDE_CONFIG_DIR` deliberately keeps naming the
 * account we left. Anything in the wrapper that has to follow the transcript
 * must therefore be told which dir to look in, not ask the environment.
 *
 * An empty string falls back rather than resolving to `/projects/...`, because
 * empty is how claudeLocal's env merge spells "unset this" for the ambient
 * account. Callers that legitimately mean "wherever this process was started"
 * pass nothing and get the old behaviour.
 */
export function resolveClaudeConfigDir(claudeConfigDir?: string | null): string {
    if (claudeConfigDir) {
        return claudeConfigDir;
    }
    return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

export function getProjectPath(workingDirectory: string, claudeConfigDir?: string | null) {
    const projectId = resolve(workingDirectory).replace(/[^a-zA-Z0-9-]/g, '-');
    return join(resolveClaudeConfigDir(claudeConfigDir), 'projects', projectId);
}
