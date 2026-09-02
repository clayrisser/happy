import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
    frameBottom,
    framesOverlap,
    overlappingFrames,
    sheetHeaderFrames,
    sheetHeaderHeight,
    sheetHeaderRhythm,
    sheetHeaders,
    sheetSectionPadding,
    sheetSectionRhythm,
    sheetSections,
    sheetSectionTitleHeight,
    sheetSectionTitleInset,
    stackFrames,
    type SheetFrame,
} from './sheetHeaderLayout';
import { channelSheetRowHeight } from './droverChannelsSheetLayout';
import {
    sheetTabsBlockHeight,
    sheetTabsHeight,
    sheetTabsInset,
    worktreeSheetHeaderHeight,
} from './worktreeSheetLayout';

/**
 * The guard for DROVE-376: the tab control drawn ON the worktrees sheet's
 * subtitle, and the hand-spaced headers that made it possible.
 *
 * Everything here resolves its boxes from the layout functions rather than
 * from a screenshot, so the assertion is the one the picture was evidence for:
 * NO TWO BOXES SHARE VERTICAL SPACE, and every sheet is drawn on the same
 * rhythm. The source scans below fail both ways, the way `nativeControls.test`
 * does -- a registered file that stops importing the rhythm fails, and so does
 * one that re-states a header metric locally.
 */

const sourcesRoot = resolve(__dirname, '..');
const read = (source: string) => readFileSync(resolve(sourcesRoot, source), 'utf8');

/** A marker counts where it is CODE. These files carry long rule comments. */
function codeLines(source: string): string[] {
    return source.split('\n').filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
    });
}

describe('the header rhythm', () => {
    it('adds up to the height a header block is given', () => {
        const { top, titleLine, gap, subtitleLine, bottom } = sheetHeaderRhythm;
        expect(sheetHeaderHeight({ subtitle: true }))
            .toBe(top + titleLine + gap + subtitleLine + bottom);
        expect(sheetHeaderHeight({ subtitle: false })).toBe(top + titleLine + bottom);
    });

    it('declares a line height for every font size, which is the bug in one line', () => {
        // 15pt SF leads at 17.9 and 12pt at 14.3. A module that says 18 and 16
        // while the component says nothing is a module describing a header it
        // is not drawing.
        expect(sheetHeaderRhythm.titleLine).toBeGreaterThanOrEqual(sheetHeaderRhythm.titleSize * 1.18);
        expect(sheetHeaderRhythm.subtitleLine).toBeGreaterThanOrEqual(sheetHeaderRhythm.subtitleSize * 1.18);
    });

    it('leaves clear air under the subtitle, inside the header block', () => {
        const [title, subtitle] = sheetHeaderFrames({ subtitle: true });
        expect(framesOverlap(title, subtitle)).toBe(false);
        expect(frameBottom(subtitle))
            .toBe(sheetHeaderHeight({ subtitle: true }) - sheetHeaderRhythm.bottom);
        expect(sheetHeaderRhythm.bottom).toBeGreaterThan(0);
    });

    it('owns the gap in ONE place, so a block under a header adds no top inset', () => {
        // The whole defect: 8pt of header padding plus 2pt of strip padding is
        // one gap with two owners, and the render lost both.
        expect(sheetTabsInset.top).toBe(0);
    });
});

describe('the worktrees sheet, which is the one in the screenshot', () => {
    const blocks = { subtitle: true };
    const header = { key: 'header', height: worktreeSheetHeaderHeight };
    const tabs = { key: 'tabs', height: sheetTabsBlockHeight };
    const stacked = stackFrames([header, tabs]);

    /** Every box the sheet paints above its rows, in the sheet body's own space. */
    const painted: SheetFrame[] = [
        ...sheetHeaderFrames(blocks),
        {
            key: 'control',
            top: stacked[1].top + sheetTabsInset.top,
            height: sheetTabsHeight,
        },
    ];

    it('draws the header at the height the module computes', () => {
        expect(worktreeSheetHeaderHeight).toBe(sheetHeaderHeight(blocks));
    });

    it('never paints the tab control over the subtitle', () => {
        expect(overlappingFrames(painted)).toEqual([]);
    });

    it('keeps the whole rhythm gap between the subtitle and the control', () => {
        const subtitle = painted.find((frame) => frame.key === 'subtitle')!;
        const control = painted.find((frame) => frame.key === 'control')!;
        expect(control.top - frameBottom(subtitle)).toBe(sheetHeaderRhythm.bottom);
    });

    it('spends the same room on header and tabs as it did before the fix', () => {
        // 46 + 44 became 48 + 42. This moves a gap; it does not add air, and
        // copy density is not this lane's to change.
        expect(worktreeSheetHeaderHeight + sheetTabsBlockHeight).toBe(90);
    });

    it('gives the tab strip a block that reserves the control plus its inset', () => {
        expect(sheetTabsBlockHeight).toBe(sheetTabsHeight + sheetTabsInset.top + sheetTabsInset.bottom);
    });
});

describe('every registered sheet header', () => {
    it('has at least the sheet the screenshot came from', () => {
        expect(sheetHeaders.map((site) => site.source)).toContain('components/WorktreeSheet.tsx');
    });

    it.each(sheetHeaders)('$source draws a header on the shared rhythm', (site) => {
        const source = read(site.source);
        expect(source).toContain('sheetHeaderRhythm');
        expect(source).toMatch(/styles\.header|style=\{styles\.header\}|header:\s*\{/);
    });

    it.each(sheetHeaders)('$source states no header metric of its own', (site) => {
        const lines = codeLines(read(site.source));
        // A header block that re-states a size or a line height is a second
        // rhythm, which is exactly what let the sheets drift apart.
        const header = lines.join('\n').match(/header:\s*\{[^}]*\}/s)?.[0] ?? '';
        expect(header).not.toMatch(/padding(Top|Bottom|Horizontal)?:\s*\d/);
        expect(header).not.toMatch(/height:\s*\d/);
    });

    it.each(sheetHeaders)('$source uses no negative margin as spacing', (site) => {
        const lines = codeLines(read(site.source));
        const offenders = lines.filter((line) => /margin(Top|Bottom|Left|Right|Vertical|Horizontal)?:\s*-/.test(line));
        expect(offenders).toEqual([]);
    });

    it('resolves every sheet to the same header height for the same blocks', () => {
        const heights = new Set(sheetHeaders.map((site) => sheetHeaderHeight(site.blocks)));
        const withSubtitle = sheetHeaders.filter((site) => site.blocks.subtitle);
        // Two heights at most, and only because a header without a subtitle is
        // genuinely shorter. Never two heights for the same shape.
        expect(heights.size).toBeLessThanOrEqual(2);
        for (const site of withSubtitle) {
            expect(sheetHeaderHeight(site.blocks)).toBe(sheetHeaderHeight({ subtitle: true }));
        }
    });
});

describe('every registered section title', () => {
    it('shares a left edge with the rows it heads', () => {
        // The 8pt misalignment, stated as arithmetic rather than a literal.
        expect(sheetSectionTitleInset)
            .toBe(sheetSectionRhythm.cardInset + sheetSectionRhythm.cardPadding);
        expect(sheetSectionTitleInset).toBeGreaterThan(sheetSectionRhythm.cardPadding);
    });

    it('leaves a real gap before the first row', () => {
        expect(sheetSectionRhythm.gap).toBeGreaterThanOrEqual(8);
        expect(sheetSectionTitleHeight).toBe(sheetSectionRhythm.titleLine + sheetSectionRhythm.gap);
    });

    it('is the height the channel sheet\'s module claims, now that it is drawn', () => {
        expect(channelSheetRowHeight.sectionTitle).toBe(sheetSectionTitleHeight);
        expect(channelSheetRowHeight.sectionPadding).toBe(sheetSectionPadding);
        expect(sheetSectionPadding).toBe(sheetSectionRhythm.top + sheetSectionRhythm.bottom);
    });

    it('never collides with the first row under it', () => {
        const frames = stackFrames([
            { key: 'sectionTop', height: sheetSectionRhythm.top },
            { key: 'sectionTitle', height: sheetSectionTitleHeight },
            { key: 'firstRow', height: channelSheetRowHeight.mode },
        ]);
        expect(overlappingFrames(frames)).toEqual([]);
    });

    it.each(sheetSections)('$source draws its section on the shared rhythm', (site) => {
        const source = read(site.source);
        expect(source).toContain('sheetSectionRhythm');
        expect(source).toContain('sheetSectionTitleInset');
        expect(source).toContain(site.titleStyle);
    });

    it.each(sheetSections)('$source states no section metric of its own', (site) => {
        const lines = codeLines(read(site.source)).join('\n');
        const block = new RegExp(`${site.titleStyle}:\\s*\\{[^}]*\\}`, 's').exec(lines)?.[0] ?? '';
        expect(block).not.toBe('');
        expect(block).not.toMatch(/fontSize:\s*\d/);
        expect(block).not.toMatch(/lineHeight:\s*\d/);
        expect(block).not.toMatch(/padding(Top|Bottom|Horizontal)?:\s*\d/);
    });
});

describe('the frame helpers themselves', () => {
    it('calls touching boxes clear and shared space a clash', () => {
        const a = { key: 'a', top: 0, height: 10 };
        const b = { key: 'b', top: 10, height: 10 };
        // One point up from `b` is the shape of the bug: a block that starts
        // inside the one above it AND runs into the one below.
        const c = { key: 'c', top: 9, height: 10 };
        expect(framesOverlap(a, b)).toBe(false);
        expect(framesOverlap(a, c)).toBe(true);
        expect(framesOverlap(b, c)).toBe(true);
        expect(overlappingFrames([a, b])).toEqual([]);
        expect(overlappingFrames([a, b, c]).map(([x, y]) => `${x.key}/${y.key}`))
            .toEqual(['a/c', 'b/c']);
    });

    it('stacks blocks with no offset anywhere', () => {
        expect(stackFrames([{ key: 'a', height: 4 }, { key: 'b', height: 6 }], 2)).toEqual([
            { key: 'a', top: 2, height: 4 },
            { key: 'b', top: 6, height: 6 },
        ]);
    });
});
