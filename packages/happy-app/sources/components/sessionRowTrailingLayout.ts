/**
 * THE TRAILING END OF A SESSION ROW, WHEREVER A SESSION ROW IS DRAWN
 * (DROVE-393).
 *
 * Clay, drawing across the empty middle of each project-card row: "put an
 * icon of the harness for each session." Then, on the flat list: "where's
 * the little status." Two rows, two answers to the same question, which is
 * how the card row came to carry a dot and the flat row a timestamp. So the
 * end of a row is resolved here once, glyph then indicator, and
 * SessionRowTrailing.tsx draws it for both. The spec holds each row to that
 * component so the two views cannot drift apart again.
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
import { resolveAvatarHarness, type AvatarHarnessIcon } from '@/utils/avatarHarness';
import type { StatusDotState } from './statusDotState';

/** Small enough to sit inside the 18pt slot's rhythm, large enough to tell a cube from an asterisk. */
export const SESSION_ROW_GLYPH_SIZE = 14;
/** The card row's slot (DROVE-243): the dot's centre meets the project header's "+" above it. */
export const SESSION_ROW_INDICATOR_SLOT = 18;
/** Between the title and the glyph, and between the glyph and the slot. */
export const SESSION_ROW_TRAILING_GAP = 8;

export type SessionRowTrailingIndicator = 'dot' | 'draft' | 'none';

export interface SessionRowTrailingLayout {
    /** Null draws no glyph: an unknown flavor, or one with no mark in the bundle. */
    harness: AvatarHarnessIcon | null;
    indicator: SessionRowTrailingIndicator;
}

/** The slot's content for a session in `dotState`, or none at all for retired work. */
export function sessionRowIndicator(dotState: StatusDotState | null, hasDraft: boolean): SessionRowTrailingIndicator {
    if (dotState === null) return 'none';
    return dotState === 'connected' && hasDraft ? 'draft' : 'dot';
}

export function resolveSessionRowTrailing(input: {
    flavor: string | null;
    clientId: string | null;
    dotState: StatusDotState | null;
    hasDraft: boolean;
}): SessionRowTrailingLayout {
    return {
        harness: resolveAvatarHarness(input.flavor, input.clientId),
        indicator: sessionRowIndicator(input.dotState, input.hasDraft),
    };
}
