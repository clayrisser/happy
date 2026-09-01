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
 * IT IS IN THE LOCK'S SHEET, AND THAT IS THE ONE PLACE IT IS (DROVE-331).
 * DROVE-277 put it there on a real measurement: DROVE-264's budget table left
 * the model segment 22pt at 320, DROVE-266 spent 18 more growing every object
 * 36 -> 39, so a new 39pt control had nothing left in the give-way order to
 * take. The sheet had room and was one tap from where Clay pointed.
 *
 * DROVE-281 then spent the width anyway. Clay, with the row photographed:
 * "add a button for toggling auto accepting prompts" — so a bolt went on the
 * session capsule beside the padlock, and this row was KEPT rather than
 * deleted, because the boundary wording could not follow the control onto a
 * 39pt segment. Two controls for one bit, writing through one setter. Clay,
 * with both on his phone: "because of the toggles in the sheet for
 * auto-accept, we don't need it also in the bar group." So the bolt is gone
 * and this row is the control. The padlock on the row still wears the state
 * in colour (`autoAcceptColour`) and still says it in words
 * (`permissionAccessibilityValue`), and it is the one tap that opens this
 * sheet.
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
 * The padlock wears the state in colour (DROVE-277; off it for DROVE-281's
 * bolt; back since DROVE-331), and colour reaches no screen reader, so it says
 * it in words as well: "Yolo, auto-accept on" is a different situation from
 * "Yolo", and the announcement costs nothing on a control the reader is
 * already on. Named after the mode so it stays "Permission mode, Yolo,
 * auto-accept on" rather than losing the mode it is qualifying.
 */
export function permissionAccessibilityValue(
    modeValue: string | undefined,
    autoAccept: boolean,
): string | undefined {
    if (!autoAccept) return modeValue;
    return modeValue ? `${modeValue}, auto-accept on` : 'auto-accept on';
}
