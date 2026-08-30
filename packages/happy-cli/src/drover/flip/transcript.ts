/**
 * Carrying the conversation across accounts (BASED-98).
 *
 * This is the mechanism the whole flip rests on, and it is not obvious.
 * `claude --resume <id>` reads the transcript from
 *
 *     $CLAUDE_CONFIG_DIR/projects/<munged-cwd>/<id>.jsonl
 *
 * and CLAUDE_CONFIG_DIR is precisely what a flip changes. So the second
 * account cannot see the first account's session at all: resume would fail,
 * or worse, start something empty wearing the same id. Copying the transcript
 * into the target config dir first is what makes "carry on where we left off"
 * literally true rather than a prompt pretending it is.
 *
 * The sibling `<id>/` directory goes with it — that is where subagent
 * transcripts live, and the default flip prompt asks for the subagents back.
 *
 * Nothing is moved and nothing is deleted: the source account keeps its copy,
 * so a flip is reversible and a mistake costs disk, not history.
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { logger } from '@/ui/logger'

/** The same munging claude/utils/path.ts does, against an explicit config dir. */
export function projectDirFor(configDir: string, workingDirectory: string): string {
    const projectId = resolve(workingDirectory).replace(/[^a-zA-Z0-9-]/g, '-')
    return join(configDir, 'projects', projectId)
}

export interface CarryResult {
    ok: boolean
    /** Why not, when it did not happen — surfaced to the app, so plain words. */
    reason?: string
    /** Bytes of the transcript carried, for the log. */
    bytes?: number
    /** True when subagent transcripts came along. */
    subagents?: boolean
    /**
     * Both accounts already reach the same directory on disk, so there was
     * nothing to carry and carrying would have been wrong (DROVE-40).
     */
    shared?: boolean
    /**
     * The session has not written a transcript yet, so there is nothing to
     * carry and nothing to lose. Distinct from a failure: Claude allocates a
     * session id at startup but only writes the file once there is a turn, so
     * this is exactly what an untouched session looks like. The flip goes
     * ahead WITHOUT --resume rather than refusing over an empty conversation.
     */
    nothingToCarry?: boolean
}

/**
 * Copy one session's transcript from one account's config dir into another's.
 *
 * Overwrites a same-named transcript in the target: the id is a uuid, so a
 * collision means this session flipped here before and the source is the
 * newer, longer copy of the same conversation.
 */
export function carryTranscript(opts: {
    sessionId: string
    workingDirectory: string
    fromConfigDir: string
    toConfigDir: string
}): CarryResult {
    const { sessionId, workingDirectory, fromConfigDir, toConfigDir } = opts

    if (resolve(fromConfigDir) === resolve(toConfigDir)) {
        return { ok: true, reason: 'same config dir, nothing to carry' }
    }

    const srcDir = projectDirFor(fromConfigDir, workingDirectory)
    const dstDir = projectDirFor(toConfigDir, workingDirectory)

    // Different config dirs can still be one directory on disk, once the
    // accounts share a session store (DROVE-40). Compare where the paths
    // actually LAND, not what they are spelled as: a symlinked projects/ makes
    // the string comparison above miss it entirely, and the copy that follows
    // is copyFileSync onto its own source — which truncates the destination
    // before it reads, so the conversation is destroyed rather than carried.
    if (samePlaceOnDisk(srcDir, dstDir)) {
        return { ok: true, shared: true, reason: 'both accounts share one session store' }
    }

    const srcFile = join(srcDir, `${sessionId}.jsonl`)

    if (!existsSync(srcFile)) {
        return { ok: true, nothingToCarry: true, reason: 'the session has no transcript yet' }
    }

    try {
        mkdirSync(dstDir, { recursive: true })
        copyFileSync(srcFile, join(dstDir, `${sessionId}.jsonl`))
        const bytes = statSync(srcFile).size

        let subagents = false
        const srcSide = join(srcDir, sessionId)
        if (existsSync(srcSide)) {
            cpSync(srcSide, join(dstDir, sessionId), { recursive: true })
            subagents = existsSync(join(srcSide, 'subagents'))
        }

        logger.debug(
            `[flip] carried ${sessionId} (${bytes} bytes${subagents ? ', with subagents' : ''}) ${srcDir} -> ${dstDir}`,
        )
        return { ok: true, bytes, subagents }
    } catch (err) {
        return { ok: false, reason: `could not carry the transcript: ${String(err)}` }
    }
}

/**
 * Whether two paths are the same directory on disk. False when either does not
 * exist yet — an absent destination is a real destination to copy into, not a
 * share.
 */
function samePlaceOnDisk(a: string, b: string): boolean {
    try {
        return realpathSync(a) === realpathSync(b)
    } catch {
        return false
    }
}
