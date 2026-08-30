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
 * The carrier is deliberately generic over the command string, and DROVE-36
 * now hangs the permission-mode pick off the same queue. That one is NOT a
 * slash command — 2.1.251 has none, see panePermissionSync.ts — so it is
 * spelled `#permission-mode <mode>` and the launcher's `send` routes it to a
 * shift+tab cycle instead of the keyboard. The `#` is deliberate: a pseudo
 * command that fell through to the paste path would type a visible `#` line
 * rather than something that reads like a command Claude Code refused.
 */

import { logger } from '@/ui/logger'

/** The subset of session metadata this file cares about. */
export interface PaneModelSelection {
    /** Full model ID, e.g. `claude-opus-5`. Explicit null means "reset". */
    modelMode?: string | null
    /** `low` | `medium` | `high` | `xhigh` | `max` | `ultracode`. Null resets. */
    effortLevel?: string | null
    /**
     * A Claude permission mode — `bypassPermissions`, `plan`, `acceptEdits`,
     * `auto`, `default` (DROVE-36). The app's own key is mapped to one of
     * those by mapToClaudeMode before it gets here, so `yolo` never appears.
     * Explicit null means "reset", which for a permission mode is `default`.
     */
    permissionMode?: string | null
}

/**
 * What a reset is spelled as, per command. `/model` calls it `default` and
 * `/effort` calls it `auto`; there is no shared word, and sending the wrong one
 * gets `Invalid argument` rather than a reset.
 */
const resetArgument = { model: 'default', effort: 'auto', 'permission-mode': 'default' } as const

/**
 * A value safe to type at a live prompt. Model IDs carry dots, colons, slashes
 * and the `[1m]` bracket variant Claude Code accepts, so those are in; anything
 * that could end the line or start a second command is out. This is not
 * paranoia about the app — metadata is end-to-end encrypted and only Clay's own
 * clients write it — it is that the destination is a keyboard, and a newline
 * there submits half a command and runs the rest as a prompt.
 */
const safeArgument = /^[A-Za-z0-9._:/[\]-]+$/

/**
 * `/` for the two real slash commands, `#` for the permission-mode pseudo
 * command the launcher has to interpret itself. See the file header.
 */
const commandSigil = { model: '/', effort: '/', 'permission-mode': '#' } as const

function commandFor(
    kind: 'model' | 'effort' | 'permission-mode',
    previous: string | null | undefined,
    next: string | null | undefined,
): string | null {
    // Absent is not a pick. `undefined` means the field was never set, or a
    // metadata write simply did not carry it; either way nothing was chosen and
    // retyping the last value at the prompt would be noise.
    if (next === undefined) return null
    if (previous === next) return null
    if (next === null) return `${commandSigil[kind]}${kind} ${resetArgument[kind]}`
    if (!safeArgument.test(next)) {
        logger.debug(`[paneModelSync] refusing to type ${kind} value that is not a plain argument`)
        return null
    }
    return `${commandSigil[kind]}${kind} ${next}`
}

/**
 * The pane commands that turn `previous` into `next`, in the order they must
 * be carried out.
 *
 * Not all of them are slash commands any more — hence the rename from
 * slashCommandsForSelection when DROVE-36 joined. See the file header.
 *
 * Model first, deliberately: effort is capped by the model (`/effort ultracode`
 * is refused with "which <model> doesn't support" on a model that cannot reach
 * xhigh), so switching model first is what lets a paired change land. The other
 * order silently keeps the old effort.
 */
export function paneCommandsForSelection(
    previous: PaneModelSelection,
    next: PaneModelSelection,
): string[] {
    return [
        // Permission mode first, and not for the reason model precedes effort.
        // Its carrier is a shift+tab loop that READS THE PANE BACK after every
        // press (panePermissionSync.ts), so it needs the prompt to look the way
        // it found it. `/model` can open a one-time consent dialog, and a
        // shift+tab aimed at that dialog is a keystroke landing on whatever is
        // highlighted — exactly the failure the idle gate exists to prevent.
        commandFor('permission-mode', previous.permissionMode, next.permissionMode),
        commandFor('model', previous.modelMode, next.modelMode),
        commandFor('effort', previous.effortLevel, next.effortLevel),
    ].filter((c): c is string => c !== null)
}

export interface PaneCommandQueueOptions {
    /** Is the pane sitting at an idle prompt right now? */
    isIdle: () => Promise<boolean>
    /** Type one command and press Enter. True when it actually went in. */
    send: (command: string) => Promise<boolean>
}

export interface PaneCommandQueue {
    /** Queue commands for the next idle prompt. Later picks replace earlier ones. */
    request: (commands: string[]) => void
    /** Try to drain now. Safe to call concurrently; overlapping calls are one. */
    flush: () => Promise<void>
    /** What is still waiting, in order. For tests and logging. */
    pending: () => string[]
}

/**
 * `/model claude-opus-5` -> `/model`, `#permission-mode plan` ->
 * `#permission-mode`. Two picks of the same kind collapse.
 */
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
export function createPaneCommandQueue(opts: PaneCommandQueueOptions): PaneCommandQueue {
    let queued: string[] = []
    let draining: Promise<void> | null = null

    async function drain(): Promise<void> {
        if (queued.length === 0) return
        if (!(await opts.isIdle())) {
            logger.debug(`[paneModelSync] pane is busy — holding ${queued.length} command(s)`)
            return
        }
        while (queued.length > 0) {
            const command = queued[0]
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
        request: (commands: string[]) => {
            for (const command of commands) {
                const kind = commandKind(command)
                queued = queued.filter((q) => commandKind(q) !== kind)
                queued.push(command)
            }
        },
        flush: async () => {
            // One drain at a time. Two overlapping drains would both read
            // queued[0] and type the same command twice.
            if (draining) return draining
            draining = drain().finally(() => { draining = null })
            return draining
        },
        pending: () => [...queued],
    }
}
