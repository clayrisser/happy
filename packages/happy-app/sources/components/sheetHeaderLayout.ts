/**
 * ONE RHYTHM FOR EVERY DROVER SHEET HEADER, AND FRAMES A TEST CAN CHECK
 * (DROVE-376).
 *
 * Clay, from his phone, with a screenshot of the worktrees sheet: "there's a
 * bunch of weird alignments in several places." The picture is the tab control
 * drawn ON the subtitle -- the segmented Worktrees | Todos | Terminal | Files
 * strip sitting on `~/Projects/bitspur/cattle-drover` with its top edge
 * through the path's descenders, no gap at all.
 *
 * WHY IT HAPPENED, because the answer is the design and not the number.
 * `worktreeSheetLayout.ts` declared `worktreeSheetHeaderHeight = 2 + 18 + 2 +
 * 16 + 8`, which asserts an 18pt title line over a 16pt subtitle line. The
 * component set `fontSize` on both and `lineHeight` on neither, so what iOS
 * actually drew was the font's own leading -- 17.9 and 14.3 -- and the header
 * was 44.2pt, not the 46 the module claimed. Worse, NOTHING consumed that 46
 * for the header itself: the header was padding around auto-sized text, the
 * constant was only ever subtracted inside `terminalBodyHeight`, and the two
 * were free to disagree with nothing to catch it. Measured off Clay's
 * screenshot at 3x, the control's track lands about 11pt above where the
 * header's `paddingBottom: 8` plus the strip's `paddingTop: 2` put it, which
 * is the whole gap plus a point.
 *
 * SO THE GAP GETS ONE OWNER AND A REAL BOX. Two rules here, and they are what
 * make this a layout system rather than a second set of magic numbers:
 *
 *   1. A header block has an EXPLICIT height, `sheetHeaderHeight()`, and its
 *      text has EXPLICIT line heights from the same constants. A fixed height
 *      is not a padding: it holds its place in the column whatever `Text`
 *      measures, so the block below it cannot ride up into the subtitle.
 *
 *   2. The gap to whatever the sheet draws next lives INSIDE that height, as
 *      `bottom`, and nowhere else. It used to be split between the header's
 *      `paddingBottom` and the next block's `paddingTop`, which is two owners
 *      for one gap and twice the chances of losing it.
 *
 * The totals are unchanged on purpose. The worktrees sheet spent 46 + 44 on
 * its header and tab block and it still spends 48 + 42; the header simply owns
 * the 2pt that used to sit on top of the tab strip. Copy density holds -- this
 * moves a gap, it does not add air.
 *
 * `sheetHeaders` below is the registry, in the shape `nativeControls.ts` uses:
 * a table the suite fails BOTH ways on, so a sheet that grows a header without
 * an entry fails, and an entry whose file stopped drawing one fails too.
 */

/**
 * The rhythm, in points. Every drover sheet header is drawn on these and the
 * suite checks that none of them re-states a number locally.
 *
 * The line heights are the font's own leading rounded up to a whole point --
 * 15pt SF leads at 17.9, 12pt at 14.3 -- so declaring them costs under two
 * points of height and buys a header whose drawn size is its computed size.
 */
export const sheetHeaderRhythm = {
    /** The side inset for header text. The sheet's rows use their own. */
    horizontal: 20,
    /** Over the title, under the grabber block. */
    top: 2,
    titleSize: 15,
    titleLine: 18,
    /** Between the title's line box and the subtitle's. */
    gap: 2,
    subtitleSize: 12,
    subtitleLine: 16,
    /**
     * Under the subtitle and inside the header's own height: the gap to
     * whatever comes next, owned here and only here. A block that follows a
     * header adds no top inset of its own.
     */
    bottom: 10,
} as const;

/**
 * THE SECOND RHYTHM: a section title inside a sheet, over the rows it heads.
 *
 * The same fault as the header's, in two more places. `DroverChannelsSheet`
 * and the composer's permission-mode overlay both drew a 12pt section title at
 * `paddingHorizontal: 16` with `paddingBottom: 4`, above rows whose own text
 * starts at `marginHorizontal: 8` plus `paddingHorizontal: 16` -- so the title
 * and the rows it names sat on two different left edges, 8pt apart, with four
 * points of air between them. `channelSheetRowHeight.sectionTitle` said 24 and
 * the drawing came to about 18.
 *
 * So the row card's geometry is named here and the title is derived FROM it,
 * which is the only way the two edges cannot drift apart again.
 */
export const sheetSectionRhythm = {
    /** The row card's inset from the sheet's edge. */
    cardInset: 8,
    /** The card's own padding, where its text begins. */
    cardPadding: 16,
    /** Over the section title. */
    top: 8,
    titleSize: 12,
    titleLine: 16,
    /** Between the title's line box and the first row. */
    gap: 8,
    /** Under the last row of a section. */
    bottom: 8,
} as const;

/**
 * Where a section title's text starts: the same left edge as the row text
 * below it, not the card's edge. This is the 8pt misalignment, named.
 */
export const sheetSectionTitleInset =
    sheetSectionRhythm.cardInset + sheetSectionRhythm.cardPadding;

/** The title block a section spends before its first row. */
export const sheetSectionTitleHeight =
    sheetSectionRhythm.titleLine + sheetSectionRhythm.gap;

/** What a section's own padding costs, over the title and under the last row. */
export const sheetSectionPadding = sheetSectionRhythm.top + sheetSectionRhythm.bottom;

/** What a given sheet's header actually draws. */
export interface SheetHeaderBlocks {
    /** Every header has a title. A header without one is not a header. */
    subtitle: boolean;
}

const withSubtitle: SheetHeaderBlocks = { subtitle: true };

/**
 * How tall the header block is: the inset over the title, the title's line,
 * the gap and the subtitle's line where there is one, and the inset under.
 * This is the number that goes on the block's `height`, not a guess about it.
 */
export function sheetHeaderHeight(blocks: SheetHeaderBlocks = withSubtitle): number {
    const { top, titleLine, gap, subtitleLine, bottom } = sheetHeaderRhythm;
    return top + titleLine + (blocks.subtitle ? gap + subtitleLine : 0) + bottom;
}

/** A laid-out box, in points down from the top of the sheet's body. */
export interface SheetFrame {
    key: string;
    top: number;
    height: number;
}

export function frameBottom(frame: SheetFrame): number {
    return frame.top + frame.height;
}

/**
 * Whether two boxes share any vertical space. Touching is not overlapping: a
 * block that starts exactly where the one above ends is the whole point.
 */
export function framesOverlap(a: SheetFrame, b: SheetFrame): boolean {
    return a.top < frameBottom(b) && b.top < frameBottom(a);
}

/** Every pair of boxes that collide, so a failure names them. */
export function overlappingFrames(frames: readonly SheetFrame[]): [SheetFrame, SheetFrame][] {
    const clashes: [SheetFrame, SheetFrame][] = [];
    for (let i = 0; i < frames.length; i += 1) {
        for (let j = i + 1; j < frames.length; j += 1) {
            if (framesOverlap(frames[i], frames[j])) clashes.push([frames[i], frames[j]]);
        }
    }
    return clashes;
}

/** A block a sheet stacks, before it knows where it lands. */
export interface SheetBlock {
    key: string;
    height: number;
}

/**
 * Stack blocks down the sheet body. Nothing here may take an offset: a block
 * lands where the one above it ended, which is what stops a `marginTop: -x`
 * from ever being the answer.
 */
export function stackFrames(blocks: readonly SheetBlock[], top = 0): SheetFrame[] {
    const frames: SheetFrame[] = [];
    let cursor = top;
    for (const block of blocks) {
        frames.push({ key: block.key, top: cursor, height: block.height });
        cursor += block.height;
    }
    return frames;
}

/**
 * The frames INSIDE a header block: where the title's line box sits and where
 * the subtitle's does, down from the header's own top. This is what the suite
 * checks the control against -- the subtitle's box bottom is the last pixel
 * the header may paint, and `bottom` is the clear air after it.
 */
export function sheetHeaderFrames(blocks: SheetHeaderBlocks = withSubtitle): SheetFrame[] {
    const { top, titleLine, gap, subtitleLine } = sheetHeaderRhythm;
    const inner: SheetBlock[] = [{ key: 'title', height: titleLine }];
    if (blocks.subtitle) inner.push({ key: 'subtitle', height: subtitleLine });
    const frames = stackFrames(inner, top);
    // The gap rides on the subtitle rather than being a block of its own,
    // because a spacer block is a frame nothing draws and the suite would then
    // be asserting about air.
    if (blocks.subtitle) frames[1].top += gap;
    return frames;
}

/**
 * A drover sheet that draws a header, and what it draws under it. `under` is
 * prose for the failure message, not a key: what matters to the suite is that
 * the file exists, imports the rhythm, and states no header metric of its own.
 */
export interface SheetHeaderSite {
    /** Path under `sources/`. */
    source: string;
    blocks: SheetHeaderBlocks;
    /** What the header sits above, so a clash has a name in the report. */
    under: string;
}

export const sheetHeaders: readonly SheetHeaderSite[] = [
    {
        source: 'components/WorktreeSheet.tsx',
        blocks: { subtitle: true },
        under: 'the segmented tab control (SheetTabs)',
    },
    {
        source: 'components/McpServerSheet.tsx',
        blocks: { subtitle: true },
        under: 'an ItemGroup, which brings its own header spacing',
    },
];

/**
 * A sheet that draws SECTION titles over rows, on `sheetSectionRhythm`. The
 * two entries are the pair that shared one hand-copied stylesheet: the channel
 * sheet took its section metrics out of the composer's overlay, and both drew
 * the title 8pt left of the rows it named.
 */
export interface SheetSectionSite {
    /** Path under `sources/`. */
    source: string;
    /** The style key the section title is drawn with, for the failure message. */
    titleStyle: string;
}

export const sheetSections: readonly SheetSectionSite[] = [
    { source: 'components/DroverChannelsSheet.tsx', titleStyle: 'sectionTitle' },
    { source: 'components/AgentInput.tsx', titleStyle: 'overlaySectionTitle' },
];
