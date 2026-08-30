/**
 * The drover permission policy, read from the ONE file that defines it
 * (BASED-140).
 *
 * A terminal session never sees a permission prompt because `bin/drover`
 * prepends `--dangerously-skip-permissions` on a session start
 * (cattle-drover `bin/drover:212-223`), which `resolveInitialClaudePermissionMode`
 * then turns into `bypassPermissions`. A DAEMON spawn went through none of
 * that, so a session started from the phone asked for permission on every
 * single tool call while the terminal beside it asked for nothing.
 *
 * The switch is `DROVER_SKIP_PERMISSIONS` and its default lives in
 * cattle-drover `etc/drover.env`. Hard-coding a second copy of that default
 * here is how the two halves drift, so the default is READ from that file and
 * only falls back to `1` when the checkout is not where we expect it. The
 * environment still wins, because that is the documented override and
 * `libexec/drover-daemon` sources the same file.
 *
 * What this does NOT change: the bus gates. The six `ask-*.sh` gates are
 * registered as `preToolUse` hooks (`~/.shotgun/hooks.json`), and Claude Code
 * runs PreToolUse hooks whatever the permission mode is — bypass skips the
 * PROMPT, not the hooks. So a destructive bash, a WhatsApp send or a signature
 * overlay still raises a card on the phone from a bypassing session.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { droverDir } from './hooks'

/** The default this falls back to when the drover checkout is unreadable. */
const fallbackDefault = '1'

/**
 * The `DROVER_SKIP_PERMISSIONS` default as written in `etc/drover.env`.
 *
 * The line there is `DROVER_SKIP_PERMISSIONS="${DROVER_SKIP_PERMISSIONS:-1}"`,
 * so both the `${VAR:-default}` form and a plain assignment are accepted. Last
 * assignment wins, matching how the shell would read the same file.
 */
export function readDroverEnvDefault(file: string): string | undefined {
    let text: string
    try {
        text = readFileSync(file, 'utf-8')
    } catch {
        return undefined
    }
    let found: string | undefined
    for (const line of text.split('\n')) {
        const assignment = /^[ \t]*(?:export[ \t]+)?DROVER_SKIP_PERMISSIONS=(.*)$/.exec(line)
        if (!assignment) continue
        const raw = assignment[1].trim().replace(/^(["'])(.*)\1$/, '$2')
        const expansion = /^\$\{DROVER_SKIP_PERMISSIONS:-(.*)\}$/.exec(raw)
        found = (expansion ? expansion[1] : raw).trim()
    }
    return found
}

/**
 * Should a daemon spawn carry the terminal's bypass?
 *
 * `1` is on, anything else is off — the same test `bin/drover:213` and
 * `libexec/drover-trust:103` apply, so all three agree by construction.
 */
export function droverSkipPermissions(
    env: NodeJS.ProcessEnv = process.env,
    droverRoot: string = droverDir(),
): boolean {
    const value = env.DROVER_SKIP_PERMISSIONS
        ?? readDroverEnvDefault(join(droverRoot, 'etc', 'drover.env'))
        ?? fallbackDefault
    return value === '1'
}
