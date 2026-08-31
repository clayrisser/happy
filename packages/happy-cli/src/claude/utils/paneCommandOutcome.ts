/**
 * What the pane DID with the `/model` or `/effort` we just typed (DROVE-164).
 *
 * Until this file existed, `injectIntoPane` returning true — "tmux accepted the
 * keystrokes" — was treated as "the switch happened", and the launcher wrote
 * `paneEffort` from the value it had typed. Three things make that a lie, all
 * measured against Claude Code 2.1.251 rather than assumed:
 *
 *   1. A CONFIRM DIALOG. `/effort <anything>` on a conversation that already
 *      has history draws
 *
 *          Change effort level?
 *          This conversation is cached for the current effort level. Switching
 *          to xhigh means the full history gets re-read on your next message.
 *          > 1. Yes, switch to xhigh
 *            2. No, go back
 *
 *      and waits. Nobody was pressing that Enter, so every effort pick made
 *      from the phone at an idle prompt stopped there — while the app was told
 *      it had landed. `/model` has the same dialog spelled `Switch model?`.
 *      Both come from one component, so one detector covers them.
 *
 *   2. REFUSAL. `Invalid argument: …`, `… exceeds your organization's limit
 *      for …`, `Ultracode runs at xhigh effort, which <model> doesn't
 *      support …`, `Not applied: the launch-effort pin holds effort at …`.
 *      Each of those leaves the pane on the level it was already on, and the
 *      phone has to be told in the pane's own words rather than shown a pick
 *      that quietly did nothing.
 *
 *   3. ULTRACODE IS NOT AN EFFORT. `/effort ultracode` sets effort to `xhigh`
 *      and turns dynamic workflows on beside it, so the transcript records
 *      `"effort":"xhigh"` and carries no ultracode field at all. The one place
 *      it is visible is the composer's top rule, which reads `── ultracode ─`
 *      while it is on. That is what `paneUltracodeActive` looks at, and it is
 *      why the phone can show Ultracode instead of snapping to xHigh.
 *
 * Everything here is a pure function over one `tmux capture-pane -p` string, so
 * it is testable without a terminal.
 */

/** A line tmux drew as one of the composer's horizontal rules. */
function isRule(line: string): boolean {
    const bar = (line.match(/─/g) ?? []).length
    return bar >= 8
}

/**
 * The text sitting in the pane's input box, or null when it cannot be found.
 *
 * The composer is the region between the last two rules on screen. Its first
 * line starts with the prompt marker; everything after that marker is what a
 * person has typed. Null is not "empty" — a pane mid-repaint, or one showing
 * something that is not the TUI, must not be read as a clear box.
 */
export function paneComposerText(capture: string): string | null {
    const lines = capture.split('\n')
    const rules: number[] = []
    for (let i = lines.length - 1; i >= 0 && rules.length < 2; i--) {
        if (isRule(lines[i])) rules.push(i)
    }
    if (rules.length < 2) return null
    const [bottom, top] = rules
    if (bottom - top < 2) return null
    const body = lines.slice(top + 1, bottom)
    const first = body[0] ?? ''
    const marker = first.indexOf('❯')
    if (marker === -1) return null
    const head = first.slice(marker + 1)
    return [head, ...body.slice(1)].join('\n').trim()
}

/**
 * Claude Code's own placeholder, which occupies the input box on a session
 * that has not been typed into yet and is indistinguishable from a draft once
 * tmux has thrown the colours away.
 */
const placeholderRe = /^Try ".*"$/

/**
 * Is the input box clear enough to paste a command into?
 *
 * This is the check that replaces "wait for the turn to end". A pane is a
 * keyboard and the danger was never the turn — it is Clay's half-typed line,
 * which a paste would join and the Enter would submit. So the question is
 * whether the box is empty, not whether Claude is busy.
 *
 * Unreadable answers false, same bias as the idle gate: the cost is a command
 * held for another two seconds.
 */
export function paneComposerIsEmpty(capture: string): boolean {
    const text = paneComposerText(capture)
    if (text === null) return false
    if (text.length === 0) return true
    return placeholderRe.test(text)
}

/**
 * Is Claude Code's model/effort confirmation on screen?
 *
 * Both titles come from the same component (`kind === "model" ? "Switch
 * model?" : "Change effort level?"`), and both offer the same two rows with
 * "Yes" preselected, so answering either is one Enter.
 */
export function paneConfirmDialog(capture: string): 'effort' | 'model' | null {
    if (capture.includes('Change effort level?')) return 'effort'
    if (capture.includes('Switch model?')) return 'model'
    return null
}

/**
 * Is this session running ultracode right now?
 *
 * The word is written into the composer's TOP rule — `──…── ultracode ─` — the
 * same place the model badge goes. The bottom rule is always plain, so this
 * takes the second rule from the end rather than the first.
 */
export function paneUltracodeActive(capture: string): boolean {
    const lines = capture.split('\n')
    const rules: string[] = []
    for (let i = lines.length - 1; i >= 0 && rules.length < 2; i--) {
        if (isRule(lines[i])) rules.push(lines[i])
    }
    return rules.length === 2 && rules[1].includes('ultracode')
}

export type PaneCommandOutcome =
    /** Claude Code said it did it. `value` is the level or model it named. */
    | { state: 'applied'; value: string | null }
    /** The confirmation is up and wants an Enter. */
    | { state: 'confirm' }
    /** Claude Code refused, in these words. */
    | { state: 'refused'; message: string }
    /** Nothing has appeared yet. Keep looking. */
    | { state: 'pending' }

/**
 * Every way 2.1.251 says no to a `/effort` or `/model`, as a prefix to match on
 * and the words to pass to the phone. Ordered longest-context first so a
 * refusal that also contains "Invalid argument" is reported as itself.
 */
const refusals: RegExp[] = [
    /Ultracode [^\n]*/,
    /Not applied: [^\n]*/,
    /Invalid argument: [^\n]*/,
    /Effort '[^\n]*exceeds your organization's limit[^\n]*/,
    /Failed to set effort level: [^\n]*/,
    /CLAUDE_CODE_EFFORT_LEVEL=[^\n]*/,
    /Unknown model[^\n]*/,
]

const appliedEffort = /Set effort level to ([A-Za-z]+)/
const appliedModel = /Set model to ([^\n(]+)/
const keptModel = /Kept model as ([^\n(]+)/

/**
 * Read one capture and say what became of the command.
 *
 * `since` is the capture taken just BEFORE the paste. A pane keeps its
 * scrollback, so "Set effort level to high" from ten minutes ago is still on
 * screen; only text that was not there before is evidence about this command.
 */
export function paneCommandOutcome(
    before: string,
    after: string,
    kind: 'effort' | 'model',
): PaneCommandOutcome {
    const dialog = paneConfirmDialog(after)
    if (dialog !== null && paneConfirmDialog(before) === null) return { state: 'confirm' }

    /**
     * The NEWEST match of `re`, if it was not already on screen.
     *
     * Newest, not first, and that is load bearing: a pane keeps its
     * scrollback, so `/effort max` typed after `/effort low` finds "Set effort
     * level to low" higher up the screen and would report the wrong answer —
     * or, seeing that line in both captures, no answer at all. Measured on a
     * real session: `/effort max` came back as "no answer from the pane"
     * because the first match was the previous command's.
     *
     * New means either one more of them than before, or a last match that says
     * something different. Both, because the pane scrolls: a count alone loses
     * a result whose predecessor rolled off the top.
     */
    const fresh = (re: RegExp): RegExpMatchArray | null => {
        const all = (s: string) => [...s.matchAll(new RegExp(re.source, 'g'))]
        const afterHits = all(after)
        if (afterHits.length === 0) return null
        const beforeHits = all(before)
        const newest = afterHits[afterHits.length - 1]
        if (afterHits.length > beforeHits.length) return newest
        const previous = beforeHits[beforeHits.length - 1]
        return previous && previous[0] === newest[0] ? null : newest
    }

    for (const re of refusals) {
        const hit = fresh(re)
        if (hit) return { state: 'refused', message: hit[0].trim() }
    }
    if (kind === 'effort') {
        const hit = fresh(appliedEffort)
        if (hit) return { state: 'applied', value: hit[1] }
    } else {
        const hit = fresh(appliedModel) ?? fresh(keptModel)
        if (hit) return { state: 'applied', value: hit[1].trim() }
    }
    return { state: 'pending' }
}

/** `/effort ultracode` -> `effort`, `/model claude-opus-5` -> `model`. */
export function paneCommandKind(command: string): 'effort' | 'model' | null {
    if (command.startsWith('/effort ')) return 'effort'
    if (command.startsWith('/model ')) return 'model'
    return null
}
