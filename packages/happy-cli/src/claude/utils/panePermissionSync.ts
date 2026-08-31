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
import { isPermissionMode, mapToClaudeMode } from './permissionMode'

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
    const chip = paneModeChipFromCapture(capture)
    if (chip !== null) return chip
    return capture.includes(promptMarker) ? 'default' : null
}

/**
 * The mode the footer's CHIP names, and nothing inferred (DROVE-199).
 *
 * The `❯`-means-manual-mode fallback above is right for the CYCLE, which only
 * ever runs behind a gate that has already established there is a Claude
 * prompt and no dialog on it. It is wrong for a watcher that reads the screen
 * on a timer: measured on this build, the folder-trust dialog draws a `❯` of
 * its own and no chip, so the fallback reported `default` for a session that
 * was in fact about to come up in `auto` — a wrong mode on the phone, and
 * briefly a wrong REQUEST once the mirror followed it.
 *
 * So the watcher takes this one and reports nothing rather than guessing. The
 * cost, stated: if a future build stops drawing a chip for manual mode, a
 * shift+tab INTO it is seen late — on the turn's own transcript record — as
 * against being seen wrongly now.
 */
export function paneModeChipFromCapture(capture: string): PaneMode | null {
    const text = capture.toLowerCase()
    for (const [mode, indicator] of paneModeIndicators) {
        if (text.includes(indicator)) return mode
    }
    return null
}

/** Read what mode the Claude in `pane` is in right now. */
export async function readPaneMode(pane: string): Promise<PaneMode | null> {
    const capture = await capturePaneScreen(pane)
    return capture === null ? null : paneModeFromCapture(capture)
}

/**
 * The same read for a WATCHER: the chip or nothing (DROVE-199). See
 * paneModeChipFromCapture for why the two differ.
 */
export async function readPaneModeChip(pane: string): Promise<PaneMode | null> {
    const capture = await capturePaneScreen(pane)
    return capture === null ? null : paneModeChipFromCapture(capture)
}

async function capturePaneScreen(pane: string): Promise<string | null> {
    try {
        // `-p` to stdout, and only the visible screen: the mode chip is in the
        // footer, and pulling scrollback would find every chip this session has
        // ever drawn, newest last but with nothing to say which is current.
        const { stdout } = await run('tmux', ['capture-pane', '-p', '-t', pane])
        return stdout
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

/**
 * What the app should be storing as its permission REQUEST, given the mode the
 * pane is observed to be in and what it currently asks for (DROVE-199).
 *
 * The twin of `paneModelAsRequest`, and it exists for the same reason. Since
 * DROVE-36 `panePermissionMode` has tracked the terminal and the composer's
 * padlock has rendered it, so the glyph was right whenever the transcript
 * spoke. `permissionMode` — the REQUEST — was not: it stayed on whatever the
 * app last picked, and both the app's "did this change?" test and the
 * launcher's own delta run against that. So a pane moved by a shift+tab at the
 * keyboard left the app asking for a mode it already believed it was on, and
 * the next tap on that row sent nothing at all. Exactly the DROVE-191 shape,
 * one field over.
 *
 * Mirroring the pane INTO the request is again the direction that terminates.
 * Two things are deliberately NOT mirrored:
 *
 *   - a mode the app cannot HOLD. `dontAsk` is in Claude Code's cycle and has
 *     an indicator, so a pane can be read as being in it, but it is absent
 *     from `PermissionMode` — the app can render it as a disabled row and can
 *     never ask for it. Writing it would be a request nothing downstream can
 *     carry out.
 *   - a request that FOLDS ONTO the observed mode. `yolo` and `safe-yolo` are
 *     Codex spellings that mapToClaudeMode turns into `bypassPermissions` and
 *     `default`; a session asking for `yolo` while the pane reads
 *     `bypassPermissions` is not disagreeing with the pane, and rewriting it
 *     would flip the app's own vocabulary under it for nothing. The same
 *     "the request says more than the pane can say" rule the `[1m]` model
 *     variant gets.
 *
 * `undefined` means "no opinion, leave the request where it is". Null is never
 * returned: an observed mode is always some mode, and clearing a request on
 * the strength of a pane we could not read is how a pick gets lost.
 */
export function panePermissionAsRequest(
    observed: string | null,
    requested: string | null | undefined,
): string | undefined {
    if (observed === null || !isPermissionMode(observed)) return undefined
    if (requested && isPermissionMode(requested) && mapToClaudeMode(requested) === observed) {
        return requested
    }
    return observed
}
