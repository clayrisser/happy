/**
 * Clone lineage, carried to the app on the session (DROVE-58).
 *
 * A flip moves a session between ACCOUNTS and the transcript comes with it —
 * one session, one id, one row in the app. A CLONE is the other thing: no
 * harness but Claude Code can read a Claude Code transcript, so cloning a
 * session into OpenCode or Cursor cannot carry anything. It starts a NEW
 * session seeded with a summary of the old one, and the two are separate
 * sessions for good.
 *
 * Which means the app has two rows and neither one can say on its own what it
 * is. This is what tells them apart: the clone shows "cloned from …" and the
 * source shows "cloned into …", both read from the SAME file — the ledger
 * `drover clone` writes at `$XDG_STATE_HOME/cattle-drover/clones.json`.
 *
 * ONE source of truth, deliberately. Stamping the two halves separately is two
 * writes that can disagree, and the pair that disagrees is the pair where the
 * clone knows its parent and the parent has forgotten it.
 *
 * The row is OPEN when `drover clone` writes it — the clone's own session id
 * does not exist until Claude Code allocates one inside a window that has not
 * been opened yet. The bus closes it from the clone's first SessionStart hook.
 * So this reporter POLLS rather than reading once at startup: the row naming
 * this session may be closed seconds after the session begins, and a snapshot
 * taken at start would never learn about it. Same shape as UsageReporter
 * (DROVE-47), for the same reason.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { logger } from '@/ui/logger'
import { droverStateDir } from './accounts'

export function cloneLedgerPath(): string {
    return join(droverStateDir(), 'clones.json')
}

/** One row of the ledger, as `libexec/drover-clone` writes it. */
export interface CloneRow {
    id: string
    at?: string | null
    /** Claude session id of the conversation that was exported. */
    from?: string | null
    /** Claude session id of the clone — null until the clone first speaks. */
    to?: string | null
    harness?: string | null
    cwd?: string | null
}

/** What one end of a clone looks like on a session's metadata. */
export interface CloneLink {
    /** The other session's id, or null for a clone that has not started yet. */
    session: string | null
    harness: string | null
    at: string | null
}

export interface DroverClone {
    /** This session was seeded from that one. At most one: a seed has one source. */
    from?: CloneLink
    /** This session was cloned into those. A conversation can be cloned twice. */
    to?: CloneLink[]
}

export function readCloneLedger(): CloneRow[] {
    const path = cloneLedgerPath()
    try {
        if (!existsSync(path)) return []
        const raw = JSON.parse(readFileSync(path, 'utf8'))
        if (!Array.isArray(raw)) return []
        return raw.filter((r): r is CloneRow => !!r && typeof r === 'object' && typeof r.id === 'string')
    } catch {
        // Mid-write, or hand-edited into nonsense. Empty is the safe answer: a
        // missing lineage line is cosmetic, and throwing here would take a
        // session's metadata publish down with it.
        return []
    }
}

const link = (session: string | null | undefined, r: CloneRow): CloneLink => ({
    session: session ?? null,
    harness: r.harness ?? null,
    at: r.at ?? null,
})

/**
 * Both ends of this session's lineage, or undefined when it has none.
 *
 * `undefined` rather than an empty object so the caller can leave the key off
 * the metadata entirely — the app's schema treats an absent key and an empty
 * one differently only in that the empty one renders a heading with nothing
 * under it.
 */
export function cloneLineage(sessionId: string | null | undefined, rows = readCloneLedger()): DroverClone | undefined {
    if (!sessionId) return undefined
    let from: CloneLink | undefined
    const to: CloneLink[] = []
    for (const r of rows) {
        if (r.to === sessionId && r.from) from = link(r.from, r)
        if (r.from === sessionId) to.push(link(r.to, r))
    }
    if (!from && to.length === 0) return undefined
    return { ...(from ? { from } : {}), ...(to.length > 0 ? { to } : {}) }
}

export interface CloneReporterOptions {
    /** The CLAUDE session id, which is what the ledger keys on — not the Happy one. */
    current: () => string | null | undefined
    publish: (clone: DroverClone | undefined) => void
    now?: () => number
    pollMs?: number
}

/** Slow on purpose: a clone is a rare event and this is a file stat per tick. */
const pollMs = 10_000

/**
 * Keeps `metadata.droverClone` in step with the ledger.
 *
 * Publishes only on CHANGE, including the change to nothing: a session that
 * stops being anybody's clone (a row hand-deleted from the ledger) has to lose
 * the line, or the app shows a parent that is no longer claimed.
 */
export class CloneReporter {
    private readonly current: CloneReporterOptions['current']
    private readonly publish: CloneReporterOptions['publish']
    private readonly pollEvery: number

    private stamp = ''
    /**
     * Seeded to "no lineage", which is what the session started as.
     *
     * Left undefined, the first tick of an ordinary session — one no clone row
     * mentions, which is nearly all of them — published `undefined` as a
     * CHANGE and stripped a metadata key that was never set. A publish should
     * mean something happened.
     */
    private signature: string = 'null'
    private pollTimer: NodeJS.Timeout | null = null
    private stopped = false

    constructor(opts: CloneReporterOptions) {
        this.current = opts.current
        this.publish = opts.publish
        this.pollEvery = opts.pollMs ?? pollMs
    }

    start(): void {
        if (this.stopped || this.pollTimer) return
        this.tick()
        this.pollTimer = setInterval(() => this.tick(), this.pollEvery)
        // Never the reason the process stays alive.
        this.pollTimer.unref?.()
    }

    stop(): void {
        this.stopped = true
        if (this.pollTimer) clearInterval(this.pollTimer)
        this.pollTimer = null
    }

    /** Look now. True when something went out. Synchronous, so a test can drive it. */
    tick(): boolean {
        if (this.stopped) return false
        try {
            const id = this.current()
            const stamp = `${id ?? ''}\0${mtime(cloneLedgerPath())}`
            if (stamp === this.stamp) return false
            this.stamp = stamp
            const lineage = cloneLineage(id)
            const signature = JSON.stringify(lineage ?? null)
            if (signature === this.signature) return false
            this.signature = signature
            this.publish(lineage)
            return true
        } catch (err) {
            // Best effort, always. A lineage line that is a little stale beats
            // a session that dies because a file was mid-write.
            logger.debug('[clone] lineage read failed (ignored)', err)
            return false
        }
    }
}

function mtime(path: string): string {
    try {
        const st = statSync(path)
        return `${st.mtimeMs}:${st.size}`
    } catch {
        return '-'
    }
}
