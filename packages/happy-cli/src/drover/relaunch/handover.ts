/**
 * Handing one session's launcher over to the rebuilt one (DROVE-172).
 *
 * The launcher cannot swap its own code: node has read the bundle and there is
 * no execve to reach for. What it CAN do is exit with a code the wrapper
 * above it understands, and `bin/drover.mjs` -- which is a blocking parent for
 * the whole life of the session, so the tmux pane belongs to IT, not to us --
 * spawns the new bundle in the same pane.
 *
 * That the conversation survives is not a hope, it is BASED-98 already
 * shipped: `drover --resume <claude session id>` finds the Happy session whose
 * metadata names that transcript and reconnects to it, so the phone sees one
 * continuous session rather than a second copy. It is the same argv the daemon
 * and `bin/drover`'s own picker already use, and the same relaunch a flip
 * performs one level lower down.
 *
 * ONE THING HAD TO BE ADDED for it: `findHappySessionForClaudeSession` refuses
 * to reattach while the server still calls the session active, because two
 * wrappers on one session would both answer the phone. On a handover the
 * outgoing wrapper's keepalive is seconds old, so without a word from us the
 * incoming one would decline and mint a duplicate -- exactly the bug BASED-98
 * closed. So the handover names the Happy session it is releasing, and the
 * live check is waived for that one id and no other.
 */

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Exit code the launcher uses to ask its wrapper for the same session on the
 * new bundle. 75 is EX_TEMPFAIL: "try again", which is the whole meaning here.
 * Claude Code itself exits 0/1/143, so nothing else in the tree produces it.
 */
export const relaunchExitCode = 75

/**
 * Where the launcher writes the argv for its replacement. Set by
 * `bin/drover.mjs`; its ABSENCE is the signal that nobody is supervising us,
 * in which case a relaunch would end the session instead of continuing it and
 * must not be attempted.
 */
export const relaunchFileEnv = 'DROVER_RELAUNCH_FILE'

/** The Happy session the outgoing wrapper is releasing. See the note above. */
export const handoverSessionEnv = 'DROVER_RELAUNCH_HANDOVER'

export interface RelaunchRequest {
    /** argv for the replacement, excluding node and the script path. */
    argv: string[]
    /** The Happy session id being handed over, so the replacement may reattach. */
    happySessionId?: string
}

/** Is there a wrapper above us that will bring the session back? */
export function relaunchIsSupervised(env: NodeJS.ProcessEnv = process.env): boolean {
    const path = env[relaunchFileEnv]
    return typeof path === 'string' && path.length > 0
}

/**
 * The argv the replacement should run.
 *
 * Two things are rewritten and nothing else is touched -- an account, a
 * `--yolo`, a `--claude-env`, a `--started-by daemon` all mean the same thing
 * to the new process as they did to this one.
 *
 *   --resume / -r / --continue / -c   replaced by an explicit
 *                                     `--resume <claudeSessionId>`, whatever
 *                                     spelling got us here.
 *   --seed <file>                     dropped. runClaude keeps the clone seed
 *                                     off the argv precisely so a relaunch
 *                                     cannot paste the whole seeded
 *                                     conversation in a second time; an argv
 *                                     we rebuild has to honour that.
 */
export function buildRelaunchArgv(argv: string[], claudeSessionId: string): string[] {
    if (!uuidPattern.test(claudeSessionId)) {
        throw new Error(`refusing to relaunch onto a non-uuid claude session id: ${claudeSessionId}`)
    }
    const out: string[] = []
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === '--resume' || arg === '-r') {
            // Only eat a following value when it IS the id. A bare `--resume`
            // is the picker, and the next token belongs to someone else.
            if (uuidPattern.test(argv[i + 1] ?? '')) i++
            continue
        }
        if (arg === '--continue' || arg === '-c') continue
        if (arg === '--seed') {
            i++
            continue
        }
        out.push(arg)
    }
    out.push('--resume', claudeSessionId)
    return out
}
