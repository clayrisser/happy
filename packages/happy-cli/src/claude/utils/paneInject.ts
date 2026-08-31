/**
 * KEYSTROKES for the Claude running in the local tmux pane (BASED-113).
 *
 * `$TMUX_PANE` identifies that pane exactly — the same handle the flip keys
 * pass as `#{pane_id}` — so this module can act on the pane as if someone were
 * at the keyboard: the Escape that cancels a turn from the phone (DROVE-13),
 * and the `/model` and `/effort` commands the phone's pickers send (DROVE-45).
 *
 * NOT phone message text. That used to come through here too, with a gated
 * Enter and a draft when the gate did not pass, and DROVE-48 deleted it: a
 * bracketed paste lands on WHATEVER HAS FOCUS, and the terminal drives
 * subagents now, so a message sent while Clay was inside a background task's
 * view was answered by that subagent instead of the main thread. Message text
 * goes through Claude's own inbox socket (utils/inboxSocket.ts), which queues
 * it inside Claude and serves it to the main conversation, or it is reported
 * to the phone as undelivered. There is no paste behind it — "if you have to
 * fall back then things aren't set up correctly in the first place".
 *
 * The Enter is still the dangerous half for what remains. A pane is a
 * keyboard, not a queue: a `/model` that lands while Clay is half-way through
 * typing merges with his draft and the Enter fires the mixture, and a
 * keystroke that lands on an open permission dialog picks whatever option is
 * highlighted. So `paneIsIdle` below gates it, and the caller HOLDS the
 * command until the prompt opens rather than sending it anyway.
 *
 * The Escape is gated on the same bus read now (DROVE-80), because it was the
 * one keystroke going in blind: Escape on an open permission dialog is DENY,
 * so Stop from the phone over a gate refused the tool call instead of stopping
 * the turn. It cannot hold the way a `/model` does — a human pressed Stop and
 * is owed an outcome — so `interruptPane` WITHDRAWS the gate on the bus and
 * types nothing at all.
 */

import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { ambientDataDir } from '@/drover/flip/accounts'
import { logger } from '@/ui/logger'

const run = promisify(execFile)

// Commands that mean the pane is NOT showing a Claude TUI right now, so typing
// into it would land at a shell prompt (or another tmux) rather than in the
// conversation. A parked drover session sits at exactly one of these. Matched
// against tmux's `pane_current_command`, which is the pane's foreground process.
const NOT_CLAUDE = new Set(['zsh', 'bash', 'sh', 'fish', 'tmux', 'ssh', 'login'])

/** Same default the flip controller and the drover bridge use. */
function defaultBusUrl(): string {
    return process.env.DROVER_URL || 'http://127.0.0.1:7970'
}

/** How long the bus gets to answer before the gate gives up on it. */
const busTimeoutMs = 2000

/**
 * Is `pane` a live tmux pane currently running Claude (and therefore safe to
 * type into)? Returns the pane's foreground command on success, or null when
 * the pane is gone or is sitting at a shell.
 */
async function paneRunningClaude(pane: string): Promise<string | null> {
    try {
        const { stdout } = await run('tmux', [
            'display-message', '-p', '-t', pane, '#{pane_current_command}',
        ])
        const cmd = stdout.trim()
        if (!cmd) return null
        return NOT_CLAUDE.has(cmd) ? null : cmd
    } catch {
        // No such pane, or no tmux server reachable from here.
        return null
    }
}

/**
 * One record out of `<CLAUDE_CONFIG_DIR>/sessions/`. Claude Code writes one per
 * live interactive process and keeps `status` current. Shape read off a running
 * session (2026-08-30, claude 2.1.250): pid, sessionId, cwd, tmux,
 * messagingSocketPath, status — plus fields this gate does not care about.
 */
interface ClaudeSessionRecord {
    pid?: number
    sessionId?: string
    cwd?: string
    tmux?: string
    messagingSocketPath?: string
    status?: string
}

/**
 * What Claude Code says it is doing right now, straight from its own registry.
 *
 * Null when there is no record for this session: a config dir with no
 * `sessions/` (an older Claude, or the dir was never written), a session id we
 * were never told, or a record that has aged out. Null is NOT idle — the gate
 * treats "I could not tell" the same as "busy".
 *
 * `pane` only breaks a tie: if two records claim the same session id (a resume
 * that outlived its parent), the one whose `tmux` handle ends in this pane is
 * the one on screen.
 */
async function registryStatus(
    configDir: string | null | undefined,
    claudeSessionId: string | null | undefined,
    pane: string,
): Promise<string | null> {
    if (!claudeSessionId) return null
    const root = configDir && configDir.trim().length > 0 ? configDir : ambientDataDir()
    const dir = join(root, 'sessions')
    let names: string[]
    try {
        names = await readdir(dir)
    } catch {
        return null
    }
    const matches: ClaudeSessionRecord[] = []
    for (const name of names) {
        if (!name.endsWith('.json')) continue
        try {
            const record = JSON.parse(await readFile(join(dir, name), 'utf8')) as ClaudeSessionRecord
            if (record?.sessionId === claudeSessionId) matches.push(record)
        } catch {
            // A half-written or hand-mangled record is not a reason to fail the
            // whole read — skip it and judge on the rest.
        }
    }
    if (matches.length === 0) return null
    const onThisPane = matches.find((r) => typeof r.tmux === 'string' && r.tmux.endsWith(pane))
    return (onThisPane ?? matches[0]).status ?? null
}

/** One prompt as `GET /v1/events?state=pending` lists it. */
interface PendingBusEvent {
    id?: string
    kind?: string
    origin?: { sessionId?: string | null }
}

/**
 * The kinds that are a DIALOG ON SCREEN holding the keyboard.
 *
 * The bus carries five, and only these two are being waited on by something
 * that will read the next keystroke as its answer. `todo`, `idle` and `expiry`
 * are notices: a to-do sits pending for days by design (DROVE-53), so treating
 * one as an open dialog would leave Stop with nothing it could do all day, and
 * withdrawing one would throw away a record nobody had acted on.
 */
const gateKinds = new Set(['permission', 'question'])

/**
 * What the drover bus is holding for this session right now.
 *
 * A pending event means something on screen is WAITING for an answer — a gum
 * popup, a permission prompt — and a keystroke aimed at the conversation would
 * land on that dialog instead and pick whatever is highlighted.
 *
 * `known:false` is the bus not saying: down, slow, or answering with an error.
 * That is not "nothing is pending", and the two callers must not read it as
 * one, so it is a third answer rather than an empty list.
 */
async function busPendingFor(
    busUrl: string,
    ids: Set<string>,
): Promise<{ known: boolean; events: PendingBusEvent[] }> {
    // Nothing to match against. No adapter in the tree raises a prompt without
    // stamping the session it came from, so an id-less session has no prompt of
    // its own on the bus to find.
    if (ids.size === 0) return { known: true, events: [] }
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), busTimeoutMs)
    try {
        const res = await fetch(`${busUrl}/v1/events?state=pending`, { signal: ac.signal })
        if (!res.ok) return { known: false, events: [] }
        const body = (await res.json()) as { events?: PendingBusEvent[] }
        const mine = (body.events ?? []).filter((e) => {
            const id = e?.origin?.sessionId
            return typeof id === 'string' && ids.has(id)
        })
        return { known: true, events: mine }
    } catch (e) {
        logger.debug('[paneInject] bus did not answer:', e)
        return { known: false, events: [] }
    } finally {
        clearTimeout(timer)
    }
}

/**
 * Is the drover bus holding a question or a permission for this session?
 *
 * Any failure answers yes. A bus that is down, slow, or replying with an error
 * tells us nothing about what is on screen, and the cost of guessing wrong in
 * that direction is only a drafted message; guessing wrong the other way
 * approves a tool call nobody read.
 */
async function busHasPendingFor(busUrl: string, ids: Set<string>): Promise<boolean> {
    const pending = await busPendingFor(busUrl, ids)
    return !pending.known || pending.events.length > 0
}

/**
 * Withdraw a prompt from every surface: `POST /v1/events/<id>/cancel`.
 *
 * A cancel, never a resolve. Stop is a human saying "stop", which is not an
 * answer to the question on screen, and picking one for him is the whole of
 * DROVE-80. Withdrawn, the producers take their no-answer arm — the popup in
 * adapters/claude-pretooluse.sh dismisses on `canceled` and Claude Code asks
 * again in its own dialog, lib/drover-gate.sh fails closed — and every other
 * surface drops the card.
 */
async function cancelOnBus(busUrl: string, id: string): Promise<boolean> {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), busTimeoutMs)
    try {
        const res = await fetch(`${busUrl}/v1/events/${id}/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ by: 'happy-stop' }),
            signal: ac.signal,
        })
        // 409 is the prompt having ended between the list and this POST —
        // another surface got there first, which is the outcome anyway.
        if (res.ok || res.status === 409) return true
        logger.debug(`[paneInject] bus refused to withdraw ${id}: ${res.status}`)
        return false
    } catch (e) {
        logger.debug(`[paneInject] withdrawing ${id} failed:`, e)
        return false
    } finally {
        clearTimeout(timer)
    }
}

/** Everything the idle gate needs to decide whether Enter is safe. */
export interface PaneGate {
    /** The tmux pane, `$TMUX_PANE`. */
    pane: string
    /**
     * CLAUDE_CONFIG_DIR this session runs under (a drover account dir, or empty
     * / absent for the ambient `~/.claude`).
     */
    configDir?: string | null
    /**
     * Claude Code's own session id. It keys the registry record AND is what the
     * bus adapters put in `origin.sessionId`, so it answers both checks.
     */
    claudeSessionId?: string | null
    /** Bus base URL. Defaults to `$DROVER_URL`, then loopback :7970. */
    busUrl?: string
    /**
     * A second id to match a pending bus event against, for events raised under
     * the drover's session id rather than Claude's. Optional; when absent only
     * `claudeSessionId` is matched.
     */
    sessionId?: string | null
}

/**
 * The ids a pending bus event may carry for this session: Claude's own, and
 * the drover's when the caller knows it. Both checks read the same set.
 */
function sessionIdsOf(gate: PaneGate): Set<string> {
    return new Set(
        [gate.claudeSessionId, gate.sessionId].filter(
            (v): v is string => typeof v === 'string' && v.length > 0,
        ),
    )
}

/**
 * Is it safe to press Enter in this pane right now?
 *
 * True only when ALL THREE hold:
 *   (a) Claude Code's own registry record for this session says `status:"idle"`
 *       — it is sitting at its prompt, not mid-turn;
 *   (b) the drover bus has no pending event for this session — no permission
 *       card or question is on screen waiting to eat the keystroke;
 *   (c) the pane's foreground process is still Claude, not a shell.
 *
 * Deliberately biased toward false. Every unknown — no registry record, a bus
 * that will not answer, a pane that moved — reads as "not idle", which costs a
 * drafted message. The other direction costs a submitted half-sentence or an
 * approved tool call.
 */
export async function paneIsIdle(gate: PaneGate): Promise<boolean> {
    const status = await registryStatus(gate.configDir, gate.claudeSessionId, gate.pane)
    if (status !== 'idle') {
        logger.debug(`[paneInject] gate: registry says ${status ?? 'nothing'} for ${gate.claudeSessionId ?? '(no session id)'} — not idle`)
        return false
    }
    if (await busHasPendingFor(gate.busUrl || defaultBusUrl(), sessionIdsOf(gate))) {
        logger.debug('[paneInject] gate: a bus event is pending for this session — not idle')
        return false
    }
    if (!(await paneRunningClaude(gate.pane))) {
        logger.debug(`[paneInject] gate: ${gate.pane} is not running Claude — not idle`)
        return false
    }
    return true
}

/** What an in-place interrupt attempt came to. */
export type PaneInterruptOutcome = 'cancelled' | 'gate-cancelled' | 'idle' | 'unavailable' | 'unknown'

/**
 * Cancel the active turn of the Claude running in `pane` without killing it —
 * one Escape keystroke, exactly what a person at the keyboard presses to stop
 * a turn (DROVE-13). The only other lever the launcher has is SIGTERM, which
 * takes the whole TUI down along with the scrollback, a half-typed line and
 * any open plan or permission prompt, so a phone Stop reaches for this first.
 *
 * THE BUS IS ASKED BEFORE THE KEYBOARD IS TOUCHED (DROVE-80). Escape is a
 * keystroke and a pane is a keyboard: with a permission dialog open — the gum
 * popup, or Claude Code's own — Escape ANSWERS it, and Escape on a permission
 * dialog is deny. So a Stop pressed while a gate was up did not stop the turn,
 * it refused the tool call, silently, and the session carried on having been
 * told no. `paneIsIdle` has always made this check for the Enter behind
 * `/model`; this makes the same one for Stop and pulls a different lever when
 * it fires — the gate is WITHDRAWN on the bus, so no surface is answered on
 * the human's behalf.
 *
 * Outcomes:
 *   'cancelled'      — Escape went in; the turn is stopping, the TUI stands.
 *   'gate-cancelled' — a prompt was open, so it was withdrawn through the bus
 *                      and NOTHING was typed. The producer takes its no-answer
 *                      arm and every other surface drops the card.
 *   'idle'           — Claude's own registry says it is sitting at its prompt.
 *                      There is no turn to cancel, and Escape at an idle prompt
 *                      CLEARS whatever the human has half-typed, so nothing is
 *                      sent. The caller must not read this as "fall back to a
 *                      kill".
 *   'unavailable'    — the pane is gone, is back at a shell, or tmux refused.
 *   'unknown'        — the bus could not say whether a prompt is open, or said
 *                      one is and then would not withdraw it. Nothing is typed
 *                      and nothing is guessed: a keystroke sent blind is the
 *                      defect above. The caller SAYS so on the phone; there is
 *                      no second path behind this one (DROVE-48).
 *
 * An UNKNOWN registry status still gets the Escape: Stop is surfaced on the
 * phone exactly while a turn is running, so mid-turn is the overwhelmingly
 * likely state, and an older Claude with no registry record must still be
 * stoppable. That is the registry, not the bus — the bus not answering is
 * `unknown` above, because the registry cannot see a dialog and the bus can.
 *
 * One Escape, never two. A second one inside Claude Code's double-tap window
 * opens the rewind picker, which is a different button entirely.
 */
export async function interruptPane(gate: PaneGate): Promise<PaneInterruptOutcome> {
    if (!(await paneRunningClaude(gate.pane))) {
        logger.debug(`[paneInject] interrupt: ${gate.pane} is not running Claude`)
        return 'unavailable'
    }
    const busUrl = gate.busUrl || defaultBusUrl()
    const pending = await busPendingFor(busUrl, sessionIdsOf(gate))
    if (!pending.known) {
        logger.debug('[paneInject] interrupt: the bus did not say whether a prompt is open — nothing sent')
        return 'unknown'
    }
    const gates = pending.events.filter((e) => gateKinds.has(String(e.kind)))
    if (gates.length > 0) {
        let withdrawn = 0
        for (const ev of gates) {
            if (typeof ev.id !== 'string' || ev.id.length === 0) continue
            if (await cancelOnBus(busUrl, ev.id)) withdrawn++
        }
        logger.debug(
            `[paneInject] interrupt: ${gates.length} prompt(s) open for this session, `
            + `withdrew ${withdrawn} through the bus — no keystroke sent`,
        )
        return withdrawn > 0 ? 'gate-cancelled' : 'unknown'
    }
    const status = await registryStatus(gate.configDir, gate.claudeSessionId, gate.pane)
    if (status === 'idle') {
        logger.debug('[paneInject] interrupt: registry says idle — no turn to cancel, no keystroke sent')
        return 'idle'
    }
    try {
        await run('tmux', ['send-keys', '-t', gate.pane, 'Escape'])
        logger.debug(`[paneInject] interrupt: sent Escape to ${gate.pane} (registry said ${status ?? 'nothing'})`)
        return 'cancelled'
    } catch (e) {
        logger.debug('[paneInject] interrupt failed:', e)
        return 'unavailable'
    }
}

export interface PaneInjectOptions {
    /**
     * Press Enter after the paste. Default true, which is the historical
     * behaviour and what the plain `injectIntoPane(pane, text)` call still
     * gets. Pass false to leave the text in the input box as a draft.
     */
    submit?: boolean
}

/**
 * Type `text` into `pane`, and submit it unless told not to.
 *
 * A paste BUFFER rather than `send-keys -l`: send-keys turns a newline into a
 * carriage return, which a TUI reads as submit, so a two-line message would
 * fire the first line as its own turn. paste-buffer sends the whole thing as
 * one bracketed paste (`-p`, honoured when the application asked for bracketed
 * paste, ignored otherwise), which Claude Code drops into the input box intact;
 * the single Enter that follows is what submits it.
 *
 * Returns false when the pane is gone or is not currently running Claude.
 * There is no second carrier behind it any more (DROVE-48): the one caller
 * left is the slash-command queue, which holds the command and retries when
 * the prompt opens.
 */
export async function injectIntoPane(pane: string, text: string, opts: PaneInjectOptions = {}): Promise<boolean> {
    const submit = opts.submit ?? true
    const cmd = await paneRunningClaude(pane)
    if (!cmd) {
        logger.debug(`[paneInject] ${pane} is not running Claude — declining to inject`)
        return false
    }
    try {
        // A named buffer so this never disturbs the user's own paste buffer,
        // and `-d` on paste removes it right after.
        const buf = 'happy-inject'
        await run('tmux', ['set-buffer', '-b', buf, '--', text])
        await run('tmux', ['paste-buffer', '-d', '-p', '-b', buf, '-t', pane])
        if (submit) {
            await run('tmux', ['send-keys', '-t', pane, 'Enter'])
        }
        logger.debug(`[paneInject] ${submit ? 'typed' : 'drafted'} ${text.length} char(s) into ${pane} (running ${cmd})`)
        return true
    } catch (e) {
        logger.debug('[paneInject] failed:', e)
        return false
    }
}
