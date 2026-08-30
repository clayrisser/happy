/**
 * What the Remote Control control shows, and what a tap writes (DROVE-63).
 *
 * Clay: "add a button to the drover mobile app that enables or disables the
 * remote control for Claude Code." Today the only way in is typing
 * `/remote-control` in the pane, which is exactly the thing he cannot do from
 * the phone — and it is also the remedy DROVE-37 prints when a flip knocks
 * every other live session off Remote Control.
 *
 * The rule this file exists to hold: THE CONTROL SHOWS THE TRUTH, NEVER THE
 * TAP. `metadata.paneRemoteControl` is what the CLI read off the transcript's
 * `bridge-session` records; `session.remoteControl` is only what someone asked
 * for. When they disagree the ask is still in flight — the pane may be
 * mid-turn, and a slash command waits for an idle prompt — so the control keeps
 * showing the truth and says it is working on it. Showing the ask would make a
 * tap that never lands look like it did.
 *
 * Unknown is a third state and not a synonym for off. `/remote-control` is a
 * TOGGLE (measured on 2.1.251: its own description flips to "Disconnect Remote
 * Control" when active, and there is no on/off argument), so acting on a guess
 * can silence the session the button was meant to wake.
 */

/** The three things the control can be, plus whether an ask is outstanding. */
export interface RemoteControlState {
    /** True = on, false = off, null = the pane has not said yet. */
    value: boolean | null
    /** An ask is written and the pane has not caught up with it. */
    pending: boolean
    /** What a tap should write next. Null when there is nothing sensible to ask. */
    next: 'on' | 'off' | null
}

/** The subset of a session this file reads. */
export interface RemoteControlSource {
    /** The local mirror of `metadata.remoteControl`: 'on' | 'off' | null. */
    remoteControl?: string | null
    metadata?: {
        hasPane?: boolean
        paneRemoteControl?: boolean | null
        remoteControl?: string | null
    } | null
}

/**
 * Only a session that IS a Claude Code TUI in a tmux pane has a
 * `/remote-control` to toggle (DROVE-1: that is every drover session). A
 * paneless session has no terminal for the command to reach, so offering the
 * control there would be a button with nowhere to go.
 */
export function supportsRemoteControlToggle(source: RemoteControlSource | null | undefined): boolean {
    return source?.metadata?.hasPane === true
}

/** 'on' / 'off' / null, tolerating a boolean written by another client. */
export function parseRemoteControlAsk(value: unknown): boolean | null {
    if (value === true || value === 'on') return true
    if (value === false || value === 'off') return false
    return null
}

export function resolveRemoteControlState(
    source: RemoteControlSource | null | undefined,
): RemoteControlState {
    const truth = source?.metadata?.paneRemoteControl
    // The mirror is the fresher of the two while a push is in flight; fall back
    // to synced metadata for a session this device has not touched.
    const ask = parseRemoteControlAsk(
        source?.remoteControl ?? source?.metadata?.remoteControl,
    )

    if (typeof truth !== 'boolean') {
        // Nothing read yet. An outstanding ask is still worth showing as
        // pending — it is why the row is not just blank — but the value stays
        // unknown, and a tap has nothing safe to ask for beyond repeating it.
        return { value: null, pending: ask !== null, next: ask === null ? 'on' : null }
    }

    return {
        value: truth,
        pending: ask !== null && ask !== truth,
        next: truth ? 'off' : 'on',
    }
}

/** One row of `metadata.remoteControlAtRisk`, as the flip wrote it. */
export interface AtRiskRow {
    id: string
    label: string
    account: string
}

/**
 * The app session a DROVE-37 at-risk row is about.
 *
 * The ids in that list come from drover's bus, and the bus keys sessions by
 * CLAUDE's session id — measured against the live bus, where this session shows
 * as `19c2f0a8-…`, the id of its transcript file. The app keys by the HAPPY
 * session id and carries Claude's as `metadata.claudeSessionId`. Matching on
 * `session.id` alone finds nothing, and a button that silently matches nothing
 * is the same failure as a button that lies.
 *
 * Happy ids are still accepted, so a bus that starts reporting them one day
 * does not need this changed twice.
 */
export function findSessionForAtRisk<T extends { id: string; metadata?: { claudeSessionId?: string } | null }>(
    sessions: readonly T[],
    row: AtRiskRow,
): T | null {
    return sessions.find((s) => s.metadata?.claudeSessionId === row.id)
        ?? sessions.find((s) => s.id === row.id)
        ?? null
}

/**
 * How long a flip's fallout list stays worth showing (DROVE-63).
 *
 * The flip writes it and nothing ever clears it, so without a cutoff the banner
 * outlives the problem: Clay would open a session next week and be told four
 * chats went quiet on Sunday. A flip's fallout is a same-sitting matter — he
 * either wakes them or he does not — so twelve hours is generous and still
 * short of "the next time I look at this session".
 */
export const atRiskListMaxAgeMs = 12 * 60 * 60 * 1000

/** Whether the at-risk list is recent enough to still be about now. */
export function isAtRiskListFresh(
    writtenAt: number | null | undefined,
    now: number,
    maxAgeMs: number = atRiskListMaxAgeMs,
): boolean {
    // No timestamp means an older CLI wrote it. Show it rather than swallow it:
    // fold, never drop.
    if (typeof writtenAt !== 'number') return true
    return now - writtenAt < maxAgeMs
}
