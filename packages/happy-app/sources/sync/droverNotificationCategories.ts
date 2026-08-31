/**
 * The buttons a gate push draws on the banner (DROVE-207).
 *
 * Clay: "Notification, instead of just dismiss shouldn't you have the option
 * for me to select the answer from the push notification."
 *
 * iOS draws a push's buttons from a `UNNotificationCategory` the APP has
 * registered, named by `aps.category` on the payload, and the button titles
 * are fixed at registration. A gate's options are not knowable then — the
 * four-option Bash approval from DROVE-198 names the exact command and
 * directory in a label — so this is a CLOSED vocabulary registered up front,
 * and the CLI picks which shape of it each gate is.
 *
 * The slot is positional. Button i carries the identifier `drover.act.<i>` and
 * answers with `data.actions[i]`, the real bus option id, so no label text is
 * ever matched back to an option and the two halves cannot disagree about what
 * a button meant.
 *
 * MIRROR OF happy-cli's `src/drover/gateActions.ts`. Every identifier here
 * must exist there and vice versa: a push naming a category this app never
 * registered shows no buttons at all, silently, with no error on either side.
 * A spec on each side pins the same literal list. They are not shared through
 * a package because that would put a build step between the CLI and the phone
 * for a table of strings.
 *
 * This file is PURE on purpose — no expo-notifications import — so it loads in
 * a spec and in a headless background launch alike. Registration lives in
 * droverNotificationActions.ts.
 */

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
    | 'more';

/** Every category, and its roles in button order. Mirrors gateCategoryRoles. */
export const gateCategoryRoles: Record<string, GateActionRole[]> = {
    'drover.allowdeny': ['allow', 'deny'],
    'drover.allowalwaysdeny': ['allow', 'allow_always', 'deny'],
    'drover.allowalwaysautodeny': ['allow', 'allow_always', 'auto', 'deny'],
    'drover.todo': ['done', 'drop'],
    'drover.keys': ['enter', 'esc'],
    'drover.pick2': ['pick1', 'pick2'],
    'drover.pick3': ['pick1', 'pick2', 'pick3'],
    'drover.pick4': ['pick1', 'pick2', 'pick3', 'pick4'],
    'drover.pickmore': ['pick1', 'pick2', 'pick3', 'more'],
};

export const riskySuffix = '.risky';

/** A to-do's buttons run nothing, so it has no risky twin. */
const noRiskyVariant = new Set(['drover.todo']);

/**
 * What each button says.
 *
 * Generic where the gate's own text cannot be used, and truthful about the
 * grant rather than about the wording: "Allow, don't ask again" is what
 * "Yes, and don't ask again for `tmux capture-pane` commands in /Users/..."
 * MEANS, and the sentence itself is in the body two lines above the button.
 *
 * The numbered titles are the terminal's own numbering. On its own "1" is a
 * button meaning nothing, which is why the CLI puts the legend
 * ("1 Blue · 2 Green") in the push body for exactly these categories.
 */
export const gateActionTitles: Record<GateActionRole, string> = {
    allow: 'Allow',
    allow_always: "Allow, don't ask again",
    auto: 'Allow, auto mode',
    deny: 'Deny',
    done: 'Done',
    drop: 'Drop it',
    enter: 'Press Enter',
    esc: 'Press Esc',
    pick1: '1',
    pick2: '2',
    pick3: '3',
    pick4: '4',
    more: 'More in the app',
};

/**
 * The roles that GRANT something, so a risky gate can put an unlock in front
 * of them.
 *
 * `more` is not one: it opens the app and answers nothing. `deny`, `esc` and
 * `drop` are not: refusing is always allowed to be one tap, because the cost
 * of a stray refusal is asking again and the cost of a stray allow is whatever
 * the command does.
 */
const grantingRoles = new Set<GateActionRole>([
    'allow',
    'allow_always',
    'auto',
    'enter',
    'pick1',
    'pick2',
    'pick3',
    'pick4',
]);

/**
 * DESTRUCTIVE, which on iOS means the title is drawn in red.
 *
 * Only the two that DISCARD something: dropping a to-do deletes the record,
 * and Esc cancels the dialog the terminal is holding. Deny is deliberately
 * NOT here, though the eye expects red. Red on the SAFE choice teaches exactly
 * the wrong reflex on a lock screen, and Apple's own prompts agree: "Don't
 * Allow" is plain, "Delete" is red. The dangerous button on a gate is Allow,
 * and the lever for that one is the unlock below, not a colour.
 */
const destructiveRoles = new Set<GateActionRole>(['drop', 'esc']);

/**
 * ALWAYS behind an unlock, whatever the command is.
 *
 * Both of these are DURABLE grants: "don't ask again in this directory" and
 * "switch to auto mode" change what happens to every future gate, not just
 * this one. Auto mode in particular disarms the whole layer. A pocket tap must
 * not be able to do that, however harmless the command in front of it.
 */
const alwaysAuthenticated = new Set<GateActionRole>(['allow_always', 'auto']);

export interface GateNotificationAction {
    identifier: string;
    buttonTitle: string;
    options: {
        isDestructive: boolean;
        isAuthenticationRequired: boolean;
        opensAppToForeground: boolean;
    };
}

export interface GateNotificationCategory {
    identifier: string;
    actions: GateNotificationAction[];
}

/** The action identifier for button slot i, and the one that opens the app. */
export const actionIdentifierPrefix = 'drover.act.';
export const moreActionIdentifier = 'drover.act.more';

export function actionIdentifierForSlot(slot: number): string {
    return `${actionIdentifierPrefix}${slot}`;
}

/**
 * Which button slot an action identifier names, or null when it is not one of
 * ours (the system default open, a dismiss, the More button).
 */
export function slotForActionIdentifier(identifier: unknown): number | null {
    if (typeof identifier !== 'string') return null;
    if (!identifier.startsWith(actionIdentifierPrefix)) return null;
    const tail = identifier.slice(actionIdentifierPrefix.length);
    if (!/^\d+$/.test(tail)) return null;
    return Number(tail);
}

function actionFor(role: GateActionRole, slot: number, risky: boolean): GateNotificationAction {
    const opensApp = role === 'more';
    return {
        identifier: opensApp ? moreActionIdentifier : actionIdentifierForSlot(slot),
        buttonTitle: gateActionTitles[role],
        options: {
            isDestructive: destructiveRoles.has(role),
            isAuthenticationRequired:
                alwaysAuthenticated.has(role) || (risky && grantingRoles.has(role)),
            // Every answering button is handled in the BACKGROUND. Bringing
            // the app forward to write one answer is the thing this ticket
            // exists to remove. `more` is the exception, because reaching the
            // options the banner could not show IS opening the app.
            opensAppToForeground: opensApp,
        },
    };
}

/** Every category this app registers, base and risky, in registration order. */
export function gateNotificationCategories(): GateNotificationCategory[] {
    const out: GateNotificationCategory[] = [];
    for (const [id, roles] of Object.entries(gateCategoryRoles)) {
        out.push({ identifier: id, actions: roles.map((role, slot) => actionFor(role, slot, false)) });
        if (noRiskyVariant.has(id)) continue;
        out.push({
            identifier: `${id}${riskySuffix}`,
            actions: roles.map((role, slot) => actionFor(role, slot, true)),
        });
    }
    return out;
}

/** Just the identifiers, for the spec that pins them against the CLI's. */
export function gateCategoryIds(): string[] {
    return gateNotificationCategories().map((c) => c.identifier);
}
