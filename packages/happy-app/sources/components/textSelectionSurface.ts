/**
 * Which control can actually select a WORD, per platform (DROVE-282).
 *
 * This exists because the obvious answer is wrong. `<Text selectable>` reads
 * like the whole fix and is not one on iOS:
 *
 * - **iOS.** `RCTParagraphComponentView.mm` implements `selectable` as a
 *   `UILongPressGestureRecognizer` that presents a `UIEditMenu` whose only
 *   action is `copy:`, and `copy:` takes `NSMakeRange(0, attributedText.length)`
 *   — the WHOLE paragraph. There are no handles, no magnifier and no partial
 *   range anywhere in that file. A selectable `Text` on iOS is a copy button
 *   with a menu, not a selection.
 * - **Android.** `ReactTextView.setTextIsSelectable(true)` hands the job to
 *   the platform TextView, which is the real thing: long-press selects the
 *   word under the finger, handles extend it, and the action mode carries
 *   Copy / Select all / Share.
 *
 * So the surface that gives iOS the interaction Clay asked for is a
 * `UITextView`, which React Native reaches as a read-only multiline
 * `TextInput`: `RCTTextInputComponentView.mm` maps `editable` straight onto
 * `UITextView.editable`, and a non-editable UITextView is still selectable.
 *
 * That same trick is a dead end on Android, and this is the second thing that
 * was quietly broken: `ReactTextInputManager.setEditable` does
 * `view.isEnabled = editable`, so `editable={false}` DISABLES the EditText.
 * A disabled view takes no touches at all, so the reader could not be
 * selected on Android — not badly, at all.
 *
 * Hence the split. Web is grouped with Android because a browser selects a
 * `<div>` of text with the mouse and gains nothing from an input.
 */
export type SelectionSurface = 'text-input' | 'selectable-text';

export function textSelectionSurface(os: string): SelectionSurface {
    return os === 'ios' ? 'text-input' : 'selectable-text';
}
