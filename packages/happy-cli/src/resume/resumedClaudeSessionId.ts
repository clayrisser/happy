/**
 * Which Claude transcript a `--resume` / `--continue` in claudeArgs lands on.
 *
 * Lives in its own module (DROVE-288) because `pick-account` runs before
 * EVERY session start and needs exactly this and nothing else. Its old home,
 * reattachClaudeSession.ts, drags in axios and the whole persistence stack —
 * a couple hundred ms of import cost for a function that only reads argv and
 * transcript files. reattachClaudeSession re-exports it, so every existing
 * importer is untouched.
 */

import { claudeFindLastSession } from '@/claude/utils/claudeFindLastSession';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The Claude transcript a `--resume` / `--continue` in claudeArgs will land on,
 * or null when it cannot be known before Claude starts.
 *
 * Mirrors claudeLocal's own flag handling so the two agree on the transcript.
 * Bare `--resume` is Claude's picker: the id only exists once the SessionStart
 * hook fires, too late to choose a Happy session, so it stays a fresh session.
 * That is the twin-session bug of DROVE-50, and it is closed on the OTHER side
 * of the exec: bin/drover answers a bare `--resume` (and `-c`) with its own
 * picker and starts this CLI as `--resume <id>`, so by the time this runs the
 * id is always in claudeArgs. The null branch is kept for a plain, unwrapped
 * invocation and for DROVER_RESUME_PICKER=0, which asks for the old behaviour.
 */
export function resumedClaudeSessionId(claudeArgs: string[] | undefined, workingDirectory: string): string | null {
    if (!claudeArgs) return null;
    for (let i = 0; i < claudeArgs.length; i++) {
        const arg = claudeArgs[i];
        if (arg === '--resume' || arg === '-r') {
            const value = claudeArgs[i + 1];
            return value && uuidPattern.test(value) ? value : null;
        }
        if (arg === '--continue' || arg === '-c') {
            return claudeFindLastSession(workingDirectory);
        }
    }
    return null;
}
