/**
 * Registering the Cattle Drover producers with the sessions drover starts
 * (BASED-98).
 *
 * The adapters under `cattle-drover/adapters/` are what put a Claude Code
 * question, an idle notice, and the session's own lifecycle ONTO the bus. They
 * were written, tested and then never registered anywhere, so the bus sat idle
 * and "a question reaches the phone, the watch and tmux" was true only of the
 * gum popup that already posted for itself. Nothing produced the rest.
 *
 * They are registered HERE, into the per-session settings file drover already
 * writes and passes as `--settings`, rather than into Clay's own
 * `~/.shotgun/hooks.json`. Two reasons, and the second is the important one:
 *
 *   - a global registration fires for every `claude` on the machine, including
 *     ones drover is not driving, so a bus outage would be felt by sessions
 *     that never opted in;
 *   - the drover stack is supposed to be installable and removable as a unit.
 *     A hook that only exists while a drover session is running is removed by
 *     not running one.
 *
 * Where to look when a hook does not fire: the file is written per PID by
 * `generateHookSettingsFile` to `$HAPPY_HOME_DIR/tmp/hooks/session-hook-<pid>.json`
 * (`~/.happy/tmp/hooks/...` by default) and handed to Claude as `--settings`,
 * so nothing about this registration is visible in `~/.claude/settings.json` or
 * in `/hooks`. Match the file to the SESSION'S pid: cleanup misses a session
 * that did not exit cleanly, so the directory keeps files for dead pids. 9 of
 * the 10 present on 2026-08-29 were orphans, and reading the newest one is how
 * you end up debugging a config no running session is using.
 *
 * The generic PreToolUse permission gate is deliberately NOT here. It blocks
 * every tool call on a bus answer, which is right for a headless session with
 * no local surface and wrong for Clay's terminal, where the gum popup is
 * faster and already races the same event. It stays opt-in.
 *
 * Off switch: DROVER_HOOKS=0.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { logger } from '@/ui/logger'

export interface HookCommand {
    type: 'command'
    command: string
}

export interface HookMatcher {
    matcher: string
    hooks: HookCommand[]
}

export function droverDir(): string {
    return process.env.DROVER_DIR || join(homedir(), 'Projects', 'bitspur', 'cattle-drover')
}

function adapter(name: string): string | null {
    const path = join(droverDir(), 'adapters', name)
    return existsSync(path) ? path : null
}

/**
 * The producer hooks, keyed by Claude Code hook event.
 *
 * Empty when the drover checkout is not where we expect it, or when the
 * adapters are missing — a hook naming a script that does not exist makes
 * Claude Code complain on every single tool call, which is a far worse outcome
 * than not having the bus.
 */
export function droverHooks(): Record<string, HookMatcher[]> {
    if (process.env.DROVER_HOOKS === '0') return {}

    const question = adapter('claude-pretooluse.sh')
    const notification = adapter('claude-notification.sh')
    const lifecycle = adapter('claude-session.sh')
    if (!question && !notification && !lifecycle) {
        logger.debug(`[drover] no adapters under ${droverDir()}/adapters — bus producers not registered`)
        return {}
    }

    const hooks: Record<string, HookMatcher[]> = {}
    const add = (event: string, matcher: string, script: string) => {
        const entry: HookMatcher = { matcher, hooks: [{ type: 'command', command: `"${script}"` }] }
        hooks[event] = [...(hooks[event] ?? []), entry]
    }

    // Claude's own questions, fanned to every surface, first answer wins.
    if (question) add('PreToolUse', 'AskUserQuestion', question)
    // The idle ding: the session is waiting on a human.
    if (notification) add('Notification', 'idle_prompt|permission_prompt', notification)
    // Lifecycle, so `drover sessions` can see what is running and where. The
    // hook runs as a child of the session, so its TMUX_PANE is the session's
    // pane — an exact binding no other producer can supply.
    if (lifecycle) {
        for (const event of ['SessionStart', 'SessionEnd', 'Stop', 'SubagentStop']) {
            add(event, '*', lifecycle)
        }
    }
    return hooks
}

/**
 * Merge drover's producers into settings that already carry hooks.
 *
 * Appends per event rather than replacing: happy's own SessionStart forwarder
 * is how the CLI learns the claude session id, and losing it would break
 * resume, the flip's `--resume`, and every transcript the app renders.
 */
export function mergeHooks(
    base: Record<string, HookMatcher[]>,
    extra: Record<string, HookMatcher[]>,
): Record<string, HookMatcher[]> {
    const out: Record<string, HookMatcher[]> = { ...base }
    for (const [event, matchers] of Object.entries(extra)) {
        out[event] = [...(out[event] ?? []), ...matchers]
    }
    return out
}
