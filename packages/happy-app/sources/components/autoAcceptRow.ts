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
 * ONE FRAGMENT, because the rows under it are fragments (DROVE-346). Clay, with
 * the sheet photographed: the handcrafted modes read "asks when unsure", "edits,
 * no asking", "plan first", and this toggle answered them with three sentences.
 * A paragraph sitting on top of a fragment list is what he scribbled out.
 *
 * What survives the cut is the promise the classifier keeps — prompts yes,
 * questions no — because that is the half a surprise would be reported against.
 * The session scope and the reset on restart are real and are not said here:
 * both fail SAFE, so a reader who does not know them is never over-trusting.
 */
export const AUTO_ACCEPT_SUBTITLE = 'allows prompts, not questions';

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
