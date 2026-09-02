/**
 * THE HOME COMPOSER'S COLUMN FITS THE SHELL IT IS PINNED TO (DROVE-375).
 *
 * Clay, on the sheet that opens from the home dock — monitor, folder, No
 * worktree, Cursor: "this input is not matching the other ones, and when I tap
 * submit nothing happens."
 *
 * Send was not disabled and the start path was not refusing. The button row was
 * DRAWN OUTSIDE THE BUBBLE. `renderFocusedComposer` pins the shell to
 * `resolveMobileHomeComposerHeight`, which budgets
 * `resolveMobileComposerTextRowHeight` for the field — a floor of
 * `MOBILE_COMPOSER_TEXT_ROW_BASE_HEIGHT`, 30. The field asked for
 * `MOBILE_COMPOSER_METRICS.inputMinHeight`, 44, the number the chat stopped
 * using when DROVE-214 gave the bubble a button row. DROVE-345 wrote
 * `resolveMobileHomeFieldHeight` for exactly this call site and Home never
 * adopted it, so one column had two floors and overran its own shell by 14pt.
 *
 * Nothing in the composer is clipped on Liquid Glass (DROVE-202, DROVE-328), so
 * it still drew — the `+` and the padlock cut by the bubble's rounded bottom
 * edge in Clay's photograph. And UIKit hit-tests a subview against its parent's
 * BOUNDS, so a row drawn past them takes no touches at all. "Nothing happens"
 * was send painted where it could not be pressed.
 *
 * So this holds the arithmetic rather than any one pixel: whatever the field
 * resolves to, the column it sits in equals the height the shell is pinned to.
 * A second floor anywhere in that column fails here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
    MOBILE_COMPOSER_BUBBLE_ACTION_ROW_HEIGHT,
    MOBILE_COMPOSER_METRICS,
    MOBILE_COMPOSER_TEXT_ROW_BASE_HEIGHT,
    resolveMobileHomeComposerHeight,
    resolveMobileHomeFieldHeight,
} from './agentInputLayout';

const homeDock = () => readFileSync(join(__dirname, 'HomeDock.tsx'), 'utf8');

/**
 * The text heights a real field reports: empty (one line), a wrapped line, a
 * paragraph, and past the ceiling `resolveMultiTextInputLayout` clamps to.
 */
const textHeights = [
    MOBILE_COMPOSER_METRICS.inputLineHeight,
    MOBILE_COMPOSER_METRICS.inputLineHeight * 2,
    MOBILE_COMPOSER_METRICS.inputLineHeight * 5,
    MOBILE_COMPOSER_METRICS.inputMaxHeight,
    MOBILE_COMPOSER_METRICS.inputMaxHeight * 2,
];

describe('Home’s focused composer fits inside its own shell (DROVE-375)', () => {
    it('has one floor for the field, and it is the bubble’s', () => {
        // The premise. If these two were equal the fault could not have
        // happened and the rest of this file would be checking nothing.
        expect(MOBILE_COMPOSER_METRICS.inputMinHeight)
            .not.toBe(MOBILE_COMPOSER_TEXT_ROW_BASE_HEIGHT);
        expect(resolveMobileHomeFieldHeight(MOBILE_COMPOSER_METRICS.inputLineHeight))
            .toBe(MOBILE_COMPOSER_TEXT_ROW_BASE_HEIGHT);
    });

    it('leaves the button row inside the bubble at every field height', () => {
        for (const inputHeight of textHeights) {
            const column = MOBILE_COMPOSER_METRICS.bubbleInset
                + resolveMobileHomeFieldHeight(inputHeight)
                + MOBILE_COMPOSER_METRICS.controlGap
                + MOBILE_COMPOSER_BUBBLE_ACTION_ROW_HEIGHT
                + MOBILE_COMPOSER_METRICS.bubbleInsetBottom;
            expect(column, `field ${inputHeight}`)
                .toBe(resolveMobileHomeComposerHeight(inputHeight));
        }
    });

    it('counts the attachment strip once, on the shell and the field alike', () => {
        const inputHeight = MOBILE_COMPOSER_METRICS.inputLineHeight;
        // The strip is a third row in the same column, so it costs its own
        // height AND the column's gap. Home mounts it through the bubble's
        // `above` slot and the shell's resolver already carries it, so the
        // FIELD must not carry it a second time — that would push the row out
        // again the moment an image is attached.
        expect(resolveMobileHomeComposerHeight(inputHeight, true)
            - resolveMobileHomeComposerHeight(inputHeight))
            .toBe(MOBILE_COMPOSER_METRICS.attachmentExtraHeight
                + MOBILE_COMPOSER_METRICS.controlGap);
    });

    /**
     * A source scan for the same reason `composerParity.test.ts` is one: the
     * failure is a call site quietly writing its own arithmetic, which no
     * resolver can see. `inputMinHeight` is the chat's retired floor, and the
     * focused field reaching for it is exactly how the two ends disagreed.
     */
    it('takes Home’s field height from the resolver, not from a floor of its own', () => {
        const source = homeDock();
        expect(source).toContain('resolveMobileHomeFieldHeight(focusedInputLayout.height)');
        expect(source).not.toContain('MOBILE_COMPOSER_METRICS.inputMinHeight');
    });
});
