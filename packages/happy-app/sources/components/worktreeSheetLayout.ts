/**
 * The worktree sheet's arithmetic (DROVE-330), kept out of the components so
 * it can be tested without reanimated or gesture-handler, the way
 * droverChannelsSheetLayout.ts and composerSheetLayout.ts are.
 *
 * Clay, more than once: use the layout system, not computed offsets. So every
 * height a component needs is a named number here, derived from what the
 * sheet actually draws, and the one derived height (the terminal box) comes
 * off `composerSheetCap` rather than off a guess.
 *
 * THE TERMINAL BOX HAS AN EXPLICIT HEIGHT, and this is why. ComposerSheet
 * sizes itself to its content and scrolls only once that content has filled
 * the screen (DROVE-201). A pane is two hundred lines; left as content it
 * would make the SHEET scroll, with the prompt somewhere in the middle. What
 * a terminal wants is the opposite: the sheet fills the screen once and the
 * TEXT scrolls inside it, pinned to the bottom. So the box is given the room
 * the cap leaves after the header, the tabs and the status line, and the
 * sheet measures exactly the cap. The file view uses the same box.
 */

import { composerSheetCap, type ComposerSheetWindow } from './composerSheetLayout';
import { sheetHeaderHeight } from './sheetHeaderLayout';

/**
 * The sheet header, from the shared rhythm every drover sheet is drawn on
 * (DROVE-376). It used to state its own arithmetic here -- 2 + 18 + 2 + 16 + 8
 * -- while the component set no `lineHeight` at all, so the drawn header was
 * 44.2pt against a declared 46 and the tab control came up into the subtitle.
 * The number now comes from the same place the component's styles do.
 */
export const worktreeSheetHeaderHeight = sheetHeaderHeight({ subtitle: true });

/** UISegmentedControl's natural height, which the RN sibling matches. */
export const sheetTabsHeight = 32;

/**
 * The strip around the control: the sheet's 16pt side padding and 10pt under.
 * NOTHING over it. The gap between the header and this strip belongs to
 * `sheetHeaderRhythm.bottom` and lives inside the header's own height, because
 * one gap owned by two views is how this one went missing.
 */
export const sheetTabsInset = { horizontal: 16, top: 0, bottom: 10 } as const;

export const sheetTabsBlockHeight = sheetTabsHeight + sheetTabsInset.top + sheetTabsInset.bottom;

/** Rough advance width of the 13pt segment label, in points per character. */
export const sheetTabsCharWidth = 7.2;

/** UISegmentedControl's own padding inside each segment. */
export const sheetTabsSegmentPadding = 8;

/**
 * Whether every segment label draws whole. Four segments share the control's
 * width equally, so the widest label is the one that decides.
 */
export function sheetTabsFit(labels: readonly string[], sheetWidth: number): boolean {
    const control = sheetWidth - sheetTabsInset.horizontal * 2;
    const segment = control / Math.max(1, labels.length);
    const widest = Math.max(...labels.map((label) => label.length * sheetTabsCharWidth));
    return widest + sheetTabsSegmentPadding * 2 <= segment;
}

/** The line above the terminal box: scope, pane and age, or the trouble sentence. */
export const terminalMetaHeight = 22;

/** 12pt mono, at the leading the transcript's code blocks use. */
export const terminalLineHeight = 16;

/** Inside the box, over and under the text. */
export const terminalPadding = 10;

/** Never fewer lines than this, whatever the window. A terminal of three lines is a tooltip. */
export const terminalMinLines = 8;

/** The sheet body's own bottom padding, as WorktreeSheet's `body` style has it. */
export const worktreeSheetBodyPadding = 6;

/**
 * How tall the terminal (and file view) box is on this window: the cap, less
 * the furniture drawn above it and the body's padding under it, and never
 * below the minimum.
 */
export function terminalBodyHeight(input: ComposerSheetWindow): number {
    const room = composerSheetCap(input)
        - worktreeSheetHeaderHeight
        - sheetTabsBlockHeight
        - terminalMetaHeight
        - worktreeSheetBodyPadding;
    return Math.max(terminalMinLines * terminalLineHeight + terminalPadding * 2, Math.floor(room));
}

/** How many whole lines that box shows at once. */
export function terminalVisibleLines(boxHeight: number): number {
    return Math.floor((boxHeight - terminalPadding * 2) / terminalLineHeight);
}

/** What the sheet measures with the terminal tab up: it should be exactly the cap. */
export function terminalTabContentHeight(input: ComposerSheetWindow): number {
    return worktreeSheetHeaderHeight
        + sheetTabsBlockHeight
        + terminalMetaHeight
        + terminalBodyHeight(input)
        + worktreeSheetBodyPadding;
}

/** How often the Terminal tab asks for the pane again, while it is up. */
export const paneRefreshMs = 2000;

/** How many lines it asks for. Enough to scroll back through a build. */
export const paneLines = 200;

/** A Files tab row: an icon, a name and a size, on one line with 10pt over and under. */
export const filesRowHeight = 44;

/** The crumb line over the list. */
export const filesCrumbHeight = 32;

/* ── The Todos tab (DROVE-380) ──────────────────────────────────────────────
 *
 * Clay, looking at the tab: "Is there a richer way to display this, or to
 * communicate this?" The photograph is two grey captions, two grey fragments
 * and two thirds of a screen of black. DROVE-359 was right to cut the
 * paragraphs that used to be there, but cutting them left NOTHING behind.
 *
 * So the tab gets a shape, and every height it needs is a named number here
 * rather than a padding somebody eyeballed in the component. The one that
 * actually fixes the screenshot is `todosEmptySectionHeight`: an empty section
 * is given real room off the cap and centres its glyph inside it, instead of
 * stacking one grey line at the top and leaving the rest black.
 */

/** The section's own box, as WorktreeTodosTab draws it. */
export const todosSectionInset = { horizontal: 20, top: 4, bottom: 10, gap: 8 } as const;

/** The 10pt caption (NEEDS YOU, TASK LIST), which stays. */
export const todosCaptionHeight = 14;

/** The caption plus the gap under it: what a section costs before any content. */
export const todosCaptionBlockHeight = todosSectionInset.top + todosCaptionHeight + todosSectionInset.gap;

/** One checklist line: 13pt text at the leading the transcript's card uses. */
export const taskRowLineHeight = 19;

/** A task longer than this wraps, and then stops. Two lines is a task; five is a paragraph. */
export const taskRowMaxLines = 2;

/** Between rows. */
export const taskRowGap = 6;

/** The state glyph's column, wide enough for the 14pt ring plus its breathing room. */
export const taskGlyphColumn = 18;

/** The ring, and the live core inside it on the row being worked. */
export const taskGlyphSize = 14;
export const taskGlyphCoreSize = 6;

/** The progress bar over the rows. Thin: it is a fact, not a feature. */
export const taskProgressBarHeight = 3;
export const taskProgressLabelHeight = 15;
export const taskProgressGap = 6;

/** `3 of 7` over its bar, plus the gap down to the first row. */
export const taskProgressBlockHeight =
    taskProgressLabelHeight + taskProgressGap + taskProgressBarHeight + taskRowGap;

/** How tall a run of task rows is, at one or two lines each. */
export function taskRowsHeight(lines: readonly number[]): number {
    if (lines.length === 0) return 0;
    const rows = lines.reduce((sum, count) => (
        sum + Math.max(1, Math.min(taskRowMaxLines, count)) * taskRowLineHeight
    ), 0);
    return rows + taskRowGap * (lines.length - 1);
}

/** The empty state's glyph, the fragment under it, and the gap between. */
export const todosEmptyGlyphSize = 34;
export const todosEmptyGap = 10;
export const todosEmptyFragmentHeight = 19;

export const todosEmptyBlockHeight = todosEmptyGlyphSize + todosEmptyGap + todosEmptyFragmentHeight;

/**
 * The least room an empty section takes, whatever else is on the tab.
 *
 * Enough that the glyph has air over and under it rather than sitting on the
 * caption. When the OTHER section has rows, this is all an empty one gets:
 * the rows are what he opened the tab for.
 */
export const todosEmptyMinHeight = todosEmptyBlockHeight + 32;

/**
 * The whole area the two sections live in: the cap, less the furniture the
 * sheet draws above them and the body's padding under them.
 *
 * Off `composerSheetCap` for the same reason the terminal box is (see the top
 * of this file): the tab needs a height it can centre something inside, and a
 * number picked by hand would stop being true on the next handset.
 */
export function todosTabBodyHeight(input: ComposerSheetWindow): number {
    return Math.max(
        todosEmptyMinHeight * 2 + todosCaptionBlockHeight * 2,
        Math.floor(
            composerSheetCap(input)
            - worktreeSheetHeaderHeight
            - sheetTabsBlockHeight
            - worktreeSheetBodyPadding,
        ),
    );
}

/**
 * How tall ONE empty section is drawn.
 *
 * Both sections empty is the screenshot, and it is the case worth getting
 * right: they split the tab between them, so two centred glyphs fill the
 * screen and there is no black third at the bottom. One empty beside one with
 * rows gets the minimum instead — the rows own the tab, and an empty section
 * that pushed them off it would be worse than the void it replaced.
 */
export function todosEmptySectionHeight(input: ComposerSheetWindow, emptySections: number): number {
    if (emptySections <= 0) return 0;
    if (emptySections === 1) return todosEmptyMinHeight;
    const room = todosTabBodyHeight(input) - todosCaptionBlockHeight * emptySections;
    return Math.max(todosEmptyMinHeight, Math.floor(room / emptySections));
}

/** A needs-you card at rest: title over one fragment of context, with the age beside it. */
export const needsCardCollapsedHeight = 8 + 19 + 4 + 18 + 8;

/** Between the cards. */
export const needsCardGap = 8;
