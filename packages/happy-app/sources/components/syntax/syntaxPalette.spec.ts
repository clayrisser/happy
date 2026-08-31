import { describe, expect, it, vi } from 'vitest';

// theme.ts reaches for Platform.select and react-native's entry point is Flow
// source vitest cannot parse. The phone is what the palette is for, so ios.
vi.mock('react-native', () => ({
    Platform: {
        OS: 'ios',
        select: (options: Record<string, unknown>) => options.ios ?? options.native ?? options.default,
    },
}));

import { darkTheme, lightTheme } from '@/theme';
import { colorDistance, contrastRatio } from '@/utils/subagentTint';

/**
 * The syntax palette, measured (DROVE-159).
 *
 * "Legible" is not a matter of taste when the numbers are available, so they
 * are asserted here. Three things are checked, and the second and third are
 * what the ticket asked for.
 */
describe('the syntax palette', () => {
    /** WCAG AA for body text. Code IS body text, so this is the floor. */
    const bodyTextContrast = 4.5;

    /**
     * Every ground a palette is drawn on. The light one is only ever the light
     * theme's code blocks; the dark one has to survive the darkest terminal and
     * the lightest code block at once.
     */
    const grounds = {
        light: [
            lightTheme.colors.surfaceHighest, // markdown code block
            lightTheme.colors.surfaceHigh, // CodeView, on the tool detail screens
        ],
        dark: [
            darkTheme.colors.surfaceHighest,
            darkTheme.colors.surfaceHigh,
            darkTheme.colors.terminal.background,
            lightTheme.colors.terminal.background,
        ],
    };

    const palettes = [
        ['light', lightTheme.colors.syntax, grounds.light],
        ['dark', darkTheme.colors.syntax, grounds.dark],
        // The terminal card is black in both themes, so its palette has to
        // clear the dark grounds whichever theme is showing.
        ['light terminal', lightTheme.colors.terminal.syntax, grounds.dark],
        ['dark terminal', darkTheme.colors.terminal.syntax, grounds.dark],
    ] as const;

    it.each(palettes)('is legible on every ground it is drawn on (%s)', (_name, palette, backgrounds) => {
        for (const [role, colour] of Object.entries(palette)) {
            for (const ground of backgrounds) {
                expect(
                    contrastRatio(colour, ground),
                    `${role} ${colour} on ${ground}`,
                ).toBeGreaterThanOrEqual(bodyTextContrast);
            }
        }
    });

    /**
     * The read-aloud mark (DROVE-125) is a text colour on prose. It cannot
     * land inside a code block or a terminal card, because MarkdownView only
     * passes the sentence to text and header blocks and CommandView is a
     * different tree entirely. So the bar here is not sentenceHighlight's 0.25,
     * which is for colours sharing one run of text; it is "not confusable
     * across surfaces", a block of code beside a marked paragraph.
     */
    const distinctFromMark = 0.2;

    /**
     * The diff view's two signals. Its backgrounds and inline word highlights
     * are not in here on purpose: they only ever appear inside the diff, on
     * their own grounds. These two are what a colour could be mistaken for.
     */
    const diffSignals = (theme: typeof lightTheme) => [
        theme.colors.diff.addedBorder,
        theme.colors.diff.removedBorder,
    ];
    const distinctFromDiff = 0.15;

    it.each([
        ['light', lightTheme.colors.syntax, lightTheme],
        ['dark', darkTheme.colors.syntax, darkTheme],
        ['terminal', darkTheme.colors.terminal.syntax, darkTheme],
    ] as const)('does not collide with the reading mark or a diff signal (%s)', (_name, palette, theme) => {
        for (const [role, colour] of Object.entries(palette)) {
            expect(
                colorDistance(colour, theme.colors.spokenSentence),
                `${role} ${colour} vs the reading mark`,
            ).toBeGreaterThanOrEqual(distinctFromMark);
            for (const signal of diffSignals(theme)) {
                expect(
                    colorDistance(colour, signal),
                    `${role} ${colour} vs diff ${signal}`,
                ).toBeGreaterThanOrEqual(distinctFromDiff);
            }
        }
    });

    /**
     * The four roles that carry a skim. Whatever else blurs together, a
     * comment must not read as a string and a keyword must not read as either,
     * or the highlighting has cost a repaint and bought nothing.
     */
    it.each([
        ['light', lightTheme.colors.syntax],
        ['dark', darkTheme.colors.syntax],
    ] as const)('keeps the roles that carry a skim apart (%s)', (_name, palette) => {
        const skim = ['plain', 'keyword', 'string', 'comment'] as const;
        for (let i = 0; i < skim.length; i++) {
            for (let j = i + 1; j < skim.length; j++) {
                expect(
                    colorDistance(palette[skim[i]], palette[skim[j]]),
                    `${skim[i]} vs ${skim[j]}`,
                ).toBeGreaterThanOrEqual(0.15);
            }
        }
    });

    it('gives the terminal the dark set in both themes, because the card is black in both', () => {
        expect(lightTheme.colors.terminal.background).toBe(darkTheme.colors.terminal.background);
        expect(lightTheme.colors.terminal.syntax).toEqual(darkTheme.colors.syntax);
        expect(darkTheme.colors.terminal.syntax).toEqual(darkTheme.colors.syntax);
    });

    it('names the same roles in both themes', () => {
        expect(Object.keys(lightTheme.colors.syntax).sort()).toEqual(
            Object.keys(darkTheme.colors.syntax).sort(),
        );
    });
});
