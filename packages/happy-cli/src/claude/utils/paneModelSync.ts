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
 * When matters because a pane is a keyboard, and this file got WHEN wrong for
 * three months (DROVE-164). It used to wait for `paneInject.paneIsIdle`, on the
 * reasoning that a command typed mid-turn merges into the input box. Measured
 * on 2.1.251, that is not what happens: a `/effort` pasted while a turn is
 * streaming executes immediately, the turn carries on, and it does not even
 * raise the confirmation the same command raises at an idle prompt. What a
 * paste can actually ruin is a HALF-TYPED LINE and an OPEN DIALOG, neither of
 * which is the turn.
 *
 * Waiting for idle was not a cautious version of the right gate, it was a gate
 * that never opened. Clay's own log for 2026-08-31 has `/effort max` queued at
 * 05:40:59 and still held at 08:06, 4454 "pane is busy" lines later, because a
 * session that is being worked is never idle. So the picker's commands take
 * `paneInject.paneAcceptsCommand` instead — pane alive, no dialog, empty input
 * box — and a slash command Clay typed on the phone keeps the strict gate,
 * where `/clear` landing mid-turn is not something to be clever about.
 *
 * The carrier is deliberately generic over the command string, and DROVE-36
 * now hangs the permission-mode pick off the same queue. That one is NOT a
 * slash command — 2.1.251 has none, see panePermissionSync.ts — so it is
 * spelled `#permission-mode <mode>` and the launcher's `send` routes it to a
 * shift+tab cycle instead of the keyboard. The `#` is deliberate: a pseudo
 * command that fell through to the paste path would type a visible `#` line
 * rather than something that reads like a command Claude Code refused.
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
 * The argument of a `/model` or `/effort` we typed, as the metadata value it
 * stands for (DROVE-191).
 *
 * The pane answers a `/model` in DISPLAY names — "Set model to Sonnet 5" — and
 * everything downstream of it (the transcript scanner, resolvePaneModelKey in
 * the app, this file's own comparisons) speaks model IDs. Two vocabularies for
 * one field is how `paneModel` ended up holding "Sonnet 5 and saved as your
 * default for new sessions". So when the pane says it took the command, what
 * gets written down is the argument we gave it, not the words it answered in.
 *
 * `default` / `auto` are the reset spellings and mean "no pick", which is null.
 * A phone-typed `/model opus` (DROVE-49) rides the same path and writes the
 * alias, since that is genuinely what was asked for; the scanner replaces it
 * with the full id at the end of the turn.
 */
export function paneCommandArgument(command: string): string | null {
    const space = command.indexOf(' ')
    if (space === -1) return null
    const argument = command.slice(space + 1).trim()
    if (argument === '' || argument === 'default' || argument === 'auto') return null
    return argument
}

/**
 * What the app should be storing as its model REQUEST, given what the pane is
 * observed to be running and what it currently asks for (DROVE-191).
 *
 * The twin of `resolvePaneModelKey` in the app, which decides the same thing
 * for the pill, and it has to stay the twin: this is what the launcher mirrors
 * into `modelMode` so the app's stored pick stops drifting away from the pane.
 *
 * The bracket variant is the whole subtlety. `claude-opus-5[1m]` is a real
 * model id that Claude Code accepts, but the transcript reports it as plain
 * `claude-opus-5` — the bracket picks the 1M-context variant, not a different
 * model. Taking the pane literally there would rewrite the request to
 * `claude-opus-5` on the first observation, and the next metadata event would
 * see request and pane disagree and retype `/model` — forever. So a request
 * that is the pane's own model plus a bracket suffix is LEFT ALONE: it does not
 * contradict the pane, it says more than the pane can say.
 *
 * The cost, stated rather than assumed away: `/model claude-opus-5` typed at
 * the keyboard while the app holds `claude-opus-5[1m]` is indistinguishable
 * from the 1M variant and the app keeps showing [1M]. That is the same blind
 * spot the pill has had since DROVE-45, and it is the price of not retyping.
 */
export function paneModelAsRequest(
    observed: string | null,
    requested: string | null | undefined,
): string | null {
    if (observed !== null && requested && requested.startsWith(`${observed}[`) && requested.endsWith(']')) {
        return requested
    }
    return observed
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

/**
 * The app's Remote Control request, as a tri-state (DROVE-63).
 *
 * On the wire it is the string `on` / `off`, which is what the app's existing
 * per-session pick machinery carries (permissionMode, modelMode, effortLevel
 * are all `string | null`), so the button needed no new transport. Booleans are
 * accepted too because an older or newer client writing one is easy to be kind
 * about and impossible to misread. Anything else — including a cleared pick —
 * is "no request".
 */
export function parseRemoteControlRequest(value: unknown): boolean | null {
    if (value === true || value === 'on') return true
    if (value === false || value === 'off') return false
    return null
}

/**
 * Whether to type `/remote-control`, given what the pane is on and what the app
 * asked for (DROVE-63).
 *
 * `/remote-control` is a TOGGLE, not a setting, and that is the whole reason
 * this function exists rather than another `commandFor` line. Measured in
 * 2.1.251, both from the command table and from a live transcript:
 *
 *     name:"remote-control", aliases:["rc"],
 *     get description(){ return rc() ? "Disconnect Remote Control"
 *                                    : "Control this session from your phone…" },
 *     get argumentHint(){ return rc() ? void 0 : "[name]" }
 *
 * The description flips with the current state, the only argument it ever takes
 * is an optional NAME for the remote session, and there is no `on` / `off`
 * word to send. Clay ran it twice three seconds apart and the transcript reads
 * `Remote Control disconnected.` then a fresh `cse_…` bridge — one command, two
 * opposite outcomes.
 *
 * So the command is safe to send only when we know the current state and it is
 * not the one asked for. `observed === null` means nothing has been read yet,
 * and typing a toggle then is a coin flip that can silence the session the
 * button was meant to wake.
 */
export function remoteControlCommand(
    observed: boolean | null,
    desired: boolean | null | undefined,
): string | null {
    // Absent or reset is not a request. Unlike `/model`, there is no "default"
    // for a bridge — clearing the pick means "stop asking", not "turn it off".
    if (desired === undefined || desired === null) return null
    if (observed === null) return null
    if (observed === desired) return null
    return '/remote-control'
}

export interface PaneCommandQueueOptions {
    /** Is the pane sitting at an idle prompt right now? */
    isIdle: () => Promise<boolean>
    /**
     * The weaker gate a picker's command may use instead (DROVE-164): the pane
     * is alive, no dialog is up and the input box is empty, but a turn may well
     * be running. Absent, `allowWhileBusy` falls back to `isIdle` and nothing
     * changes.
     */
    accepts?: () => Promise<boolean>
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
    /**
     * Take the weaker `accepts` gate rather than waiting for idle (DROVE-164).
     *
     * Right for the model and effort pickers, whose commands Claude Code runs
     * mid-turn without so much as a confirmation. Wrong for a slash command
     * Clay typed on the phone, where `/clear` landing in the middle of a turn
     * is not something to be clever about.
     */
    allowWhileBusy?: boolean
}

export interface PaneCommandQueue {
    /** Queue commands for the next idle prompt. Later picks replace earlier ones. */
    request: (commands: string[], opts?: PaneCommandRequestOptions) => void
    /**
     * Drop anything of this kind that has not been typed yet (DROVE-63).
     *
     * Only a toggle needs this. `/model x` then `/model y` collapses to `y` and
     * sending the last one is always right, but Remote Control off-then-on
     * while the pane is busy leaves the state where it started, and a queued
     * `/remote-control` would then be the command that breaks it. The launcher
     * re-derives the need on every metadata write and cancels when it is gone.
     */
    cancel: (kind: string) => void
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
interface QueuedCommand {
    command: string
    /** May a later command of the same kind replace this one? */
    collapse: boolean
    /** Also wait for `agentsQuiet()` before typing it. */
    requireQuietAgents: boolean
    /** Take `accepts` rather than `isIdle`. */
    allowWhileBusy: boolean
}

export function createPaneCommandQueue(opts: PaneCommandQueueOptions): PaneCommandQueue {
    let queued: QueuedCommand[] = []
    let draining: Promise<void> | null = null
    const agentsQuiet = opts.agentsQuiet ?? (() => true)
    const accepts = opts.accepts ?? opts.isIdle

    /** The gate THIS command asked for. Re-read per command, not per drain. */
    function gateFor(q: QueuedCommand): Promise<boolean> {
        return q.allowWhileBusy ? accepts() : opts.isIdle()
    }

    async function drain(): Promise<void> {
        if (queued.length === 0) return
        if (queued[0].requireQuietAgents && !agentsQuiet()) {
            logger.debug(`[paneModelSync] agents are still running — holding ${queued.length} command(s)`)
            return
        }
        if (!(await gateFor(queued[0]))) {
            logger.debug(`[paneModelSync] pane will not take a command — holding ${queued.length}`)
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
            // Two commands in one batch can want different gates — the picker's
            // pair is `allowWhileBusy`, a phone-typed `/clear` behind it is not.
            if (!(await gateFor(queued[0]))) {
                logger.debug(`[paneModelSync] pane will not take ${command} — holding it`)
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
            const allowWhileBusy = reqOpts.allowWhileBusy ?? false
            for (const command of commands) {
                const kind = commandKind(command)
                // Only ever drops a COLLAPSIBLE entry. A picker tap must not
                // swallow a `/model` Clay typed on the phone a second earlier.
                queued = queued.filter((q) => !(q.collapse && commandKind(q.command) === kind))
                queued.push({ command, collapse, requireQuietAgents, allowWhileBusy })
            }
        },
        cancel: (kind: string) => {
            queued = queued.filter((q) => commandKind(q.command) !== kind)
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
