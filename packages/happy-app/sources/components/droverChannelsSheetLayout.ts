/**
 * The channel sheet's arithmetic (DROVE-123), kept out of the component so it
 * can be tested without gesture-handler or reanimated.
 *
 * Two things are measured here.
 *
 * HOW TALL. The sheet holds four mode rows and then two sections of two
 * switch rows. The complaint on the ticket was that only Direct and
 * Hands-free voice were on screen, so what is measured here is the content,
 * and what has to hold is that the whole mode list is drawn before anything
 * scrolls. The cap itself is no longer this file's business: DROVE-201 made
 * every composer sheet grow to the usable screen, so `composerSheetCap` is
 * the only ceiling and this content fits under it on a phone.
 *
 * HOW WIDE THE LABEL COLUMN IS. `Speak prompts when they arrive` came back
 * from the phone as `Speak prompts when th...`, cut mid word, while
 * `Read replies aloud` below it fitted. DROVE-100 named those two rows so the
 * difference between them is legible, and an ellipsis at `when th` throws
 * that away. The column arithmetic below reproduces the truncation, so the
 * test can hold a shorter label to the fit instead of eyeballing a screenshot.
 */

/** Row heights as ComposerSheetRow and the mode picker actually draw them. */
export const channelSheetRowHeight = {
    /** Radio, title and subtitle inside 8pt of vertical padding. */
    mode: 48,
    /** ComposerSheetRow's minHeight. */
    toggle: 48,
    /** A section's uppercase title. */
    sectionTitle: 24,
    /** The section view's own vertical padding, 8 top and 8 bottom. */
    sectionPadding: 16,
} as const;

/** What the sheet would be if nothing capped it. */
export function channelSheetContentHeight(input: { modes: number; toggleSections: number[] }): number {
    const { mode, toggle, sectionTitle, sectionPadding } = channelSheetRowHeight;
    const modeSection = input.modes * mode + sectionTitle + sectionPadding;
    const toggleSections = input.toggleSections.reduce(
        (total, rows) => total + rows * toggle + sectionTitle + sectionPadding,
        0,
    );
    return modeSection + toggleSections;
}

/** Whether the mode list is fully drawn before anything has to be scrolled. */
export function modesVisibleWithoutScrolling(input: { modes: number; maxHeight: number }): boolean {
    const { mode, sectionTitle, sectionPadding } = channelSheetRowHeight;
    return input.modes * mode + sectionTitle + sectionPadding <= input.maxHeight;
}

/** Rough advance width of the 15pt row label, in points per character. */
export const sheetTitleCharWidth = 8.2;

/**
 * What is left for the label after the row's own furniture: the sheet's 8pt
 * row margin either side, 16pt of row padding either side, the 16pt icon, the
 * two 10pt gaps and the switch.
 */
export function sheetTitleColumnWidth(sheetWidth: number): number {
    return sheetWidth - 8 * 2 - 16 * 2 - 16 - 10 * 2 - 51;
}

/** The sheet's own width once the composer's side inset is taken off. */
export function channelSheetWidth(screenWidth: number, horizontalInset = 16): number {
    return screenWidth - horizontalInset * 2;
}

/** Whether a label draws in full on one line, or comes back with an ellipsis. */
export function sheetTitleFitsOneLine(label: string, sheetWidth: number): boolean {
    return label.length * sheetTitleCharWidth <= sheetTitleColumnWidth(sheetWidth);
}

/**
 * How many lines a row's title is given. Two, not one: a switch row has the
 * room, and a label that grows in translation should wrap rather than be cut
 * mid word. Shortening the English label is the first fix; this is the net.
 */
export const sheetTitleLines = 2;
