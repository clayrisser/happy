/**
 * The worktree sheet's arithmetic (DROVE-330).
 *
 * Two things are pinned. The terminal box fills the screen and no more, so the
 * sheet stops at the cap and the TEXT scrolls rather than the sheet; and the
 * four tab labels fit one segmented control on a handset.
 */
import { describe, expect, it } from 'vitest';

import { composerSheetBody, composerSheetCap } from './composerSheetLayout';
import {
    sheetTabsFit,
    taskRowGap,
    taskRowLineHeight,
    taskRowMaxLines,
    taskRowsHeight,
    terminalBodyHeight,
    terminalMinLines,
    terminalTabContentHeight,
    terminalVisibleLines,
    todosCaptionBlockHeight,
    todosEmptyBlockHeight,
    todosEmptyMinHeight,
    todosEmptySectionHeight,
    todosTabBodyHeight,
} from './worktreeSheetLayout';
import { channelSheetWidth } from './droverChannelsSheetLayout';
import { worktreeSheetTabs } from '../utils/worktreeSheetTabs';

/** iPhone 15 Pro, the handset the screenshots come off. */
const screenWidth = 393;
const phone = { windowHeight: 852, safeAreaTop: 59, safeAreaBottom: 34 };

describe('the terminal box', () => {
    it('fills the screen exactly, so the sheet does not scroll and the text does', () => {
        const content = terminalTabContentHeight(phone);
        expect(content).toBe(composerSheetCap(phone));
        expect(composerSheetBody({ ...phone, contentHeight: content })).toEqual({
            cap: composerSheetCap(phone),
            height: content,
            scrolls: false,
        });
    });

    it('shows a real screenful of lines on a handset', () => {
        // Forty-odd lines is a terminal. Twelve is a status bar.
        expect(terminalVisibleLines(terminalBodyHeight(phone))).toBeGreaterThanOrEqual(36);
    });

    it('never shrinks below the minimum on a small window, even if that means the sheet scrolls', () => {
        const tiny = { ...phone, windowHeight: 300 };
        expect(terminalVisibleLines(terminalBodyHeight(tiny))).toBe(terminalMinLines);
        expect(composerSheetBody({ ...tiny, contentHeight: terminalTabContentHeight(tiny) }).scrolls).toBe(true);
    });

    it('grows with the window rather than stopping at a number somebody picked', () => {
        const tablet = { ...phone, windowHeight: 1194 };
        expect(terminalBodyHeight(tablet)).toBeGreaterThan(terminalBodyHeight(phone));
        expect(terminalTabContentHeight(tablet)).toBe(composerSheetCap(tablet));
    });
});

describe('the tab strip', () => {
    it('fits all four labels on a handset, full width', () => {
        // ComposerSheet is full width (DROVE-147); the inset here is the
        // strip's own 16pt, not the composer's.
        expect(sheetTabsFit(worktreeSheetTabs.map((tab) => tab.label), screenWidth)).toBe(true);
    });

    it('would refuse a label the width of a sentence', () => {
        expect(sheetTabsFit(['Worktrees', 'Things to do', 'Terminal', 'Files'], screenWidth)).toBe(false);
    });

    it('still fits inside a composer-inset sheet, in case one ever hosts it', () => {
        expect(sheetTabsFit(worktreeSheetTabs.map((tab) => tab.label), channelSheetWidth(screenWidth))).toBe(true);
    });
});

describe('the todos tab', () => {
    it('gives two empty sections the whole tab between them, so neither is a line over a black third', () => {
        // The screenshot on DROVE-380: NEEDS YOU over one grey line, TASK LIST
        // over another, and nothing else. Two centred blocks now fill it.
        const each = todosEmptySectionHeight(phone, 2);
        const body = todosTabBodyHeight(phone);
        expect(each * 2 + todosCaptionBlockHeight * 2).toBeLessThanOrEqual(body);
        expect(each * 2 + todosCaptionBlockHeight * 2).toBeGreaterThanOrEqual(body - 2);
        // Room for the glyph AND air around it, not just the glyph.
        expect(each).toBeGreaterThan(todosEmptyBlockHeight * 2);
    });

    it('gives a lone empty section the minimum, because the rows beside it are what he opened', () => {
        expect(todosEmptySectionHeight(phone, 1)).toBe(todosEmptyMinHeight);
        expect(todosEmptySectionHeight(phone, 0)).toBe(0);
    });

    it('never squeezes an empty section below its glyph, however small the window', () => {
        const tiny = { ...phone, windowHeight: 300 };
        expect(todosEmptySectionHeight(tiny, 2)).toBeGreaterThanOrEqual(todosEmptyMinHeight);
        expect(todosEmptySectionHeight(tiny, 2)).toBeGreaterThan(todosEmptyBlockHeight);
    });

    it('grows the empty block with the window rather than stopping at a number somebody picked', () => {
        const tablet = { ...phone, windowHeight: 1194 };
        expect(todosEmptySectionHeight(tablet, 2)).toBeGreaterThan(todosEmptySectionHeight(phone, 2));
    });

    it('measures a task row at one or two lines and never more', () => {
        expect(taskRowsHeight([1])).toBe(taskRowLineHeight);
        expect(taskRowsHeight([2])).toBe(taskRowLineHeight * 2);
        // A task Claude Code wrote as a paragraph still costs two lines.
        expect(taskRowsHeight([9])).toBe(taskRowLineHeight * taskRowMaxLines);
        expect(taskRowsHeight([])).toBe(0);
        expect(taskRowsHeight([1, 1])).toBe(taskRowLineHeight * 2 + taskRowGap);
    });
});
