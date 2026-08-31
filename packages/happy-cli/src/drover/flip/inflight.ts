/**
 * Who is still running inside the claude child (BASED-135).
 *
 * A local↔remote mode switch and a flip both stop the child with
 * `AbortController.abort()`, which is a SIGTERM. Claude Code handles it, exits
 * 143 within 728–1796ms, and takes every async subagent down with it, because
 * subagents live INSIDE that process. Clay routinely runs 4–12 at once, and he
 * lost work to this repeatedly.
 *
 * The loss is quieter than it sounds, which is why it went unnoticed for so
 * long. The parent transcript is NOT left with a dangling tool_use: an async
 * Agent call gets its tool_result in ~19ms ("Async agent launched successfully
 * … agentId: <id>"), measured at 3843 tool_use / 3843 tool_result with zero
 * dangling. So `--resume` is API-valid and the conversation reads perfectly.
 * What is gone is the COMPLETION notification, which arrives later as a
 * separate record holding a <task-notification> block. Kill the child in
 * between and the resumed session reads as though every agent launched fine
 * and then never reported. No error, no marker, no way to tell.
 *
 * So this counts the gap: one entry per launched agent, dropped the moment a
 * terminal notification for it appears. The gates in claudeLocalLauncher and
 * FlipController ask before they abort.
 *
 * TWO SOURCES, and the second one is not optional
 * -----------------------------------------------
 * Launches arrive through the scanner's onMessage, which is free — the
 * launcher already hands every transcript record to the flip controller.
 *
 * Completions mostly do not. Claude Code writes a task-notification three
 * ways, and `sessionScanner` forwards exactly one of them:
 *
 *   queue-operation   the enqueue record. Listed in the scanner's
 *                     INTERNAL_CLAUDE_EVENT_TYPES and skipped outright.
 *   attachment        a `queued_command` injected mid-turn. Not a member of
 *                     RawJSONLinesSchema's union, so safeParse drops it.
 *   user              the notification delivered as its own turn. Forwarded.
 *
 * Counted across every transcript on this machine — 1084 launched agents —
 * 771 got a `user` record and 313 did not. Relying on onMessage alone would
 * therefore leave ~29% of agents "in flight" forever, and a stuck count means
 * every switch and every flip is refused for the rest of the session. So the
 * tracker also tails the transcript file itself, incrementally, from a byte
 * offset seeded at the first launch. That read is strictly cheaper than the
 * scanner's own poll, which re-reads the whole file every time.
 *
 * Deliberately conservative in one direction: an entry we cannot resolve keeps
 * counting. Over-counting costs a deferred switch or one extra keypress on a
 * flip. Under-counting costs Clay eight agents.
 */

import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

import { parseAgentNotifications, readAsyncAgentLaunch } from '@/claude/utils/agentNotification'
import { logger } from '@/ui/logger'

export interface InFlightAgent {
    /** Claude Code's internal agent id, e.g. `a752a2a9e89efbca8`. */
    id: string
    /** The Task's own description, when the launch record carried one. */
    name?: string
    /** `tasks/<id>.output` — a symlink to the subagent's own transcript. */
    output?: string
    /** When the launch was first seen, epoch ms. */
    at: number
}

export interface InFlightSnapshot {
    count: number
    ids: string[]
    /** Descriptions where we have them, ids where we do not. */
    names: string[]
    agents: InFlightAgent[]
}

export const emptyInFlight: InFlightSnapshot = { count: 0, ids: [], names: [], agents: [] }

/**
 * What a launch and a notification look like lives in
 * `@/claude/utils/agentNotification` (DROVE-115), so the flip gate and the
 * terminal `tool-call-end` the phone's Agent card keys off cannot disagree
 * about which agents are still running.
 */

export interface InFlightTrackerOptions {
    /**
     * Where the parent transcript is RIGHT NOW, or null when it is not known
     * yet. A function, not a path: the session id arrives from a hook well
     * after this is built, and a flip moves the whole file into another
     * account's config dir mid-run.
     */
    transcript?: () => string | null | undefined
    /** How often the tail is read while records are streaming in. */
    drainEveryMs?: number
    /** Ceiling on one tail read, so falling behind cannot mean a 190 MB read. */
    maxReadBytes?: number
    /**
     * Fired the moment the last agent reports in, so a switch that was held
     * back can go ahead the instant it is free rather than waiting for the
     * child to exit. Never fired by reset().
     */
    onIdle?: () => void
}

export class InFlightTracker {
    private readonly live = new Map<string, InFlightAgent>()
    /**
     * Agents whose completion we saw BEFORE their launch.
     *
     * Not hypothetical: the tail reads the file directly while the scanner
     * polls it on a timer, so the tail can be ahead. Without this an agent
     * that finished quickly would be registered by the late launch record and
     * never cleared.
     */
    private readonly finished = new Set<string>()

    private readonly transcript: (() => string | null | undefined) | null
    private readonly drainEveryMs: number
    private readonly maxReadBytes: number
    private readonly onIdle: (() => void) | null
    /** Whether anything was in flight last time we looked, for the edge. */
    private wasBusy = false

    private path: string | null = null
    private offset = 0
    private seeded = false
    /** Bytes of a line the last read cut in half. A Buffer, so a split UTF-8 sequence survives. */
    private carry: Buffer = Buffer.alloc(0)
    private lastDrain = 0
    private draining = false

    constructor(opts: InFlightTrackerOptions = {}) {
        this.transcript = opts.transcript ?? null
        this.drainEveryMs = opts.drainEveryMs ?? 1000
        this.maxReadBytes = opts.maxReadBytes ?? 4 * 1024 * 1024
        this.onIdle = opts.onIdle ?? null
    }

    /**
     * Offer one transcript record. Cheap enough to call per message, and it
     * must never throw: it runs inside the scanner's own callback.
     */
    note(record: unknown): void {
        try {
            this.consume(record)
        } catch (err) {
            logger.debug('[inflight] unreadable transcript record', err)
        }
        if (!this.draining) this.drain(false)
        this.settle()
    }

    /** How many agents are still unaccounted for. */
    count(): number {
        // Forced: the gate is asked rarely, and the answer decides whether
        // Clay loses work. Paying for one read here is the cheapest thing in
        // the whole path.
        this.drain(true)
        this.settle()
        return this.live.size
    }

    ids(): string[] {
        this.drain(true)
        return [...this.live.keys()]
    }

    names(): string[] {
        this.drain(true)
        return [...this.live.values()].map((a) => a.name ?? a.id)
    }

    snapshot(): InFlightSnapshot {
        this.drain(true)
        this.settle()
        const agents = [...this.live.values()]
        return {
            count: agents.length,
            ids: agents.map((a) => a.id),
            names: agents.map((a) => a.name ?? a.id),
            agents,
        }
    }

    /**
     * Forget everything. Called as each child is launched, so a stale entry
     * from the previous child cannot jam the gate for the rest of the session.
     */
    reset(): void {
        this.live.clear()
        this.finished.clear()
        this.path = null
        this.offset = 0
        this.seeded = false
        this.carry = Buffer.alloc(0)
        this.lastDrain = 0
        // Deliberately silent: reset runs as the NEXT child is launched, and
        // an onIdle there would abort the child we just started.
        this.wasBusy = false
    }

    /**
     * Fire onIdle on the busy -> idle edge, once.
     *
     * On the edge rather than on every empty look, because the callback stops
     * a child process and doing that twice is not free.
     */
    private settle(): void {
        if (this.live.size > 0) {
            this.wasBusy = true
            return
        }
        if (!this.wasBusy) return
        this.wasBusy = false
        if (!this.onIdle) return
        try {
            this.onIdle()
        } catch (err) {
            logger.debug('[inflight] onIdle threw', err)
        }
    }

    // --- reading ------------------------------------------------------------

    private consume(record: unknown): void {
        // Completions first. A notification can only be about an agent that
        // launched earlier, so nothing is lost by clearing before adding, and
        // one record carrying both is not a shape that exists.
        for (const notification of parseAgentNotifications(record)) {
            if (!notification.terminal) continue
            if (this.live.delete(notification.agentId)) {
                logger.debug(`[inflight] ${notification.agentId} reported ${notification.status}; ${this.live.size} still running`)
            } else {
                this.finished.add(notification.agentId)
            }
        }

        this.noteLaunch(record)
    }

    private noteLaunch(record: unknown): void {
        const launch = readAsyncAgentLaunch(record)
        if (!launch) return
        if (this.finished.delete(launch.agentId)) {
            logger.debug(`[inflight] ${launch.agentId} had already reported before its launch was seen`)
            return
        }
        if (this.live.has(launch.agentId)) return
        this.live.set(launch.agentId, {
            id: launch.agentId,
            ...(launch.description ? { name: launch.description } : {}),
            ...(launch.outputFile ? { output: launch.outputFile } : {}),
            at: Date.now(),
        })
        this.seed()
        logger.debug(`[inflight] ${launch.agentId} launched; ${this.live.size} running`)
    }

    /**
     * Remember where the transcript ends at the moment the FIRST agent starts.
     *
     * Everything already in the file is history — the launch record we just
     * read included, since the scanner only hands it over once it is written —
     * and the completion we are waiting for is written after this point. So a
     * tail from here sees every notification that matters and re-reads none of
     * a transcript that can be 190 MB.
     */
    private seed(): void {
        if (this.seeded || !this.transcript) return
        const path = this.transcriptPath()
        if (!path) return
        const size = this.sizeOf(path)
        if (size === null) return
        this.path = path
        this.offset = size
        this.seeded = true
    }

    private transcriptPath(): string | null {
        try {
            return this.transcript?.() || null
        } catch (err) {
            logger.debug('[inflight] could not resolve the transcript path', err)
            return null
        }
    }

    private sizeOf(path: string): number | null {
        let fd: number | null = null
        try {
            fd = openSync(path, 'r')
            return fstatSync(fd).size
        } catch {
            return null
        } finally {
            if (fd !== null) {
                try {
                    closeSync(fd)
                } catch {
                    /* nothing useful to do */
                }
            }
        }
    }

    /**
     * Read whatever the transcript has grown by and process it.
     *
     * Only ever called with something in flight, so an idle session pays
     * nothing at all.
     */
    private drain(force: boolean): void {
        if (this.draining) return
        if (this.live.size === 0) return
        if (!this.transcript) return
        const now = Date.now()
        if (!force && now - this.lastDrain < this.drainEveryMs) return
        this.lastDrain = now

        const path = this.transcriptPath()
        if (!path) return
        if (path !== this.path) {
            // A flip copies the transcript byte for byte into the target
            // account, so the offset still points at the same record in the
            // new file. Only the partial line is dropped, because the copy may
            // have landed mid-write.
            logger.debug(`[inflight] transcript moved: ${this.path ?? '(none)'} -> ${path}`)
            this.path = path
            this.carry = Buffer.alloc(0)
        }
        if (!this.seeded) {
            const size = this.sizeOf(path)
            if (size === null) return
            this.offset = size
            this.seeded = true
            return
        }

        this.draining = true
        let fd: number | null = null
        try {
            fd = openSync(path, 'r')
            const size = fstatSync(fd).size
            let from = this.offset
            if (size < from) {
                // Truncated, or a shorter file under the same name. Start from
                // a bounded tail rather than the top.
                from = Math.max(0, size - this.maxReadBytes)
                this.carry = Buffer.alloc(0)
            }
            if (size - from > this.maxReadBytes) {
                // Fell far behind. Skipping forward can only lose completions,
                // which leaves the count too HIGH — the safe direction.
                logger.debug(`[inflight] transcript grew ${size - from}B since the last read; skipping ahead`)
                from = size - this.maxReadBytes
                this.carry = Buffer.alloc(0)
            }
            const length = size - from
            if (length <= 0) {
                this.offset = size
                return
            }
            const buf = Buffer.allocUnsafe(length)
            const read = readSync(fd, buf, 0, length, from)
            this.offset = from + read

            const chunk = Buffer.concat([this.carry, buf.subarray(0, read)])
            const cut = chunk.lastIndexOf(0x0a)
            if (cut === -1) {
                // One line longer than a whole read. Hold it, unless it has
                // grown past anything a record could plausibly be.
                this.carry = chunk.length > this.maxReadBytes ? Buffer.alloc(0) : chunk
                return
            }
            this.carry = chunk.subarray(cut + 1)
            for (const line of chunk.subarray(0, cut).toString('utf8').split('\n')) {
                if (!line.trim()) continue
                let record: unknown
                try {
                    record = JSON.parse(line)
                } catch {
                    continue
                }
                try {
                    this.consume(record)
                } catch (err) {
                    logger.debug('[inflight] unreadable tailed record', err)
                }
            }
        } catch (err) {
            logger.debug('[inflight] could not tail the transcript', err)
        } finally {
            this.draining = false
            if (fd !== null) {
                try {
                    closeSync(fd)
                } catch {
                    /* nothing useful to do */
                }
            }
        }
    }
}

/**
 * "4 subagents still running (raft animation, a752a2a9e89efbca8, …)".
 *
 * Descriptions first, ids only where there is no description: the launch
 * banner asks that agent ids stay out of user-facing replies, and a
 * description is the more useful thing to read anyway.
 */
export function describeInFlight(snapshot: InFlightSnapshot, limit = 6): string {
    const n = snapshot.count
    if (n === 0) return 'nothing still running'
    const shown = snapshot.names.slice(0, limit)
    const rest = n - shown.length
    const list = shown.join(', ') + (rest > 0 ? `, +${rest} more` : '')
    return `${n} subagent${n === 1 ? '' : 's'} still running (${list})`
}
