/**
 * Which OTHER live sessions a flip is about to knock off Remote Control
 * (DROVE-37).
 *
 * Clay flipped the cattle-drover session onto jamrizzi and the unrelated
 * `employees` session — different account, different window, nothing to do
 * with the flip — printed:
 *
 *   Remote Control disconnected — signed-in claude.ai account or organization
 *   changed on this machine — run /remote-control to start a session for the
 *   current account, or /login to switch back
 *
 * Its replies stopped reaching the phone and it fell back to the terminal. He
 * saw a chat go silent.
 *
 * WHY DROVER CANNOT SIMPLY PREVENT IT. Measured rather than assumed: a flip
 * sets only DROVER_ACCOUNT and CLAUDE_CONFIG_DIR on the child it execs, and
 * every account has its OWN Keychain credential (five distinct
 * `Claude Code-credentials*` services) and its own .claude.json. So nothing
 * drover writes is shared. The disconnect comes from Claude Code's own device
 * binding: it holds a Remote Control session against a device looked up BY
 * accountUuid, and tears the session down with `account_mismatch` /
 * `account_changed` / `org_changed` when the account behind the device stops
 * matching. Binding this machine to a second account is what the other session
 * experiences as its own account changing underneath it.
 *
 * So the honest thing is not to pretend it can be avoided, but to say WHO is
 * about to go quiet, BEFORE it happens, naming sessions Clay recognises. A
 * silent chat he has to notice is the actual harm; a warning turns it into an
 * expected cost with a stated remedy.
 *
 * This warns and never blocks. A flip is usually asked for because an account
 * ran out, and refusing it would strand the session that asked.
 */

/** One row of the bus's `GET /v1/sessions`, narrowed to what matters here. */
export interface BusSession {
    id: string
    title?: string | null
    cwd?: string | null
    /** null means the session runs on the ambient login, which is `main`. */
    account?: string | null
    state?: string | null
}

export interface AtRiskSession {
    id: string
    /** Whatever a human would recognise it by: its title, else its directory. */
    label: string
    account: string
}

/**
 * The ambient account — no CLAUDE_CONFIG_DIR — is `main`. A session started
 * outside the drover wrapper reports `account: null`, and that is exactly the
 * case Clay hit: `employees` was unmanaged, so it is the one a naive filter on
 * a named account would miss.
 */
const ambient = 'main'

const accountOf = (s: BusSession): string => s.account ?? ambient

/** A session only loses Remote Control if it is actually running. */
const isLive = (s: BusSession): boolean => (s.state ?? '').startsWith('live')

function labelOf(s: BusSession): string {
    const title = (s.title ?? '').trim()
    if (title) return title
    const cwd = (s.cwd ?? '').trim()
    if (cwd) return cwd.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~')
    return s.id.slice(0, 8)
}

/**
 * Live sessions, other than the one flipping, whose account differs from where
 * the flip is going. A session already on the target account is unaffected:
 * the binding it holds is the one being renewed.
 */
export function sessionsAtRisk(opts: {
    sessions: BusSession[]
    /** The account the flip is moving TO. */
    target: string
    /** The session doing the flipping, which is not warned about itself. */
    selfId: string
}): AtRiskSession[] {
    const { sessions, target, selfId } = opts
    return sessions
        .filter((s) => s.id !== selfId && isLive(s) && accountOf(s) !== target)
        .map((s) => ({ id: s.id, label: labelOf(s), account: accountOf(s) }))
}

/**
 * The sentence Clay reads. Null when nothing is at risk, so the caller can
 * stay silent rather than announcing a reassurance on every flip — a warning
 * that fires every time is one nobody reads.
 */
export function warningFor(at: AtRiskSession[], target: string): string | null {
    if (at.length === 0) return null
    const names = at.map((s) => `${s.label} (${s.account})`).join(', ')
    const noun = at.length === 1 ? 'session' : 'sessions'
    const its = at.length === 1 ? 'it' : 'them'
    return (
        `Heads up: moving to ${target} will drop Remote Control for ${at.length} other live ${noun} ` +
        `on this machine — ${names}. Claude Code binds Remote Control to one account per machine, ` +
        `so ${its} will go quiet on the phone until you run /remote-control there — or tap Remote ` +
        `Control back on for ${its} in the app.`
    )
}

/**
 * Ask the bus who is live. Best effort by design: a flip is usually asked for
 * because an account ran out, so a bus that is down, slow or absent must cost
 * the warning and never the flip. Every failure path returns an empty list.
 */
export async function fetchBusSessions(
    url = process.env.DROVER_URL || 'http://127.0.0.1:7970',
    timeoutMs = 1500,
): Promise<BusSession[]> {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), timeoutMs)
    try {
        const res = await fetch(`${url}/v1/sessions`, { signal: abort.signal })
        if (!res.ok) return []
        const body: unknown = await res.json()
        // The bus answers `{scannedAt, scanning, stale, sessions: [...]}`, not
        // a bare array. The first cut checked Array.isArray(body) and so
        // returned [] against the real bus every time — the warning was dead
        // in production while 11 tests passed against a stubbed array. Accept
        // both, and let the test feed the real envelope.
        if (Array.isArray(body)) return body as BusSession[]
        const rows = (body as { sessions?: unknown })?.sessions
        return Array.isArray(rows) ? (rows as BusSession[]) : []
    } catch {
        return []
    } finally {
        clearTimeout(timer)
    }
}

/**
 * The sentence for `flip.say`, AND the same list in a shape the app can put a
 * button on (DROVE-63). Null when there is nothing to report or nothing could
 * be read.
 *
 * Both halves come from one bus read on purpose. The warning names the sessions
 * that just went quiet and the remedy it states is `/remote-control` in each of
 * them — which is the one thing Clay cannot do from the phone, and the reason
 * DROVE-63 exists. Carrying the ids alongside the prose lets the app offer that
 * remedy where he is actually reading the warning.
 */
export async function remoteControlWarning(opts: {
    target: string
    selfId: string
    listSessions?: () => Promise<BusSession[]>
}): Promise<{ text: string; atRisk: AtRiskSession[] } | null> {
    const list = opts.listSessions ?? (() => fetchBusSessions())
    const sessions = await list()
    const atRisk = sessionsAtRisk({ sessions, target: opts.target, selfId: opts.selfId })
    const text = warningFor(atRisk, opts.target)
    return text === null ? null : { text, atRisk }
}
