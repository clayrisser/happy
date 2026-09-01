/**
 * Type ONE named row of the Fable credits dialog into the pane (DROVE-279).
 *
 * The rule this file exists to enforce, and the only one that matters:
 *
 *     Enter is pressed if and only if the pane, READ BACK on this same tick,
 *     shows the pointer on a row whose label is exactly the label we were
 *     asked for, and that label appears on exactly one row.
 *
 * Everything else is bookkeeping around that sentence. It is written as a loop
 * over `capture` / `press` rather than a computed key sequence because a
 * computed sequence has to trust its own arithmetic, and the cost of being one
 * row out here is "Yes, buy usage credits".
 *
 * Two measured details from 2.1.252 make the loop shape the right one:
 *
 *   - the select is mounted with `hideIndexes`, which sets `disableSelection:
 *     "numeric"`, so there is no digit that picks a row. Arrows only.
 *   - the dialog refuses input for `vb` = 150ms after it mounts and after each
 *     of its own state changes (`refuseInput: re`, `hs()`/`bc(E)`), and a
 *     keystroke sent inside that window is SWALLOWED and RESTARTS the window
 *     (`noteRefused`). A blind burst of Downs would therefore land anywhere.
 *     Re-reading after every press makes the window a non-event: a press that
 *     did nothing is simply pressed again.
 *
 * The IO is injected so the whole of that can be tested without a tmux.
 */

import {
    paneCreditsDialog,
    paneCreditsDialogTitle,
    type PaneCreditsDialog,
} from './paneCreditsDialog'

export interface CreditsAnswerIo {
    /** `tmux capture-pane -p`, or null when the pane cannot be read. */
    capture: () => Promise<string | null>
    /** One keystroke. `Enter`, `Escape`, `Down`, `Up`. */
    press: (key: string) => Promise<boolean>
    /** How the loop waits for the TUI to repaint. */
    settle: (ms: number) => Promise<void>
}

export type CreditsAnswerResult =
    /** The row was reached and Enter went in; the dialog is gone. */
    | { state: 'typed'; label: string }
    /** Escape went in instead, and the dialog is gone. Nothing was bought. */
    | { state: 'dismissed'; reason: string }
    /** The dialog left on its own — another surface, or Clay at the keyboard. */
    | { state: 'gone' }
    /**
     * Neither the row nor Escape could close it. NOTHING was typed on this
     * arm beyond the Escape that failed, so the pane is where it was.
     */
    | { state: 'stuck'; reason: string }

/**
 * How long the TUI gets to repaint between keystrokes.
 *
 * Comfortably past the 150ms refuse window, and the same order as
 * `paneCycleSettleMs` next door, which is the other loop that presses a key
 * and reads the screen back.
 */
const settleMs = 250

/**
 * How many presses the walk may spend.
 *
 * The dialog has two rows, or three with an upsell, so a correct walk is one
 * or two presses. The budget is generous because a press swallowed by the
 * refuse window costs a turn of the loop and buys nothing.
 */
const maxPresses = 12

function rowsMatching(dialog: PaneCreditsDialog, label: string) {
    return dialog.rows.filter((r) => r.label === label)
}

/**
 * Put the pointer on `label` and press Enter — or press Escape and say why.
 *
 * `label` null means "dismiss": the caller has no row it is willing to take,
 * which is what an unreadable safe row comes to. Escape runs the component's
 * own `onCancel`, which dismisses without consenting and without buying.
 */
export async function answerPaneCreditsRow(
    io: CreditsAnswerIo,
    label: string | null,
): Promise<CreditsAnswerResult> {
    if (label === null) return dismiss(io, 'no row this side is willing to take')

    for (let pressed = 0; pressed < maxPresses; pressed++) {
        const capture = await io.capture()
        // No screen to read is not a slow repaint. Nothing is typed blind.
        if (capture === null) return { state: 'stuck', reason: 'the pane could not be read' }
        const dialog = paneCreditsDialog(capture)
        if (dialog === null) {
            // Either it closed, or it is mid-repaint / on a spinner step. Both
            // are "look again", and the loop's own budget bounds the wait.
            if (paneCreditsStillUp(capture)) {
                await io.settle(settleMs)
                continue
            }
            return { state: 'gone' }
        }
        const matches = rowsMatching(dialog, label)
        // Zero means the dialog moved under us — a state change rewrote the
        // rows, so the answer we are holding is an answer to a question that
        // is no longer on screen. More than one means two rows read the same
        // and the pointer cannot disambiguate them. Neither is a row we may
        // press Enter on.
        if (matches.length !== 1) {
            return dismiss(
                io,
                matches.length === 0
                    ? `the pane no longer offers "${label}"`
                    : `"${label}" is on ${matches.length} rows, so the pointer cannot name one`,
            )
        }
        const target = matches[0]
        if (target.focused) {
            // THE ONE PLACE ENTER IS SENT. Guarded by this same read: the row
            // under the pointer, right now, is the row we were asked for.
            if (!(await io.press('Enter'))) {
                return { state: 'stuck', reason: 'tmux would not take the Enter' }
            }
            await io.settle(settleMs)
            const after = await io.capture()
            if (after === null || !paneCreditsStillUp(after)) return { state: 'typed', label }
            // THE TITLE ALONE IS NOT "it did not land". Two of the component's
            // steps keep the same title and drop the rows — `reenabling`
            // ("Turning on usage credits…") and `buy-external` ("Opening usage
            // credits…") — and both of those are what a taken Enter looks
            // like. Pressing on there would be pressing INTO the flow Clay
            // just asked for, and the Escape at the end of the budget would
            // then cancel it. So: rows gone means the Enter landed.
            if (paneCreditsDialog(after) === null) return { state: 'typed', label }
            // Rows still on screen: the Enter fell inside the 150ms refuse
            // window and was swallowed. Round again; the budget bounds it.
            continue
        }
        const key = target.index > dialog.focusedIndex ? 'Down' : 'Up'
        if (!(await io.press(key))) {
            return { state: 'stuck', reason: `tmux would not take the ${key}` }
        }
        await io.settle(settleMs)
    }
    return dismiss(io, 'the pointer would not settle on the chosen row')
}

/** Is one of the three titles still on screen? */
function paneCreditsStillUp(capture: string): boolean {
    return paneCreditsDialogTitle(capture) !== null
}

/**
 * Escape, then confirm it landed.
 *
 * Escape at this dialog is `onCancel` — dismissed, no consent written, no
 * purchase. It is NOT the DROVE-80 mistake of a blind Escape at a pane,
 * because every caller has already read this dialog off the screen; the
 * keystroke is aimed at something we can see.
 */
async function dismiss(io: CreditsAnswerIo, reason: string): Promise<CreditsAnswerResult> {
    // LOOK FIRST, even here. Escape at a pane with no dialog on it is not a
    // no-op: at an idle prompt it CLEARS whatever Clay has half-typed, which
    // is the same lesson as `interruptPane`'s `idle` arm (DROVE-13). The
    // caller's read can be a tick old — the `label === null` path has not read
    // at all — so this one is its own.
    const before = await io.capture()
    if (before !== null && !paneCreditsStillUp(before)) return { state: 'gone' }
    if (!(await io.press('Escape'))) {
        return { state: 'stuck', reason: `${reason}; and tmux would not take the Escape` }
    }
    await io.settle(settleMs)
    const after = await io.capture()
    if (after === null || !paneCreditsStillUp(after)) return { state: 'dismissed', reason }
    return { state: 'stuck', reason: `${reason}; and Escape did not close it` }
}
