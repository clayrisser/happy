/**
 * Claude Code's Fable credits dialog, read off the pane (DROVE-279).
 *
 * `paneConfirmDialog` next door matches two titles — "Switch model?" and
 * "Change effort level?" — and `applyPaneSelectionCommand` answers them with
 * one Enter, because both come from a component whose rows are always
 * `Yes, switch` / `No, go back` and whose Yes is preselected.
 *
 * There is a THIRD family, from a SEPARATE component, and it must never be
 * answered that way. Measured in the 2.1.252 binary (the component is `Wme`,
 * chunk-eb5y4yrx):
 *
 *     let k = v === "picker" ? "Switch to Fable 5?"
 *           : G ? "You've reached your Fable 5 limit"
 *           : "Fable 5 now uses usage credits"
 *
 * and its rows, in order, are
 *
 *     [{label: fe, value: "switch"}, {label: ye, value: "confirm"}, ...upsell]
 *
 * where `ye` — the SECOND row — is one of
 *
 *     "Continue with Fable 5"          (consent: spends the credits you have)
 *     "Yes, re-enable and continue"    (turns overages back on, then spends)
 *     "Yes, buy usage credits"         (opens the purchase flow)
 *     "Buy usage credits"              (ditto)
 *     "Set up usage credits on claude.ai" / "Manage usage credits on claude.ai"
 *     "Request usage credits from your admin" / "Request more from your admin"
 *
 * A blind Enter on this dialog is therefore a PURCHASE, or the consent that
 * makes the next token a purchase. Clay's money is not an agent's to spend, so
 * nothing in this file answers anything. It READS: the title, the prose, and
 * the rows exactly as the pane drew them, so the phone can render the real
 * choice and a human can tap one.
 *
 * TWO MEASURED FACTS SHAPE THE READER.
 *
 *   1. `hideIndexes: !0` on this select, which sets `disableSelection:
 *      "numeric"` in the shared component (`Hr`, chunk-4xj01xwv). So the rows
 *      carry NO "1." / "2." prefix and typing a number picks nothing. The only
 *      way to a row is the arrow keys, which is why `paneCreditsAnswer` walks
 *      the pointer instead of sending a digit.
 *
 *   2. Every row is drawn by one frame (`fl` -> `rr`) as a one-character
 *      marker, then a one-column gap, then the label:
 *
 *          ❯ Continue with Fable 5      <- focused, `L.pointer`
 *            No, keep my current model  <- not focused, a space
 *
 *      and the dialog's PROSE sits at the marker's own column. That two-column
 *      step is the whole structural signature, and it is the same one the
 *      "Change effort level?" fixture in paneCommandOutcome.test.ts already
 *      shows. Nothing here matches on label text to FIND a row, because the
 *      third row's label is an upsell string this file cannot know.
 *
 * Label text is used for exactly one thing: deciding which row is SAFE to take
 * when nobody answers. That decision fails closed — an unrecognised first row
 * is not assumed to be the decline.
 *
 * One backstop worth writing down and NOT relying on: the component mounts
 * with `defaultFocusValue: "switch"`, so the row a stray Enter would take is
 * the decline rather than the purchase. That is where the pointer STARTS, not
 * where it stays — Clay arrowing down at his own keyboard moves it — so it is
 * the reason a mis-timed keystroke is survivable, never a reason to send
 * one.
 *
 * Pure over one `tmux capture-pane -p` string, like everything else here.
 */

/** A line tmux drew as one of the composer's horizontal rules. */
function isRule(line: string): boolean {
    const bar = (line.match(/─/g) ?? []).length
    return bar >= 8
}

/**
 * The three titles, verbatim from 2.1.252.
 *
 * Deliberately NOT added to `paneConfirmDialog`. That function's contract is
 * "this dialog is answered by one Enter", and these are the dialogs for which
 * that sentence is false.
 */
export const paneCreditsTitles = [
    'Switch to Fable 5?',
    "You've reached your Fable 5 limit",
    'Fable 5 now uses usage credits',
] as const

/** One row of the dialog, exactly as the pane drew it. */
export interface PaneCreditsRow {
    /** 0-based, top to bottom. Row 0 is the component's `switch` row. */
    index: number
    /** The pane's own text. Never a label this file invented. */
    label: string
    /** The row the pointer is on — the row a bare Enter would take. */
    focused: boolean
}

export interface PaneCreditsDialog {
    /** Which of the three is on screen. */
    title: string
    /** The prose between the title and the rows, joined with newlines. */
    body: string
    rows: PaneCreditsRow[]
    /** Index of the focused row. Always a valid index into `rows`. */
    focusedIndex: number
}

/**
 * Is one of the three titles on screen?
 *
 * Separate from the full read because the gate that holds the pane queue needs
 * an answer even while the dialog is in a state that has no rows to read — it
 * opens on `loading` ("Checking usage credits…") and passes through
 * `reenabling` and `buy-external` spinners, and a keystroke sent into any of
 * those still lands on a dialog.
 */
export function paneCreditsDialogTitle(capture: string): string | null {
    for (const title of paneCreditsTitles) {
        if (capture.includes(title)) return title
    }
    return null
}

/** Where the dialog's own text ends: the composer's top rule, or the bottom. */
function regionEnd(lines: string[], from: number): number {
    for (let i = from; i < lines.length; i++) {
        if (isRule(lines[i])) return i
    }
    return lines.length
}

/**
 * Read the dialog, or null when there is nothing answerable on screen.
 *
 * Null covers three different things and they all want the same caller
 * behaviour — look again in a moment — so they are not distinguished: no
 * credits dialog at all, a spinner state with no rows, and a pane caught
 * mid-repaint. The one thing null NEVER means is "there are rows and none of
 * them is focused": the component renders `isFocused` off `m.focusedValue`
 * with `isDisabled` false, so exactly one row always carries the pointer, and
 * a read that finds none is a read that has not settled.
 */
export function paneCreditsDialog(capture: string): PaneCreditsDialog | null {
    const title = paneCreditsDialogTitle(capture)
    if (title === null) return null
    const lines = capture.split('\n')
    const titleIndex = lines.findIndex((l) => l.includes(title))
    if (titleIndex === -1) return null
    const end = regionEnd(lines, titleIndex + 1)
    const region = lines.slice(titleIndex + 1, end)

    // The pointer fixes the marker column, and the marker column fixes
    // everything else. Taken from the region rather than the whole capture so
    // the composer's own `❯` at column 0 can never stand in for it.
    let marker = -1
    for (const line of region) {
        const at = line.indexOf('❯')
        if (at !== -1) {
            marker = at
            break
        }
    }
    if (marker === -1) return null

    const rows: PaneCreditsRow[] = []
    const body: string[] = []
    for (const line of region) {
        // A row: blank left of the marker column, a marker or a space in it,
        // a blank gap column, and a label starting immediately after. The
        // scroll arrows sit in the marker column too when the list is longer
        // than the window, which this dialog's two or three rows never are —
        // they are accepted anyway so a taller build does not read as prose.
        const head = line.slice(0, marker)
        const mark = line[marker] ?? ''
        const gap = line[marker + 1] ?? ''
        const label = line.slice(marker + 2).trim()
        const isRowShape =
            head.trim() === '' &&
            (mark === '❯' || mark === ' ' || mark === '↓' || mark === '↑') &&
            gap === ' ' &&
            label !== ''
        if (isRowShape) {
            rows.push({ index: rows.length, label, focused: mark === '❯' })
            continue
        }
        // Prose sits AT the marker column. Anything else — the border, a blank
        // line, a stray fragment of the turn above — is not the dialog's text.
        const prose = line.trim()
        if (prose !== '' && line.slice(0, marker).trim() === '') body.push(prose)
    }

    // Two guards, and they are the ones that keep a half-drawn screen from
    // being read as a choice: a dialog with fewer than two rows is not this
    // component (it always renders `switch` and `confirm`), and more than one
    // pointer means two things on screen were parsed as one list.
    if (rows.length < 2) return null
    const focused = rows.filter((r) => r.focused)
    if (focused.length !== 1) return null

    return { title, body: body.join('\n'), rows, focusedIndex: focused[0].index }
}

/**
 * Rows that cost money, or consent to costing money.
 *
 * Used only to REFUSE a row as the safe one. It is never used to pick a row:
 * a human who taps "Yes, buy usage credits" on his own phone has bought
 * credits, and this file has no opinion about that.
 */
const spendingRow = [
    /\bbuy\b/i,
    /\bpurchase\b/i,
    /usage credits/i,
    /\bcredits\b/i,
    /^continue with fable/i,
    /re-?enable/i,
    // The `be` fallback, for a seat that cannot buy in-app: "Request usage
    // credits from your admin" / "Request more from your admin". It is the
    // CONFIRM row, so it must never be mistaken for the decline even though
    // the money it moves is somebody else's to release.
    /^request /i,
]

/**
 * Rows that decline, verbatim from the three spellings of `fe` in 2.1.252:
 *
 *     v === "mid-session" && W !== null ? `Switch to ${cs(W)} and continue`
 *   : v === "mid-session"               ? "Not now"
 *   :                                    "No, keep my current model"
 */
const decliningRow = [
    /^no, keep my current model$/i,
    /^not now$/i,
    /^switch to .+ and continue$/i,
]

/** Would taking this row spend money, or consent to spending it? */
export function creditsRowSpends(label: string): boolean {
    return spendingRow.some((re) => re.test(label))
}

/**
 * The row to take when nobody answers, or null when there isn't one.
 *
 * Null is a real answer and the caller must handle it rather than fall back to
 * a position: a build that renames the decline is a build this file has not
 * been measured against, and guessing which row is harmless is exactly the
 * guess that spends money. The caller presses Escape instead, which is the
 * component's own `onCancel` and buys nothing either.
 */
export function creditsSafeRow(dialog: PaneCreditsDialog): PaneCreditsRow | null {
    for (const row of dialog.rows) {
        if (creditsRowSpends(row.label)) continue
        if (decliningRow.some((re) => re.test(row.label))) return row
    }
    return null
}
