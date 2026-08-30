/**
 * Carry the phone's model and effort picks into the tmux pane (DROVE-45).
 *
 * Under one mode (DROVE-1) a session is a real Claude Code TUI in a pane. The
 * app's pickers write `modelMode` / `effortLevel` into session metadata, and
 * the ONLY thing that ever read those was the SDK path — it passes them to
 * query(). A pane has no query() to pass them to, so the pick was silently
 * ignored: Clay's composer said "Fable 5 · Ultracode" while /status in the pane
 * read `claude-opus-5[1m]`.
 *
 * The TUI does have a way in, and it is the one a human uses: `/model <name>`
 * and `/effort <level>`. Both are real commands in 2.1.251 — measured with
 * `strings`, not assumed:
 *
 *     Usage: /model <name>. Available: <aliases>, default, or a full model ID.
 *     Usage: /effort [low|medium|high|xhigh|max|ultracode|auto]
 *
 * and the app's own keys are already exactly what those take. The model keys
 * are full model IDs (`claude-opus-5`, `claude-opus-5[1m]`) because the short
 * aliases lie — see getClaudeModelModes in the app — and a full ID is listed as
 * accepted. The effort keys are the same words `/effort` prints. So the mapping
 * is the identity, and this file is mostly about WHEN, not WHAT.
 *
 * When matters because a pane is a keyboard. `/model x` typed mid-turn is not
 * queued, it is merged into whatever is in the input box and submitted with it.
 * So commands wait for the same idle gate a phone message waits for
 * (paneInject.paneIsIdle) and are retried until it opens, rather than pasted as
 * a draft the way a message is — a half-typed slash command sitting in Clay's
 * input box is worse than a late one.
 *
 * The carrier is deliberately generic over the command string so DROVE-36
 * (permission mode set in the app never reaching a terminal session) can hang
 * its own `/permissions`-shaped command off the same queue.
 *
 * DROVE-49 hangs a second rider off it: a slash command TYPED ON THE PHONE.
 * That one cannot go down the inbox socket at all — Claude Code's uds handler
 * sets `skipSlashCommands:true` on every message it takes off the socket
 * (2.1.251, `Ye`), so `/model opus` from the app arrived as literal text. The
 * pane is the only carrier that executes it, and this queue is the only place
 * that types into the pane on a gate rather than on hope.
 */

import { logger } from '@/ui/logger'

/** The subset of session metadata this file cares about. */
export interface PaneModelSelection {
    /** Full model ID, e.g. `claude-opus-5`. Explicit null means "reset". */
    modelMode?: string | null
    /** `low` | `medium` | `high` | `xhigh` | `max` | `ultracode`. Null resets. */
    effortLevel?: string | null
}

/**
 * What a reset is spelled as, per command. `/model` calls it `default` and
 * `/effort` calls it `auto`; there is no shared word, and sending the wrong one
 * gets `Invalid argument` rather than a reset.
 */
const resetArgument = { model: 'default', effort: 'auto' } as const

/**
 * A value safe to type at a live prompt. Model IDs carry dots, colons, slashes
 * and the `[1m]` bracket variant Claude Code accepts, so those are in; anything
 * that could end the line or start a second command is out. This is not
 * paranoia about the app — metadata is end-to-end encrypted and only Clay's own
 * clients write it — it is that the destination is a keyboard, and a newline
 * there submits half a command and runs the rest as a prompt.
 */
const safeArgument = /^[A-Za-z0-9._:/[\]-]+$/

function commandFor(
    kind: 'model' | 'effort',
    previous: string | null | undefined,
    next: string | null | undefined,
): string | null {
    // Absent is not a pick. `undefined` means the field was never set, or a
    // metadata write simply did not carry it; either way nothing was chosen and
    // retyping the last value at the prompt would be noise.
    if (next === undefined) return null
    if (previous === next) return null
    if (next === null) return `/${kind} ${resetArgument[kind]}`
    if (!safeArgument.test(next)) {
        logger.debug(`[paneModelSync] refusing to type ${kind} value that is not a plain argument`)
        return null
    }
    return `/${kind} ${next}`
}

/**
 * The slash commands that turn `previous` into `next`, in the order they must
 * be typed.
 *
 * Model first, deliberately: effort is capped by the model (`/effort ultracode`
 * is refused with "which <model> doesn't support" on a model that cannot reach
 * xhigh), so switching model first is what lets a paired change land. The other
 * order silently keeps the old effort.
 */
export function slashCommandsForSelection(
    previous: PaneModelSelection,
    next: PaneModelSelection,
): string[] {
    return [
        commandFor('model', previous.modelMode, next.modelMode),
        commandFor('effort', previous.effortLevel, next.effortLevel),
    ].filter((c): c is string => c !== null)
}

export interface PaneCommandQueueOptions {
    /** Is the pane sitting at an idle prompt right now? */
    isIdle: () => Promise<boolean>
    /** Type one command and press Enter. True when it actually went in. */
    send: (command: string) => Promise<boolean>
    /**
     * Are all of this session's agents accounted for (DROVE-48/DROVE-49)?
     *
     * An async subagent runs INSIDE the child while the main thread sits at an
     * idle prompt, and the terminal can be looking at that agent rather than at
     * the conversation. A keystroke aimed at the prompt would land on whatever
     * is on screen. So a command that came from the PHONE waits for the agents
     * to report in as well as for the prompt.
     *
     * Only asked for commands queued with `requireQuietAgents`. The app's model
     * and effort pickers do NOT set it: Clay runs 4–12 agents at a time and a
     * picker that goes dead for the length of that run is the DROVE-45
     * complaint back again.
     *
     * Defaults to "yes, quiet" so existing callers are unchanged.
     */
    agentsQuiet?: () => boolean
}

/** Per-request behaviour. Defaults match the model/effort picker. */
export interface PaneCommandRequestOptions {
    /**
     * Replace an earlier command of the same kind. Right for a picker — three
     * taps of the model menu should reach the prompt once, as the third pick.
     * Wrong for a command a person typed, where two `/clear`s mean two.
     */
    collapse?: boolean
    /** Also wait for `agentsQuiet()`. See PaneCommandQueueOptions. */
    requireQuietAgents?: boolean
}

export interface PaneCommandQueue {
    /** Queue commands for the next idle prompt. Later picks replace earlier ones. */
    request: (commands: string[], opts?: PaneCommandRequestOptions) => void
    /** Try to drain now. Safe to call concurrently; overlapping calls are one. */
    flush: () => Promise<void>
    /** What is still waiting, in order. For tests and logging. */
    pending: () => string[]
}

/**
 * The phone message that is really a TUI command, or null.
 *
 * Deliberately narrow, because getting this wrong sends ordinary prose to the
 * keyboard: one line only, and the token after the slash has to look like a
 * command name. `/Users/clayrisser/notes.md` fails on the second slash, which
 * is the case worth being careful about — Clay pastes paths from the phone.
 */
export function paneSlashCommand(message: string): string | null {
    const text = message.trim()
    if (text.includes('\n')) return null
    if (!/^\/[A-Za-z0-9][A-Za-z0-9_:-]*(\s|$)/.test(text)) return null
    return text
}

/** `/model claude-opus-5` -> `/model`. Two picks of the same kind collapse. */
function commandKind(command: string): string {
    const space = command.indexOf(' ')
    return space === -1 ? command : command.slice(0, space)
}

/**
 * A queue of slash commands waiting for the pane to be idle.
 *
 * Collapsing by kind is the point of it being a queue rather than a list: Clay
 * taps three models while a turn is running, and what should reach the prompt
 * is the third one, once, not a burst of three `/model` commands that leave the
 * TUI printing two rejections.
 *
 * Nothing here owns a timer. The launcher pokes `flush()` on the same signals
 * it already has (a metadata change, and the poll that watches for idle), which
 * keeps this file testable without fake timers.
 */
interface QueuedCommand {
    command: string
    /** May a later command of the same kind replace this one? */
    collapse: boolean
    /** Also wait for `agentsQuiet()` before typing it. */
    requireQuietAgents: boolean
}

export function createPaneCommandQueue(opts: PaneCommandQueueOptions): PaneCommandQueue {
    let queued: QueuedCommand[] = []
    let draining: Promise<void> | null = null
    const agentsQuiet = opts.agentsQuiet ?? (() => true)

    async function drain(): Promise<void> {
        if (queued.length === 0) return
        if (queued[0].requireQuietAgents && !agentsQuiet()) {
            logger.debug(`[paneModelSync] agents are still running — holding ${queued.length} command(s)`)
            return
        }
        if (!(await opts.isIdle())) {
            logger.debug(`[paneModelSync] pane is busy — holding ${queued.length} command(s)`)
            return
        }
        while (queued.length > 0) {
            const { command, requireQuietAgents } = queued[0]
            // Re-checked per command rather than once per drain: an agent can
            // launch between two commands of the same batch, and the point of
            // the flag is that THIS command never goes in while one is running.
            if (requireQuietAgents && !agentsQuiet()) {
                logger.debug(`[paneModelSync] agents started — holding ${command}`)
                return
            }
            let ok = false
            try {
                ok = await opts.send(command)
            } catch (e) {
                logger.debug('[paneModelSync] send threw:', e)
            }
            if (!ok) {
                // Stop at the first refusal rather than skipping ahead: model
                // has to precede effort, and typing effort into a pane that
                // just refused a model is how you get the wrong pair.
                logger.debug(`[paneModelSync] ${command} did not reach the pane — retrying later`)
                return
            }
            logger.debug(`[paneModelSync] typed ${command} into the pane`)
            queued.shift()
        }
    }

    return {
        request: (commands: string[], reqOpts: PaneCommandRequestOptions = {}) => {
            const collapse = reqOpts.collapse ?? true
            const requireQuietAgents = reqOpts.requireQuietAgents ?? false
            for (const command of commands) {
                const kind = commandKind(command)
                // Only ever drops a COLLAPSIBLE entry. A picker tap must not
                // swallow a `/model` Clay typed on the phone a second earlier.
                queued = queued.filter((q) => !(q.collapse && commandKind(q.command) === kind))
                queued.push({ command, collapse, requireQuietAgents })
            }
        },
        flush: async () => {
            // One drain at a time. Two overlapping drains would both read
            // queued[0] and type the same command twice.
            if (draining) return draining
            draining = drain().finally(() => { draining = null })
            return draining
        },
        pending: () => queued.map((q) => q.command),
    }
}
