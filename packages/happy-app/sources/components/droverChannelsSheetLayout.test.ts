/**
 * The channel sheet's arithmetic (DROVE-123).
 *
 * Two faults on one screenshot. The sheet showed only two of the four modes,
 * and the audio row read `Speak prompts when th...`, cut mid word, while
 * `Read replies aloud` under it fitted. Both are measurable, so they are
 * pinned here rather than left to the next screenshot.
 */
import { describe, expect, it } from 'vitest';

import {
    channelSheetContentHeight,
    channelSheetWidth,
    modesVisibleWithoutScrolling,
    sheetTitleColumnWidth,
    sheetTitleFitsOneLine,
    sheetTitleLines,
} from './droverChannelsSheetLayout';
import { composerSheetBody, composerSheetCap } from './composerSheetLayout';
import { en } from '../text/translations/en';

/** iPhone 15 Pro, the handset the screenshot came off. */
const screenWidth = 393;
const screenHeight = 852;

/** That handset's notch and home indicator. */
const phone = { windowHeight: screenHeight, safeAreaTop: 59, safeAreaBottom: 34 };

describe('channel sheet height', () => {
    it('fits on a handset without scrolling at all, now the cap is the screen', () => {
        const content = channelSheetContentHeight({ modes: 4, toggleSections: [2, 2] });
        expect(composerSheetBody({ ...phone, contentHeight: content })).toEqual({
            cap: composerSheetCap(phone),
            height: content,
            scrolls: false,
        });
    });

    it('shows all four modes before the first scroll', () => {
        expect(modesVisibleWithoutScrolling({
            modes: 4,
            maxHeight: composerSheetCap(phone),
        })).toBe(true);
    });

    it('still shows all four modes on the smallest window the sheet is drawn on', () => {
        expect(modesVisibleWithoutScrolling({
            modes: 4,
            maxHeight: composerSheetCap({ ...phone, windowHeight: 480 }),
        })).toBe(true);
    });

    it('scrolls only once the sections outgrow the screen', () => {
        const content = channelSheetContentHeight({ modes: 4, toggleSections: [2, 2, 2, 2, 2, 2] });
        expect(composerSheetBody({ ...phone, contentHeight: content }).scrolls).toBe(true);
    });

    it('grows a section at a time, not a row at a time', () => {
        const two = channelSheetContentHeight({ modes: 4, toggleSections: [2, 2] });
        const three = channelSheetContentHeight({ modes: 4, toggleSections: [2, 2, 2] });
        expect(three - two).toBe(2 * 48 + 24 + 16);
    });
});

describe('audio row labels', () => {
    const sheetWidth = channelSheetWidth(screenWidth);

    it('leaves 226pt for the label once the row furniture is off', () => {
        expect(sheetTitleColumnWidth(sheetWidth)).toBe(226);
    });

    it('reproduces the truncation on the old label', () => {
        expect(sheetTitleFitsOneLine('Speak prompts when they arrive', sheetWidth)).toBe(false);
    });

    it('fits the shortened one', () => {
        expect(sheetTitleFitsOneLine(en.agentInput.channels.speakPrompts, sheetWidth)).toBe(true);
        expect(en.agentInput.channels.speakPrompts).toBe('Speak prompts on arrival');
    });

    it('leaves the row that already fitted alone', () => {
        expect(en.agentInput.channels.readReplies).toBe('Read replies aloud');
        expect(sheetTitleFitsOneLine(en.agentInput.channels.readReplies, sheetWidth)).toBe(true);
    });

    it('fits on the narrowest handset the app still draws a sheet on', () => {
        expect(sheetTitleFitsOneLine(
            en.agentInput.channels.speakPrompts,
            channelSheetWidth(320),
        )).toBe(false);
        // Which is what the two-line net is for.
        expect(sheetTitleLines).toBe(2);
    });
});
