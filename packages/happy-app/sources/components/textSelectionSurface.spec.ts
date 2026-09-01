import { describe, expect, it } from 'vitest';
import { textSelectionSurface } from './textSelectionSurface';

/**
 * The two facts this pins are both read out of React Native's own sources, and
 * both are the opposite of what the prop names suggest. They are asserted here
 * so an upgrade that changes either one fails loudly instead of quietly
 * costing Clay the interaction again.
 */
describe('textSelectionSurface', () => {
    /**
     * iOS. `RCTParagraphComponentView.mm` gives `<Text selectable>` a long
     * press that opens a UIEditMenu whose `copy:` takes the whole paragraph.
     * No handles. The UITextView behind a read-only multiline TextInput is the
     * only RN control on iOS that selects a word.
     */
    it('sends iOS to the read-only text input, because a selectable Text there has no handles', () => {
        expect(textSelectionSurface('ios')).toBe('text-input');
    });

    /**
     * Android. `ReactTextView.setTextIsSelectable(true)` is real platform
     * selection, and a TextInput would be WORSE than useless:
     * `ReactTextInputManager.setEditable` maps `editable={false}` onto
     * `isEnabled = false`, and a disabled view takes no touches at all.
     */
    it('keeps Android on selectable text, because editable=false disables the EditText', () => {
        expect(textSelectionSurface('android')).toBe('selectable-text');
    });

    it('groups web with selectable text, where a mouse already does the job', () => {
        expect(textSelectionSurface('web')).toBe('selectable-text');
    });
});
