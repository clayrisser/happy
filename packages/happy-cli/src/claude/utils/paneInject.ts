/**
 * Type a phone message straight into the local tmux pane (BASED-113).
 *
 * Happy's default is that the phone MIRRORS a local session and can only send
 * input by TAKING OVER — the message goes on the queue, local Claude is stopped,
 * and remote mode is spawned to serve it. For a session you are watching run in
 * tmux that is the wrong trade: it kills the terminal you were looking at and
 * hides whatever it was doing (subagents included) behind a fresh headless run.
 *
 * When the session IS a live Claude in a tmux pane, there is a better carrier:
 * the pane itself. `$TMUX_PANE` identifies it exactly — the same handle the flip
 * keys pass as `#{pane_id}` — so the message can be typed in as if you were at
 * the keyboard, no mode switch, no new session, and the work in flight stays on
 * screen. Remote mode remains the fallback for sessions with no pane
 * (daemon-spawned) and for a pane that is NOT currently running Claude.
 *
 * The Enter that submits it is the dangerous half. A pane is a keyboard, not a
 * queue: a paste that lands while Clay is half-way through typing merges with
 * his draft and the Enter fires the mixture, and a paste that lands on an open
 * permission dialog picks whatever option is highlighted. So Enter is gated —
 * `paneIsIdle` below — and when the gate does not pass the text is still
 * delivered, as a DRAFT sitting in the input box for whoever is at the
 * keyboard to read and send. Same rule the drover bus already follows
 * (engine/sender.js returns `submitted:false` for its tmux channel).
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

/**
 * Is the drover bus holding a question or a permission for this session?
 *
 * If it is, something on screen is WAITING for an answer — a gum popup, a
 * permission prompt — and a keystroke aimed at the conversation would land on
 * that dialog instead and pick whatever is highlighted.
 *
 * Any failure answers yes. A bus that is down, slow, or replying with an error
 * tells us nothing about what is on screen, and the cost of guessing wrong in
 * that direction is only a drafted message; guessing wrong the other way
 * approves a tool call nobody read.
 */
async function busHasPendingFor(busUrl: string, ids: Set<string>): Promise<boolean> {
    if (ids.size === 0) return false
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), busTimeoutMs)
    try {
        const res = await fetch(`${busUrl}/v1/events?state=pending`, { signal: ac.signal })
        if (!res.ok) return true
        const body = (await res.json()) as { events?: Array<{ origin?: { sessionId?: string | null } }> }
        return (body.events ?? []).some((e) => {
            const id = e?.origin?.sessionId
            return typeof id === 'string' && ids.has(id)
        })
    } catch (e) {
        logger.debug('[paneInject] bus did not answer — treating the pane as busy:', e)
        return true
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
    const ids = new Set([gate.claudeSessionId, gate.sessionId].filter((v): v is string => typeof v === 'string' && v.length > 0))
    if (await busHasPendingFor(gate.busUrl || defaultBusUrl(), ids)) {
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
export type PaneInterruptOutcome = 'cancelled' | 'idle' | 'unavailable'

/**
 * Cancel the active turn of the Claude running in `pane` without killing it —
 * one Escape keystroke, exactly what a person at the keyboard presses to stop
 * a turn (DROVE-13). The only other lever the launcher has is SIGTERM, which
 * takes the whole TUI down along with the scrollback, a half-typed line and
 * any open plan or permission prompt, so a phone Stop reaches for this first.
 *
 * Outcomes:
 *   'cancelled'   — Escape went in; the turn is stopping, the TUI stands.
 *   'idle'        — Claude's own registry says it is sitting at its prompt.
 *                   There is no turn to cancel, and Escape at an idle prompt
 *                   CLEARS whatever the human has half-typed, so nothing is
 *                   sent. The caller must not read this as "fall back to a kill".
 *   'unavailable' — the pane is gone, is back at a shell, or tmux refused.
 *
 * An UNKNOWN registry status still gets the Escape: Stop is surfaced on the
 * phone exactly while a turn is running, so mid-turn is the overwhelmingly
 * likely state, and an older Claude with no registry record must still be
 * stoppable.
 *
 * One Escape, never two. A second one inside Claude Code's double-tap window
 * opens the rewind picker, which is a different button entirely.
 */
export async function interruptPane(gate: PaneGate): Promise<PaneInterruptOutcome> {
    if (!(await paneRunningClaude(gate.pane))) {
        logger.debug(`[paneInject] interrupt: ${gate.pane} is not running Claude`)
        return 'unavailable'
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

export interface PaneInjectResult {
    /** The text reached the pane. False means fall back to remote mode. */
    delivered: boolean
    /** Enter was pressed, so Claude is answering it. False = it sits as a draft. */
    submitted: boolean
}

/**
 * Type `text` into `pane`, and submit it unless told not to. Returns false —
 * caller should fall back to a remote switch — when the pane is gone or is not
 * currently running Claude.
 *
 * A paste BUFFER rather than `send-keys -l`: send-keys turns a newline into a
 * carriage return, which a TUI reads as submit, so a two-line message would
 * fire the first line as its own turn. paste-buffer sends the whole thing as
 * one bracketed paste (`-p`, honoured when the application asked for bracketed
 * paste, ignored otherwise), which Claude Code drops into the input box intact;
 * the single Enter that follows is what submits it.
 *
 * Still returns a plain boolean, so the existing callers keep compiling and
 * keep their `if (!delivered)` fallback. `injectIntoPaneGated` is the richer
 * entry point that also reports whether Enter was pressed.
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

/**
 * Deliver `text` to the pane, pressing Enter only when the gate says the pane
 * is idle. Anything less confident is a draft: the text is in the input box,
 * `submitted` is false, and the caller should tell the phone so — "drafted in
 * the terminal, press Enter there" — rather than pretend it was sent.
 */
export async function injectIntoPaneGated(gate: PaneGate, text: string): Promise<PaneInjectResult> {
    const submit = await paneIsIdle(gate)
    const delivered = await injectIntoPane(gate.pane, text, { submit })
    return { delivered, submitted: delivered && submit }
}
