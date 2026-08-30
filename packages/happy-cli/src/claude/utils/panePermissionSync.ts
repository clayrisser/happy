/**
 * Carry the phone's permission-mode pick into the tmux pane (DROVE-36).
 *
 * DROVE-45 did this for model and effort and it was easy, because `/model` and
 * `/effort` are real slash commands: the pick is text, and typing it is the
 * whole job. Permission mode has no such command in 2.1.251. Measured with
 * `strings` on the binary rather than assumed:
 *
 *   name:"permissions",aliases:["allowed-tools"],
 *     description:"Manage allow and deny tool permission rules",immediate:!0
 *
 * — no `argumentHint`, and its description is the rules editor, not the mode.
 * `/plan` can only enter plan mode. There is a `set_permission_mode` control
 * request, but it belongs to the stream-json / remote-control bridge, and a
 * session that is a real TUI in a pane (DROVE-1) has no such wire. And the
 * inbox socket's `user` frame carries no mode at all — measured on a live
 * transcript, a peer-delivered prompt is stamped with the RECIPIENT's mode
 * (`"permissionMode":"bypassPermissions"` on a message this machine sent
 * itself), so the field cannot ride in with the message.
 *
 * What is left is the thing a person at the keyboard uses: shift+tab. The
 * cycle is a ring, also measured:
 *
 *   function p$e(S){let x=["plan","default","acceptEdits"];
 *     if(Fj(S))x.push("auto"); if(F8t(S))x.push("bypassPermissions"); return x}
 *
 * — `auto` and `bypassPermissions` are in it only when they are available, and
 * nothing outside the process can read those two gates. So this does NOT count
 * presses. It presses once, reads the pane back, and presses again: a loop that
 * needs to know neither the ring's length nor where in it we started, and that
 * corrects itself if Claude Code refuses a mode.
 *
 * Reading the pane back is possible because Claude Code prints the mode in its
 * own footer. The indicator strings are from the same binary:
 *
 *   default:{indicator:"manual mode"}  plan:{indicator:"plan mode"}
 *   acceptEdits:{indicator:"accept edits"}
 *   bypassPermissions:{indicator:"bypass permissions"}
 *   dontAsk:{indicator:"don't ask"}  auto:{indicator:"auto mode"}
 *
 * and the renderer appends " on" (`const Zue=CYt?"":" on"`). Confirmed against
 * a live pane on 2026-08-30, which drew:
 *
 *   ⏵⏵ bypass permissions on · 2 shells · esc to interrupt · ← for agents · ↓ …
 *
 * The chip sits FIRST in that line, so it survives the footer's own truncation
 * at a narrow width. Manual mode is the one that may draw no chip, so an
 * absent chip reads as `default` — but only when the prompt box is on screen,
 * because "no chip" and "the footer is not being drawn at all" are otherwise
 * the same sighting, and pressing shift+tab against the second one moves a
 * mode we never read.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { logger } from '@/ui/logger'

const run = promisify(execFile)

/**
 * The modes Claude Code itself names. `bubble` is in its union too but has no
 * indicator row, so a pane can never be read as being in it.
 */
export type PaneMode =
    | 'default'
    | 'plan'
    | 'acceptEdits'
    | 'bypassPermissions'
    | 'auto'
    | 'dontAsk'

/**
 * Footer chip -> mode. Ordered longest-first where one indicator could be read
 * inside another; none currently can, but the order is the guarantee.
 */
const paneModeIndicators: ReadonlyArray<readonly [PaneMode, string]> = [
    ['bypassPermissions', 'bypass permissions on'],
    ['acceptEdits', 'accept edits on'],
    ['plan', 'plan mode on'],
    ['auto', 'auto mode on'],
    ['dontAsk', "don't ask on"],
    // Listed even though manual mode is the one that may draw no chip: if a
    // future build starts drawing it, this reads it rather than mistaking the
    // chip for "some mode we do not know" and giving up.
    ['default', 'manual mode on'],
]

/**
 * The prompt box's own marker. Its presence is what lets an ABSENT chip mean
 * "manual mode" rather than "the footer is not on screen".
 */
const promptMarker = '❯'

/**
 * The mode a captured pane is in, or null when the capture does not show a
 * Claude prompt at all.
 *
 * Null is not a mode and must never be treated as one: the caller's only
 * correct response to it is to do nothing, because every keystroke this file
 * sends is aimed at a prompt it believes is there.
 */
export function paneModeFromCapture(capture: string): PaneMode | null {
    const text = capture.toLowerCase()
    for (const [mode, indicator] of paneModeIndicators) {
        if (text.includes(indicator)) return mode
    }
    return capture.includes(promptMarker) ? 'default' : null
}

/** Read what mode the Claude in `pane` is in right now. */
export async function readPaneMode(pane: string): Promise<PaneMode | null> {
    try {
        // `-p` to stdout, and only the visible screen: the mode chip is in the
        // footer, and pulling scrollback would find every chip this session has
        // ever drawn, newest last but with nothing to say which is current.
        const { stdout } = await run('tmux', ['capture-pane', '-p', '-t', pane])
        return paneModeFromCapture(stdout)
    } catch (e) {
        logger.debug('[panePermissionSync] capture-pane failed:', e)
        return null
    }
}

/** One shift+tab. tmux spells it `BTab`. */
export async function pressCycleKey(pane: string): Promise<boolean> {
    try {
        await run('tmux', ['send-keys', '-t', pane, 'BTab'])
        return true
    } catch (e) {
        logger.debug('[panePermissionSync] send-keys BTab failed:', e)
        return false
    }
}

export interface CyclePaneModeOptions {
    /** What mode the pane is in now. Null means "cannot tell". */
    read: () => Promise<PaneMode | null>
    /** Press shift+tab once. False means the keystroke did not go in. */
    press: () => Promise<boolean>
    /** Let the TUI repaint before reading back. */
    settle: () => Promise<void>
    /**
     * How many presses before giving up on reaching `target`.
     *
     * The ring is at most five long (plan, default, acceptEdits, auto,
     * bypassPermissions), so six is one full lap plus one. Going round again to
     * put the pane back where it started is budgeted separately below.
     */
    maxPresses?: number
}

/** What one attempt at a mode change came to. */
export type CycleOutcome =
    /** The pane is in `target` now. Includes "it already was". */
    | 'applied'
    /** The pane never showed a prompt, so nothing was pressed. */
    | 'unreadable'
    /** A keystroke did not go in. Nothing moved; safe to retry later. */
    | 'refused'
    /**
     * A full lap did not reach `target` — it is gated off in this session
     * (bypass disabled by policy, auto behind its flag). The pane was walked
     * back to where it started rather than left on whatever it landed on.
     */
    | 'unreachable'

/**
 * Cycle the pane to `target` with shift+tab, checking after every press.
 *
 * The check after every press is the whole design. Counting presses would need
 * the ring's contents, which depend on two gates this process cannot see, and
 * a miscount leaves Clay's session in plan mode with nothing to say so.
 *
 * If the target turns out to be unreachable, the pane is walked the rest of the
 * way round to the mode it started in. Landing somewhere arbitrary because we
 * asked for something the session will not give is worse than not trying: the
 * pick would have silently changed a mode nobody chose.
 */
export async function cyclePaneMode(
    target: PaneMode,
    opts: CyclePaneModeOptions,
): Promise<CycleOutcome> {
    const maxPresses = opts.maxPresses ?? 6
    const started = await opts.read()
    if (started === null) return 'unreadable'
    if (started === target) return 'applied'

    let current = started
    for (let pressed = 0; pressed < maxPresses; pressed++) {
        if (!(await opts.press())) return 'refused'
        await opts.settle()
        const next = await opts.read()
        if (next === null) {
            // The prompt went away under us — a turn started, a dialog opened.
            // Stop rather than press blind at whatever is there now.
            logger.debug('[panePermissionSync] lost sight of the prompt mid-cycle — stopping')
            return 'unreadable'
        }
        if (next === target) return 'applied'
        if (next === current) {
            // The press landed but the mode did not move. Nothing further will
            // move it either, so stop before the loop burns its whole budget.
            logger.debug(`[panePermissionSync] shift+tab left the pane on ${next} — giving up`)
            return 'unreachable'
        }
        current = next
    }

    logger.debug(`[panePermissionSync] ${target} is not in this session's cycle — returning the pane to ${started}`)
    for (let pressed = 0; pressed < maxPresses && current !== started; pressed++) {
        if (!(await opts.press())) break
        await opts.settle()
        const next = await opts.read()
        if (next === null || next === current) break
        current = next
    }
    return 'unreachable'
}
