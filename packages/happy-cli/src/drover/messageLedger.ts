/**
 * Did a phone message actually reach the terminal? (DROVE-48)
 *
 * A pane session has exactly one carrier for message text now: Claude's own
 * inbox socket. The pane paste that used to catch a socket miss is gone,
 * because a bracketed paste lands on whatever has focus — with Clay inside a
 * background task's view that is the SUBAGENT, not the main thread, and the
 * message is answered by the wrong Claude with nothing anywhere saying so.
 *
 * Deleting a fallback means the failure it used to hide is now a real failure,
 * so it has to be counted somewhere durable. The lesson is the gates ledger's:
 * a debug line is thrown away and a count nobody keeps reads exactly like
 * healthy. `drover status` reads this file.
 *
 * Not the happy log, and deliberately not the console: `logger.info` writes to
 * stdout, and stdout in a pane session is the terminal Claude's TUI is drawing
 * on. Announcing an undelivered message by scribbling over the pane would be a
 * worse bug than the one being fixed. The phone is told directly (a session
 * event), the log file carries the trace, and this ledger is what survives a
 * restart and can be counted.
 *
 * Format matches `lib/drover-gate.sh`'s published.log — tab-separated
 * `<iso8601> <kind> <carrier> <verdict>` — so `drover status` reads both with
 * the same cut positions. A SEPARATE file, though: published.log answers "has a
 * prompt ever left this machine", status takes its `last event` line from the
 * tail of it, and mixing message rows in would make that line name a delivery.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Where the drover keeps state. `bin/drover` exports STATE_DIR for exactly
 * this reason — the hooks and the CLI have to agree on one directory or a
 * per-machine override moves half the stack — so read it the same way
 * `lib/drover-gate.sh` does rather than inventing a second default.
 */
export function droverStateDir(): string {
    const explicit = process.env.STATE_DIR
    if (explicit && explicit.length > 0) return explicit
    const xdg = process.env.XDG_STATE_HOME
    return join(xdg && xdg.length > 0 ? xdg : join(homedir(), '.local', 'state'), 'cattle-drover')
}

export function messageLedgerPath(): string {
    return join(droverStateDir(), 'messages.log')
}

/**
 * Why a message could not be handed to the Claude in the pane.
 *
 * Four causes, because they want different reactions: no socket at all means
 * the registry has no record for this session (an old Claude, or a stale
 * file after a flip); gone means the socket path is there with nobody behind
 * it; refused means it answered and the write did not complete; and a lookup
 * error means we could not even read the registry.
 */
export type UndeliveredReason =
    | 'no-inbox-socket'
    | 'inbox-socket-gone'
    | 'inbox-socket-refused'
    | 'inbox-lookup-failed'

/** What the phone is told, in Clay's terms rather than the carrier's. */
export function undeliveredExplanation(reason: UndeliveredReason): string {
    switch (reason) {
        case 'no-inbox-socket':
            return 'the Claude in that terminal announced no inbox socket'
        case 'inbox-socket-gone':
            return 'its inbox socket is registered but nothing is behind it'
        case 'inbox-socket-refused':
            return 'its inbox socket refused the write'
        case 'inbox-lookup-failed':
            return 'the session registry could not be read'
    }
}

/**
 * Append one line. Never throws: a ledger that cannot be written is a reason
 * to have no record, never a reason to lose the message on top of it.
 */
function note(verdict: string): void {
    try {
        const path = messageLedgerPath()
        mkdirSync(join(path, '..'), { recursive: true })
        appendFileSync(path, `${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}\tmessage\tinbox\t${verdict}\n`)
    } catch {
        // Nothing to do about it, and nothing worth breaking a delivery over.
    }
}

export function noteMessageDelivered(): void {
    note('delivered')
}

export function noteMessageUndelivered(reason: UndeliveredReason): void {
    note(`undelivered ${reason}`)
}
