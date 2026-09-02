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

/**
 * The sheet header as WorktreeSheet draws it: 2pt over a 15pt title, 2pt to
 * a 12pt subtitle, 8pt under. Line heights are the font sizes plus the
 * platform's default leading.
 */
export const worktreeSheetHeaderHeight = 2 + 18 + 2 + 16 + 8;

/** UISegmentedControl's natural height, which the RN sibling matches. */
export const sheetTabsHeight = 32;

/** The strip around the control: the sheet's 16pt side padding, 2pt over, 10pt under. */
export const sheetTabsInset = { horizontal: 16, top: 2, bottom: 10 } as const;

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
