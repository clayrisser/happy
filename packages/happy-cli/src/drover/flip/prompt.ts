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
}

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
    return renderFlipPrompt(template, ctx)
}
