/**
 * What a flipped session is told on arrival (BASED-98).
 *
 * A resumed session is silent: `claude --resume <id>` restores the
 * conversation and then waits. Something has to say "carry on", and what to
 * say is a matter of taste that changes per project, so it is configurable at
 * three scopes, most specific first:
 *
 *   session — this run only, set by the flip request itself (`--prompt`, the
 *             app's `/flip <text>`, or the bus frame's `prompt` field)
 *   account — `flipPrompt` on the account's entry in accounts.json
 *   global  — DROVER_FLIP_PROMPT, or flip-prompt.txt in the drover state dir
 *
 * and a built-in default underneath, which is Clay's wording.
 */

import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { logger } from '@/ui/logger'
import { droverStateDir, type DroverAccount } from './accounts'
import { buildHandover, handoverNote, type HandoverEntry, type StrandedAgent } from './handover'
import { restoreNote, type RestorePlan } from './restore'

export type { StrandedAgent }

export const defaultFlipPrompt =
    'Pick up where we left off, including all subagents; max parallel subagents'

export interface FlipPromptContext {
    /** Account being left. */
    from?: string
    /** Account being joined. */
    to: string
    /** Why the flip happened: "manual", "usage limit", … */
    reason: string
    cwd: string
    /** Claude session id being resumed. */
    session?: string | null
    /** Session-scoped override, highest precedence. */
    override?: string | null
    /** The target account's entry, for its own override. */
    account?: DroverAccount
    /**
     * Subagents that were still running when the child was stopped
     * (BASED-135). Their completion notifications are gone, but their partial
     * work is not, and DROVE-240 turns that into a handover: what each one was
     * doing, where its transcript is, and whether it had already pushed.
     */
    stranded?: StrandedAgent[]
    /** The account being joined, so a transcript is found where it now lives. */
    configDir?: string
    /** The account being left, read when the carried copy is not there yet. */
    fromConfigDir?: string
    /**
     * What the session was set to and what it is coming up on (DROVE-272).
     * Says something only when those two differ -- the account being joined
     * cannot run the model Clay picked -- because a restore that put back
     * exactly what he chose is not news.
     */
    restore?: RestorePlan
}

/**
 * Where the work of a killed subagent actually is, and what to do about it.
 *
 * The default prompt asks the resumed Claude to pick up "including all
 * subagents", which without this reads as an instruction to launch them all
 * again from zero -- and it did, repeatedly, throwing away however long they
 * had already run.
 *
 * DROVE-240 moved the rendering into `handover.ts` and made it say what it
 * really is. A session resumes; a subagent cannot, so what happens here is a
 * RE-DISPATCH onto the same jobs, each new agent pointed at the transcript its
 * predecessor left behind. The full reasoning is in that file's header. The
 * one rule to keep in mind while editing anything below: nothing user-facing
 * may call this resuming.
 */

function globalPrompt(): string | undefined {
    const env = process.env.DROVER_FLIP_PROMPT
    if (env && env.trim()) return env.trim()
    try {
        const file = join(droverStateDir(), 'flip-prompt.txt')
        if (existsSync(file)) {
            const text = readFileSync(file, 'utf8').trim()
            if (text) return text
        }
    } catch (err) {
        logger.debug('[flip] unreadable global flip prompt', err)
    }
    return undefined
}

/**
 * Substitute {vars}. An unknown name is left alone rather than blanked — a
 * prompt that mentions {foo} in prose should survive, and silently deleting
 * part of an instruction is worse than printing a brace.
 */
export function renderFlipPrompt(template: string, ctx: FlipPromptContext): string {
    const vars: Record<string, string> = {
        from: ctx.from ?? 'unknown',
        to: ctx.to,
        account: ctx.to,
        reason: ctx.reason,
        cwd: ctx.cwd,
        project: basename(ctx.cwd),
        session: ctx.session ?? '',
    }
    return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
        name in vars ? vars[name] : whole,
    )
}

export function resolveFlipPrompt(ctx: FlipPromptContext): string {
    const template =
        (ctx.override && ctx.override.trim()) ||
        (ctx.account?.flipPrompt && ctx.account.flipPrompt.trim()) ||
        globalPrompt() ||
        defaultFlipPrompt
    const rendered = renderFlipPrompt(template, ctx)
    // Appended rather than substituted, so it survives every override: a
    // per-account or per-session prompt that never heard of subagents still
    // gets told where the stranded ones left their work.
    //
    // The restore goes FIRST and the handover second. The restore is one
    // sentence about the session it is arriving as; the handover can be a
    // hundred lines about other agents' work, and a substituted model buried
    // under that is a substitution nobody read.
    const swap = restoreNote(ctx.restore, ctx.to)
    const note = handoverFor(ctx)
    return rendered + (swap ?? '') + (note ?? '')
}

/**
 * The handover block, built and written on the way past.
 *
 * Kept here rather than at the call site so it cannot be skipped: every flip
 * resolves its arrival prompt, so every flip that stranded anything writes its
 * handover file. That includes the flips nobody asked for -- a usage limit, an
 * auto-downgrade -- which are precisely the ones where no one is watching the
 * terminal and the file on disk is the only record left.
 */
function handoverFor(ctx: FlipPromptContext): string | null {
    if (!ctx.stranded || ctx.stranded.length === 0) return null
    try {
        const entries: HandoverEntry[] = buildHandover(ctx.stranded, {
            cwd: ctx.cwd,
            session: ctx.session,
            ...(ctx.configDir ? { configDir: ctx.configDir } : {}),
            ...(ctx.fromConfigDir ? { fromConfigDir: ctx.fromConfigDir } : {}),
        })
        return handoverNote(entries, ctx.session)
    } catch (err) {
        // A flip that lands without its handover is bad. A flip that does not
        // land at all is worse.
        logger.debug('[flip] could not build the subagent handover', err)
        return null
    }
}
