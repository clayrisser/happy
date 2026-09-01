/**
 * What the auto-accept switch SAYS, in the lock's sheet and to a screen reader
 * (DROVE-277).
 *
 * Pure, and separate from the switch itself, because the wording is the safety
 * feature. A control that answers permission prompts for you has to say
 * exactly what it will and will not answer, in the place you turn it on, or
 * the first surprise is a command you did not approve. So the subtitle names
 * the boundary rather than selling the feature, and it names the two halves
 * the classifier actually keeps apart.
 *
 * IT LIVES IN THE LOCK'S SHEET, and that is a decision with a measurement
 * behind it. Clay asked for the toggle "next to the microphone or next to the
 * model or the effort button" — which is where the padlock already is. It
 * cannot be a fourth control on that row: DROVE-264's budget table leaves the
 * model segment 22pt at 320 and DROVE-266 spent 18 more growing every object
 * 36 -> 39, so a new 39pt disc would push the row past its rim on the two
 * narrowest phones with nothing left in the give-way order to spend (the last
 * step, the capsule taking its own row, has already fired at both widths).
 * The sheet behind the padlock has room, is one tap from where he pointed, and
 * is where the app already keeps the rest of its permission vocabulary.
 */

/** Ionicons name for the row. A bolt: it goes through without stopping. */
export const AUTO_ACCEPT_GLYPH = 'flash-outline';
export const AUTO_ACCEPT_GLYPH_ON = 'flash';

export const AUTO_ACCEPT_TITLE = 'Auto-accept';

/**
 * The boundary, in the place the switch is thrown.
 *
 * Two sentences, and the second is the one that matters: it is the promise the
 * classifier keeps, so a question, a login code or a to-do arriving while this
 * is on is expected behaviour rather than a bug report.
 */
export const AUTO_ACCEPT_SUBTITLE =
    'Answers Allow / Deny prompts in this session with Allow. Questions, logins and to-dos still ask. Off again when the app restarts.';

/** The sheet row's glyph, so the switch's own state reads without the switch. */
export function autoAcceptGlyph(on: boolean): typeof AUTO_ACCEPT_GLYPH | typeof AUTO_ACCEPT_GLYPH_ON {
    return on ? AUTO_ACCEPT_GLYPH_ON : AUTO_ACCEPT_GLYPH;
}

/**
 * What VoiceOver hears on the padlock.
 *
 * The colour is the sighted carrier and it is the only one on that 39pt
 * control, so the state has to be in the words too — this is the half of
 * "visibly wears it" that does not depend on seeing a hue. Named after the
 * mode so the announcement stays "Permission mode, Yolo, auto-accept on"
 * rather than losing the mode it is qualifying.
 */
export function permissionAccessibilityValue(
    modeValue: string | undefined,
    autoAccept: boolean,
): string | undefined {
    if (!autoAccept) return modeValue;
    return modeValue ? `${modeValue}, auto-accept on` : 'auto-accept on';
}
