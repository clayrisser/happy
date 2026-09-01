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
 * IT IS ON THE ROW SINCE DROVE-281, AND IT WAS IN THE LOCK'S SHEET BEFORE
 * THAT. The original reasoning was a real measurement and it is worth keeping
 * because it is what the move had to answer: DROVE-264's budget table left the
 * model segment 22pt at 320, DROVE-266 spent 18 more growing every object
 * 36 -> 39, so a new 39pt control had nothing left in the give-way order to
 * take. The sheet had room and was one tap from where Clay pointed.
 *
 * That was sound and the answer was still wrong, which is the useful thing on
 * the record here. Clay, with the row photographed: "add a button for toggling
 * auto accepting prompts". A posture he changes per session, mid-work, from
 * behind two taps is one he does not change. So DROVE-281 spends the width
 * instead of routing around it — the bolt is a segment of the session capsule
 * and the capsule takes a row of its own on every phone, which is DROVE-264's
 * own named remedy: vertical space, which a phone has.
 *
 * THE SUBTITLE IS STILL WHERE THE SWITCH IS. It could not follow the control
 * onto a 39pt segment, so the sheet's row is KEPT rather than deleted: both
 * drive the same set and cannot disagree, the boundary stays spelled out in
 * the place it was argued for, and the row is the one-tap path. On the segment
 * the same sentence is the accessibility hint.
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
 * What VoiceOver hears on the BOLT, which is the control itself (DROVE-281).
 *
 * The sighted carriers are a hue and a fill, and neither reaches a screen
 * reader, so the state is in the words as well. `accessibilityState.checked`
 * says it too; this says it in the value so it survives a reader that
 * announces the value and not the state.
 */
export function autoAcceptSegmentValue(on: boolean): string {
    return on ? 'On' : 'Off';
}

/**
 * What VoiceOver hears on the padlock.
 *
 * KEPT AFTER DROVE-281 MOVED THE COLOUR OFF IT. The padlock no longer carries
 * the state to the eye, but auto-accept still qualifies what the mode means —
 * "Yolo, auto-accept on" is a different situation from "Yolo" — and the
 * announcement costs nothing on a control the reader is already on. Named
 * after the mode so it stays "Permission mode, Yolo, auto-accept on" rather
 * than losing the mode it is qualifying.
 */
export function permissionAccessibilityValue(
    modeValue: string | undefined,
    autoAccept: boolean,
): string | undefined {
    if (!autoAccept) return modeValue;
    return modeValue ? `${modeValue}, auto-accept on` : 'auto-accept on';
}
