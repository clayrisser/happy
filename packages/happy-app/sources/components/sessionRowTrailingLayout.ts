/**
 * THE TRAILING END OF A SESSION ROW, WHEREVER A SESSION ROW IS DRAWN
 * (DROVE-393, DROVE-398).
 *
 * Clay, drawing across the empty middle of each project-card row: "put an
 * icon of the harness for each session." Then, on the flat list: "where's
 * the little status." Two rows, two answers to the same question, which is
 * how the card row came to carry a dot and the flat row a timestamp. So the
 * end of a row is resolved here once, glyph then indicator then time, and
 * SessionRowTrailing.tsx draws it for both. The spec holds each row to that
 * component so the two views cannot drift apart again.
 *
 * ONE LINE (DROVE-398). DROVE-393 hung the glyph and the dot under the flat
 * row's time, on the project line, to spare the title. That split cost the
 * row twice over. The time sat alone in a fixed 56pt column and "12:25 PM"
 * did not fit it: "why are the times getting cut off." And the column was
 * still the old unread badge's, so a row with unread swapped its time for a
 * 20pt disc right beside the new 6pt dot: "why the fuck did the dot get so
 * big." Then, zoomed on four rows: "have the status and the other symbols all
 * on the same row."
 *
 * So the whole trailing end sits on the TITLE line of both rows, from the
 * inside out: the row's own marks first (the flat row's bolt and reading
 * speaker), then the harness glyph, then the 18pt indicator slot, then the
 * time at the edge. The time is its own width and never shrinks; the title is
 * the one thing on the row that gives. No time leaves the edge empty, and
 * nothing is ever drawn in its place: the unread and gate signals ride on the
 * time's colour (flatSessionRowPresentation.ts), and the dot is drawn once,
 * in the slot.
 *
 * The indicator rule is DROVE-243's, moved here from the card row: the slot
 * says what the session is doing, and the draft pencil replaces the dot only
 * on a session that is idle and connected. A half-typed message is a thing to
 * finish and the dot there would only say `connected`, so the pencil is
 * strictly more information. Anything else and the dot wins, because it is
 * the one that says the session dropped.
 *
 * No state at all draws no indicator. That is retired work: the flat list is
 * the one view that shows archived sessions, and a dot there could only ever
 * be red, on every row, saying "disconnected" about something that ended on
 * purpose. The glyph stays, because what a session WAS is still true.
 *
 * Pure, so the glyph can be resolved per flavor from the real catalog without
 * a renderer; the hook that turns the dot facts into a colour stays in the
 * component.
 */
import type { TextStyle } from 'react-native';
import { resolveAvatarHarness, type AvatarHarnessIcon } from '@/utils/avatarHarness';
import type { StatusDotState } from './statusDotState';

/** Small enough to sit inside the 18pt slot's rhythm, large enough to tell a cube from an asterisk. */
export const SESSION_ROW_GLYPH_SIZE = 14;
/** The card row's slot (DROVE-243): the dot's centre meets the project header's "+" above it. */
export const SESSION_ROW_INDICATOR_SLOT = 18;
/** Between the title and the glyph, the glyph and the slot, and the slot and the time. */
export const SESSION_ROW_TRAILING_GAP = 8;

/**
 * The time label's layout (DROVE-398): its own width, never shrunk, never
 * boxed. No `width`, no `maxWidth`, no `flex`, and the spec holds it to that,
 * because a fixed column is exactly what cut "12:25 PM" to "12:25…". Tabular
 * figures so the stamps line up down the list; right-aligned so a short one
 * still meets the edge.
 */
export const SESSION_ROW_TIME_STYLE = {
    flexShrink: 0,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
} as const satisfies TextStyle;

export type SessionRowTrailingIndicator = 'dot' | 'draft' | 'none';

export interface SessionRowTrailingLayout {
    /** Null draws no glyph: an unknown flavor, or one with no mark in the bundle. */
    harness: AvatarHarnessIcon | null;
    indicator: SessionRowTrailingIndicator;
    /** The stamp at the edge, verbatim, or null to leave the edge empty. */
    time: string | null;
}

/** The slot's content for a session in `dotState`, or none at all for retired work. */
export function sessionRowIndicator(dotState: StatusDotState | null, hasDraft: boolean): SessionRowTrailingIndicator {
    if (dotState === null) return 'none';
    return dotState === 'connected' && hasDraft ? 'draft' : 'dot';
}

/**
 * What goes at the edge: the stamp as given, or nothing. An empty string is
 * nothing too, so a row never reserves a gap for a label with no glyphs in it.
 */
export function sessionRowTime(timestamp: string | null | undefined): string | null {
    return timestamp ? timestamp : null;
}

export function resolveSessionRowTrailing(input: {
    flavor: string | null;
    clientId: string | null;
    dotState: StatusDotState | null;
    hasDraft: boolean;
    /** Absent on a row that has no stamp to show, which is the card row. */
    timestamp?: string | null;
}): SessionRowTrailingLayout {
    return {
        harness: resolveAvatarHarness(input.flavor, input.clientId),
        indicator: sessionRowIndicator(input.dotState, input.hasDraft),
        time: sessionRowTime(input.timestamp),
    };
}
