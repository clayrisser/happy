/**
 * Buttons on the push itself, so a gate is answered without opening the app
 * (DROVE-207).
 *
 * Clay: "Notification, instead of just dismiss shouldn't you have the option
 * for me to select the answer from the push notification."
 *
 * THE CONSTRAINT THAT SHAPES ALL OF THIS. iOS renders a push's buttons from a
 * `UNNotificationCategory` the APP registered, named by `aps.category` on the
 * payload. The titles are baked in at registration time. A gate's options are
 * not knowable then — DROVE-198's four-option dialog carries a label naming
 * the exact command and directory — so the buttons cannot be the gate's own
 * label text. They have to come from a CLOSED vocabulary the app can register
 * up front, and the push names which shape of that vocabulary this gate is.
 *
 * So: every option is classified into a ROLE (allow, allow-and-stop-asking,
 * auto mode, deny, done, drop, Enter, Esc), and a known sequence of roles
 * picks a category. A gate whose options do not classify — a question with
 * arbitrary answers — falls back to a NUMBERED category, "1 2 3 4", with the
 * labels listed in the push body, which is exactly how the terminal shows the
 * same prompt.
 *
 * The slot is positional and the answer travels in the payload: slot i answers
 * with `data.actions[i]`, the real bus option id. Nothing matches on label
 * text, so a category and a gate can never disagree about what a button meant.
 *
 * Mirrored, deliberately, in happy-app's `sources/sync/droverNotificationCategories.ts`:
 * the two halves must agree on every identifier, and a spec on each side pins
 * the same literal list. They are not shared through a package because that
 * would put a build step between the CLI and the phone for a table of strings.
 */

import type { DroverEvent, DroverOption } from './droverBridge'

/** One button's meaning. The app turns this into a title. */
export type GateActionRole =
    | 'allow'
    | 'allow_always'
    | 'auto'
    | 'deny'
    | 'done'
    | 'drop'
    | 'enter'
    | 'esc'
    | 'pick1'
    | 'pick2'
    | 'pick3'
    | 'pick4'
    | 'more'

/**
 * Every category the app registers, and the roles in it, in button order.
 *
 * Small and closed on purpose. iOS shows at most four buttons on an expanded
 * banner and fewer on a collapsed one, so nothing here is longer than four,
 * and a gate with more options than fit gets `pickmore`, whose last button
 * opens the app rather than answering.
 */
export const gateCategoryRoles: Record<string, GateActionRole[]> = {
    // The bus injects [{allow},{deny}] on every permission with no options of
    // its own, so this is the commonest gate on the machine.
    'drover.allowdeny': ['allow', 'deny'],
    // Claude Code's Edit/Write approval: yes, yes-and-stop-asking, no.
    'drover.allowalwaysdeny': ['allow', 'allow_always', 'deny'],
    // DROVE-198's four, the shape that started this: yes / don't ask again in
    // this directory / switch to auto mode / no. Publishing it as a two-button
    // permission is what discarded the two options Clay actually wants.
    'drover.allowalwaysautodeny': ['allow', 'allow_always', 'auto', 'deny'],
    // A to-do (DROVE-69). Answerable ONLY by naming one of its two buttons.
    'drover.todo': ['done', 'drop'],
    // The terminal approval the pane parser could not read (claude-approval.sh
    // falls back to these two keys, and says so on the card).
    'drover.keys': ['enter', 'esc'],
    // Arbitrary options: numbered, the way the terminal numbers them, with the
    // labels in the body.
    'drover.pick2': ['pick1', 'pick2'],
    'drover.pick3': ['pick1', 'pick2', 'pick3'],
    'drover.pick4': ['pick1', 'pick2', 'pick3', 'pick4'],
    // OVERFLOW. More options than iOS will show: three answer, the fourth
    // opens the app, and the body says how many are not on screen. The banner
    // must never imply the list is complete.
    'drover.pickmore': ['pick1', 'pick2', 'pick3', 'more'],
}

/**
 * The suffix on a category whose ALLOW-shaped buttons demand a passcode or
 * Face ID before they fire.
 *
 * `isAuthenticationRequired` is a property of the ACTION inside the CATEGORY,
 * not of the notification, so it cannot vary gate by gate within one id.
 * Hence two variants of every category that can allow something: the plain one
 * and this. Allowing an `rm -rf` from a locked screen with one tap is not what
 * he asked for; allowing a `git diff` with a passcode every time would make
 * the eyes-free path worse than the app.
 *
 * There is a second, measured reason it is the right lever. The answer is sent
 * with credentials from expo-secure-store, whose default accessibility is
 * "when unlocked" — so an unauthenticated tap from a locked screen would reach
 * the handler and then fail to read the token anyway. Requiring authentication
 * unlocks the device, which is what makes the write possible at all.
 */
export const riskySuffix = '.risky'

/** A to-do's buttons run nothing, so it has no risky twin. */
const noRiskyVariant = new Set(['drover.todo'])

/** Every category identifier the app must register, base and risky. */
export function gateCategoryIds(): string[] {
    const ids: string[] = []
    for (const id of Object.keys(gateCategoryRoles)) {
        ids.push(id)
        if (!noRiskyVariant.has(id)) ids.push(`${id}${riskySuffix}`)
    }
    return ids
}

/** Role sequence -> the category that renders it. */
const verdictCategories = new Map<string, string>(
    Object.entries(gateCategoryRoles)
        .filter(([, roles]) => !roles.some((r) => r.startsWith('pick') || r === 'more'))
        .map(([id, roles]) => [roles.join('.'), id])
)

const allowLike = /^(yes|allow|approve|proceed|continue|ok|okay|run it|go ahead)\b/i
const denyLike = /^(no|deny|don'?t|do not|cancel|reject|stop|abort|never)\b/i
const stopAsking = /don'?t ask again|do not ask again|for this session|for the session|always allow|remember this/i
const autoMode = /auto mode|auto-accept|accept edits|bypass permissions|yolo/i

/**
 * What one option MEANS, from its bus id first and its label second.
 *
 * The id is authoritative where the bus minted it: a permission's injected
 * options are literally `allow`/`deny` and a to-do's are `done`/`drop`
 * (server.js:582, :593). A terminal approval's ids are the digits the pane
 * offers, so those fall through to the label, which is Claude Code's own
 * sentence. Returns null when the option means something this vocabulary has
 * no word for, which sends the whole gate to the numbered fallback.
 */
export function roleForOption(option: DroverOption): GateActionRole | null {
    switch (option.id) {
        case 'allow':
            return 'allow'
        case 'deny':
            return 'deny'
        case 'done':
            return 'done'
        case 'drop':
            return 'drop'
        case 'enter':
            return 'enter'
        case 'esc':
            return 'esc'
    }
    const label = (option.label ?? '').trim()
    if (!label) return null
    if (allowLike.test(label)) {
        // Order matters: "Yes, and switch to auto mode" also matches nothing
        // in stopAsking, and "Yes, and don't ask again for X in Y" matches
        // nothing in autoMode, but a future label could carry both and auto
        // mode is the wider grant, so it wins.
        if (autoMode.test(label)) return 'auto'
        if (stopAsking.test(label)) return 'allow_always'
        return 'allow'
    }
    if (denyLike.test(label)) return 'deny'
    return null
}

/**
 * Commands whose blast radius makes a one-tap allow from a lock screen wrong.
 *
 * Deliberately blunt. A false positive costs one Face ID; a false negative is
 * an `rm -rf` approved by a thumb through a jacket pocket.
 */
const destructiveCommand =
    /\brm\s+-[a-zA-Z]*[rf]|\bsudo\b|--force\b|-f\b\s*$|\bgit\s+push\b[^|]*\bforce|\bgit\s+reset\s+--hard\b|\bDROP\s+(TABLE|DATABASE|SCHEMA)\b|\bTRUNCATE\b|\bmkfs\b|\bdd\s+if=|\bkubectl\s+delete\b|\bterraform\s+(destroy|apply)\b|\bhelm\s+(delete|uninstall)\b|\bshutdown\b|\breboot\b|\bkillall\b|\bchmod\s+777\b|>\s*\/dev\/(sd|disk|nvme)/i

/**
 * Whether this gate's allow-shaped buttons need the device unlocked.
 *
 * Two sources, and the gate name is the stronger one: `ask-destructive-bash`
 * exists precisely because the command it is guarding is destructive, so its
 * own name is a better signal than any regex over the text. The pattern is the
 * safety net for a gate that never declared itself.
 */
export function isRiskyGate(ev: Pick<DroverEvent, 'origin' | 'preview' | 'title' | 'reason'>): boolean {
    const gate = ev.origin?.gate ?? ''
    if (/destructive|overlay-image|secret|credential/i.test(gate)) return true
    const text = `${ev.title ?? ''}\n${ev.reason ?? ''}\n${ev.preview ?? ''}`
    return destructiveCommand.test(text)
}

/** What the push tells iOS to draw, and what each slot answers with. */
export interface GateActionPlan {
    /** `aps.category`. Null means no buttons: the push is tap-to-open as before. */
    categoryId: string | null
    /** The bus option id slot i answers with. Empty string for a slot that answers nothing. */
    optionIds: string[]
    /** How many of the gate's options have a button. */
    shown: number
    /** How many the gate actually has. */
    total: number
    /** True when the banner is not showing every option. */
    overflow: boolean
    /** Whether the risky variant was chosen; see riskySuffix. */
    risky: boolean
}

const noActions: GateActionPlan = {
    categoryId: null,
    optionIds: [],
    shown: 0,
    total: 0,
    overflow: false,
    risky: false,
}

/**
 * The buttons for one bus event.
 *
 * A gate with fewer than two options gets none: one button is not a choice,
 * and the card in the app is where a login code or a free-text answer is
 * typed. An `idle` gate has nothing to answer at all.
 */
export function gateActionsFor(ev: DroverEvent): GateActionPlan {
    const options = ev.options ?? []
    const total = options.length
    if (total < 2) return { ...noActions, total }
    if (ev.kind === 'idle' || ev.kind === 'expiry') return { ...noActions, total }

    const risky = ev.kind === 'todo' ? false : isRiskyGate(ev)
    const withRisk = (id: string) => (risky && !noRiskyVariant.has(id) ? `${id}${riskySuffix}` : id)

    const roles = options.map(roleForOption)
    if (roles.every((role): role is GateActionRole => role !== null)) {
        const categoryId = verdictCategories.get(roles.join('.'))
        if (categoryId) {
            return {
                categoryId: withRisk(categoryId),
                optionIds: options.map((o) => o.id),
                shown: total,
                total,
                overflow: false,
                risky,
            }
        }
    }

    // Numbered fallback. Anything the vocabulary cannot name is still
    // answerable, because a prompt that is merely UNCLASSIFIED must never
    // become a prompt that can only be dismissed — the same rule
    // claude-approval.sh keeps for a dialog it cannot parse.
    if (total > 4) {
        return {
            categoryId: withRisk('drover.pickmore'),
            optionIds: [options[0].id, options[1].id, options[2].id, ''],
            shown: 3,
            total,
            overflow: true,
            risky,
        }
    }
    return {
        categoryId: withRisk(`drover.pick${total}`),
        optionIds: options.map((o) => o.id),
        shown: total,
        total,
        overflow: false,
        risky,
    }
}

/** Whether a plan's buttons are numbered rather than named. */
export function isNumberedPlan(plan: GateActionPlan): boolean {
    return plan.categoryId !== null && plan.categoryId.startsWith('drover.pick')
}

const LEGEND_LABEL_LIMIT = 28

/**
 * The line that makes a numbered banner readable: "1 Blue · 2 Green · 3 Red".
 *
 * Without it "1 2 3" is a row of buttons meaning nothing. With it the banner
 * reads the way the terminal does, which is the shape Clay is already used to
 * answering. Only for numbered plans: a banner whose buttons say Allow and
 * Deny does not need a legend telling it so.
 */
export function legendFor(ev: DroverEvent, plan: GateActionPlan): string {
    if (!isNumberedPlan(plan)) return ''
    const options = ev.options ?? []
    const parts: string[] = []
    for (let slot = 0; slot < plan.shown; slot++) {
        const label = (options[slot]?.label ?? '').trim()
        if (!label) continue
        const short = label.length > LEGEND_LABEL_LIMIT ? `${label.slice(0, LEGEND_LABEL_LIMIT - 1)}…` : label
        parts.push(`${slot + 1} ${short}`)
    }
    return parts.join(' · ')
}

/**
 * What the banner has to admit it is not showing.
 *
 * The rule the ticket states outright: the overflow has to be reachable by
 * opening the app, and the banner must not imply the list is complete. The
 * fourth button opens the app; this is the sentence that says why it is there.
 */
export function overflowNoteFor(plan: GateActionPlan): string {
    if (!plan.overflow) return ''
    return `+${plan.total - plan.shown} more in the app`
}
