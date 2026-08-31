/**
 * Effort as a SLIDER: the scale, the layout, and the gesture that moves it
 * (DROVE-200).
 *
 * Clay: "could you make the effort a slider by the way."
 *
 * Effort is ordinal — low, medium, high, xhigh, max, ultracode — and DROVE-141
 * already draws it as a DIAL with a needle position for exactly that reason.
 * The picker underneath it was still a list: open a sheet, read six words, tap
 * one, to move one notch along a line already on the screen. This file is the
 * line.
 *
 * WHERE THE SLIDER LIVES, AND WHY IT IS NOT THE DIAL.
 *
 * The obvious move is to make the 20pt dial draggable in place. It is the
 * fewest taps and it matches the glyph that shipped. It is also the wrong
 * control for a finger:
 *
 *   - The dial's sweep is 260 degrees on a 20pt glyph inside a 44pt segment.
 *     Six stops on that arc is about 7pt of arc each, a quarter of the
 *     smallest target Apple will put a finger on.
 *   - A rotational drag is two axes. You have to be at the right angle AND
 *     off the centre, and the correction for one moves the other.
 *   - The finger covers the dial it is turning. The one thing a drag has to
 *     show — which level you are on before you let go — is under the thumb.
 *
 * So the dial stays exactly what DROVE-141 made it: the resting glyph, read at
 * a glance, with DROVE-176's ramp on the needle and DROVE-153's 44pt segment
 * around it. Pressing it opens a HORIZONTAL popover ABOVE the composer row,
 * one stop per level, and the same unbroken touch drags along it. The finger
 * stays on the capsule; the readout is 44pt north of it, uncovered.
 *
 * THE DRAG IS RELATIVE, AND THAT IS FORCED, NOT PREFERRED. The effort segment
 * sits about 83pt from the screen's left edge (a 16pt gutter, the mode
 * segment, a hairline, half of its own 44pt). So a finger that starts there
 * has 83pt of leftward room and no more. An ABSOLUTE mapping — the stop under
 * the finger's x — would jump the value the moment the finger moved, because
 * the finger is on the capsule and the line is 44pt north of it. A 1:1
 * relative mapping at the drawn 44pt spacing would need 220pt of leftward
 * travel to get from `ultracode` down to `low`, which does not exist.
 *
 * So the drawn spacing and the GESTURE spacing are two different numbers.
 * `gestureSpacing` is 18pt: five notches, the longest scale anyone runs, is
 * 90pt of travel, which fits inside the 83pt to the left edge plus the slop.
 * A notch is a flick, which is what Clay asked for. The thumb snaps between
 * drawn stops rather than tracking the finger continuously, so nothing looks
 * out of step: it is a readout with detents, not a knob under the thumb.
 *
 * The popover itself is centred on the finger and clamped to the screen. That
 * is cosmetic only — the mapping never depends on where it landed — which is
 * why a clamp at either edge cannot make the control lie.
 *
 * `AUTO` IS A MODE, NOT A LEVEL. `/effort auto` hands the choice back to
 * Claude Code; it is not a seventh notch and it is not below `low`. Putting it
 * on the line would mean dragging past the floor lands on it, which is the one
 * thing the ticket rules out. So it is a pill at the LEFT of the popover, off
 * the track, past a gap: reachable in one tap, never reachable by dragging.
 * The drag clamps at stop 0. Its wire value is `effortLevel: null`, which
 * paneModelSync spells `/effort auto` — the reset argument, the same path
 * DROVE-164 fixed.
 *
 * THE ENDS ARE THIS MODEL'S REAL ENDS. The stops come from
 * `getEffortLevelsForModel`, which is per model and which DROVE-164 rewrote as
 * a DENY list after DROVE-101 wrote it backwards and cost Clay `ultracode` for
 * two months. Nothing here re-derives that table; it asks it. Switching model
 * re-asks it, so the line re-scales: six stops on Opus 5, four on a model
 * below the xhigh line, whatever the rig published for a rig session.
 *
 * NO GHOST STOPS. A first cut drew the unreachable levels as dim pips past the
 * end. It cannot be done honestly: on a sub-xhigh Claude model `max` is
 * reachable and `xhigh` is not, so the ghost lands in the MIDDLE of the run
 * and the line stops being a line. The picker's disabled rows still say why a
 * level is out of reach; the slider just does not offer it.
 *
 * ONE WRITE, ON RELEASE. `effortSliderReduce` only ever returns a `commit`
 * from a release or a tap. A drag across five stops is five `detent` ticks and
 * zero writes. This matters more than it sounds: every write is a metadata
 * round trip that ends in a `/effort` typed at a live pane.
 *
 * DETENTS ARE INTERACTION FEEDBACK. Crossing a stop returns `detent: true`,
 * and the caller plays `hapticsSelection`, which goes through
 * `hapticAllowed('interaction', ...)` and is therefore silent while the phone's
 * haptics switch is off, which is its default (DROVE-190). Nothing here calls
 * expo-haptics, so there is no way for this control to buzz around that
 * switch.
 *
 * Pure, no React and no native module, so the scale, the placement and the
 * commit rule are all provable in node.
 */

import type { Metadata } from '@/sync/storageTypes';
import {
    effortDisplayName,
    getEffortLevelsForModel,
    type AgentFlavor,
    type EffortLevel,
} from './modelModeOptions';

export const EFFORT_SLIDER_METRICS = {
    /** DROVE-153's floor. The popover is a control, so it is a 44pt one. */
    height: 44,
    /** Half a stop of air at each end, so an end stop is not on the rim. */
    trackPadding: 22,
    /** The widest a stop gap gets. Six of these fit any phone. */
    maxStopSpacing: 44,
    /** The narrowest gap that still reads as two stops and not one smear. */
    minStopSpacing: 26,
    /**
     * How far the FINGER travels per notch, which is not how far the drawn
     * thumb moves. See the header: the segment has 83pt of room to its left,
     * and the longest scale is six stops, so a full sweep has to fit in 90.
     */
    gestureSpacing: 18,
    /** The `auto` pill: off the track, at the left, past `autoGap`. */
    autoWidth: 52,
    autoGap: 10,
    /** How far the finger travels before it takes the thumb off its stop. */
    grabSlop: 6,
    /** The popover never touches the screen edge. */
    edgeMargin: 8,
} as const;

/** The index that means `auto`: not on the ordered run at all. */
export const EFFORT_AUTO_INDEX = -1;

export interface EffortSliderScale {
    /** Wire keys, floor first, ceiling last. */
    keys: readonly string[];
    /** The same stops as words, for the readout and the screen reader. */
    names: readonly string[];
}

const emptyScale: EffortSliderScale = { keys: [], names: [] };

/**
 * The stops this model actually offers.
 *
 * Only reachable levels. `getEffortLevelsForModel` is already per model and is
 * the selection path DROVE-101 and DROVE-164 both landed on; a disabled entry
 * would only ever arrive here through a rig publishing one, and it is dropped
 * rather than drawn as a stop the drag can stall on.
 */
export function effortSliderScale(
    flavor: AgentFlavor,
    modelKey: string,
    metadata?: Metadata | null,
): EffortSliderScale {
    return effortSliderScaleFromLevels(getEffortLevelsForModel(flavor, modelKey, metadata));
}

/**
 * The same scale built from a list a caller already has. The composer is given
 * the PICKER's list, which appends the levels this model cannot reach as
 * disabled rows (DROVE-101); the line drops them, so its ends are the model's
 * real ends.
 */
export function effortSliderScaleFromLevels(levels: readonly EffortLevel[]): EffortSliderScale {
    const reachable = levels.filter((level) => !level.disabled);
    if (reachable.length === 0) return emptyScale;
    return {
        keys: reachable.map((level) => level.key),
        names: reachable.map((level) => level.name ?? effortDisplayName(level.key)),
    };
}

/**
 * Where a key sits on this scale.
 *
 * Three answers, and the third is the one that makes switching model work:
 *   - no key at all is `auto`, which is off the run: EFFORT_AUTO_INDEX.
 *   - a key on the scale is its index.
 *   - a key the NEW model cannot reach lands on the ceiling, which is where
 *     `updateModelMode` puts it too (getHighestReachableEffortKey, DROVE-101).
 *     The thumb never sits off the end of its own line.
 */
export function effortSliderIndex(scale: EffortSliderScale, key: string | null | undefined): number {
    if (scale.keys.length === 0) return EFFORT_AUTO_INDEX;
    if (key == null || key.length === 0) return EFFORT_AUTO_INDEX;
    const index = scale.keys.indexOf(key);
    if (index >= 0) return index;
    return scale.keys.length - 1;
}

/** The word for a stop, or `Auto` off the run. */
export function effortSliderStopName(scale: EffortSliderScale, index: number): string {
    if (index === EFFORT_AUTO_INDEX) return 'Auto';
    return scale.names[clampIndex(index, scale.keys.length)] ?? 'Auto';
}

/** What a screen reader hears on the popover, named then valued. */
export function effortSliderAccessibility(
    scale: EffortSliderScale,
    index: number,
): { label: string; value: string } {
    const label = 'Reasoning effort';
    if (index === EFFORT_AUTO_INDEX) {
        return { label, value: 'Auto, chosen for you' };
    }
    const count = scale.keys.length;
    const level = clampIndex(index, count);
    return {
        label,
        value: count > 1
            ? `${scale.names[level]}, ${level + 1} of ${count}`
            : scale.names[level] ?? 'Auto',
    };
}

export interface EffortSliderPlacement {
    /** Page x of the popover's left edge. */
    left: number;
    /** The whole popover, `auto` pill included. */
    width: number;
    /** Page x of stop 0. */
    trackLeft: number;
    /** Page x between two neighbouring stops. Zero on a one-stop scale. */
    spacing: number;
    count: number;
}

/**
 * Lay the popover out: centred on the finger, clamped inside the screen.
 *
 * Cosmetic only. The drag reads a DELTA (effortStopForDelta), so where this
 * lands never changes which stop the finger is on. A popover pinned to the
 * screen's edge and one centred on the thumb behave identically; only the
 * first one is easier to read.
 */
export function effortSliderPlacement(input: {
    screenWidth: number;
    anchorX: number;
    count: number;
}): EffortSliderPlacement {
    const m = EFFORT_SLIDER_METRICS;
    const count = Math.max(1, Math.round(input.count));
    const chrome = m.autoWidth + m.autoGap + m.trackPadding * 2;
    const room = input.screenWidth - m.edgeMargin * 2 - chrome;
    const spacing = count > 1
        ? clamp(room / (count - 1), m.minStopSpacing, m.maxStopSpacing)
        : 0;
    const width = chrome + spacing * (count - 1);
    const highest = Math.max(m.edgeMargin, input.screenWidth - m.edgeMargin - width);
    const left = clamp(input.anchorX - width / 2, m.edgeMargin, highest);
    return {
        left,
        width,
        trackLeft: left + m.autoWidth + m.autoGap + m.trackPadding,
        spacing,
        count,
    };
}

/**
 * The stop a drag of `dx` from `anchorIndex` lands on.
 *
 * Clamped to the run at both ends, so dragging left past the floor stays on
 * the floor: it never falls off onto `auto`, which is a tap and not a notch.
 * A gesture that starts on `auto` climbs from the floor, because auto has no
 * position on the line to climb from.
 */
export function effortStopForDelta(anchorIndex: number, dx: number, count: number): number {
    const levels = Math.max(1, Math.round(count));
    const base = anchorIndex === EFFORT_AUTO_INDEX ? 0 : clampIndex(anchorIndex, levels);
    return clampIndex(base + Math.round(dx / EFFORT_SLIDER_METRICS.gestureSpacing), levels);
}

/** Page x of a stop. */
export function effortStopX(index: number, placement: EffortSliderPlacement): number {
    return placement.trackLeft + placement.spacing * clampIndex(index, placement.count);
}

/** Page x of the `auto` pill's centre. */
export function effortAutoX(placement: EffortSliderPlacement): number {
    return placement.left + EFFORT_SLIDER_METRICS.autoWidth / 2;
}

/**
 * The stop nearest a page x. The hit test for a TAP on a latched popover, not
 * the drag: the drag is a delta (effortStopForDelta).
 */
export function effortStopForX(x: number, placement: EffortSliderPlacement): number {
    if (placement.spacing <= 0) return 0;
    return clampIndex(Math.round((x - placement.trackLeft) / placement.spacing), placement.count);
}

export type EffortSliderPhase = 'closed' | 'dragging' | 'open';

export interface EffortSliderState {
    phase: EffortSliderPhase;
    /** Page x the finger landed on. */
    anchorX: number;
    /** The stop the gesture started from, so a release can tell a move from a tap. */
    anchorIndex: number;
    /** The stop under the finger now. */
    index: number;
    /** The finger has travelled past the slop and owns the thumb. */
    grabbed: boolean;
}

export const effortSliderClosed: EffortSliderState = {
    phase: 'closed',
    anchorX: 0,
    anchorIndex: EFFORT_AUTO_INDEX,
    index: EFFORT_AUTO_INDEX,
    grabbed: false,
};

export type EffortSliderEvent =
    /** A finger landed on the effort segment. `index` is where the session is now. */
    | { type: 'press-in'; x: number; index: number }
    | { type: 'move'; x: number }
    | { type: 'press-out' }
    /** A tap on a stop while the popover is latched open. */
    | { type: 'tap-stop'; index: number }
    | { type: 'tap-auto' }
    | { type: 'dismiss' };

export type EffortSliderCommit =
    | { kind: 'level'; index: number }
    | { kind: 'auto' };

export interface EffortSliderStep {
    state: EffortSliderState;
    /**
     * The one write. Only ever produced by a release or a tap, never by a
     * move, however far the finger goes.
     */
    commit: EffortSliderCommit | null;
    /** A stop was crossed: one interaction tick, subject to DROVE-190. */
    detent: boolean;
}

function step(
    state: EffortSliderState,
    commit: EffortSliderCommit | null = null,
    detent: boolean = false,
): EffortSliderStep {
    return { state, commit, detent };
}

/**
 * The whole gesture, as a reducer.
 *
 * press-in opens the popover and changes nothing. move slides the thumb and
 * changes nothing. release commits, once, and only if the thumb actually
 * moved. A press that never moved leaves the popover LATCHED open, so a tap is
 * not a dead gesture: the stops are then tappable and the `auto` pill with
 * them.
 */
export function effortSliderReduce(
    state: EffortSliderState,
    event: EffortSliderEvent,
    placement: EffortSliderPlacement | null,
): EffortSliderStep {
    switch (event.type) {
        case 'press-in':
            return step({
                phase: 'dragging',
                anchorX: event.x,
                anchorIndex: event.index,
                index: event.index,
                grabbed: false,
            });
        case 'move': {
            if (state.phase !== 'dragging' || !placement) return step(state);
            if (!state.grabbed && Math.abs(event.x - state.anchorX) < EFFORT_SLIDER_METRICS.grabSlop) {
                return step(state);
            }
            const index = effortStopForDelta(state.anchorIndex, event.x - state.anchorX, placement.count);
            if (state.grabbed && index === state.index) return step(state);
            return step({ ...state, grabbed: true, index }, null, index !== state.index);
        }
        case 'press-out': {
            if (state.phase !== 'dragging') return step(state);
            // A press that never moved is a tap. The popover stays up rather
            // than flashing: the stops are the picker now.
            if (!state.grabbed) return step({ ...state, phase: 'open' });
            if (state.index === state.anchorIndex) return step(effortSliderClosed);
            return step(effortSliderClosed, { kind: 'level', index: state.index });
        }
        case 'tap-stop': {
            if (state.phase === 'closed') return step(state);
            if (event.index === state.anchorIndex) return step(effortSliderClosed);
            return step(effortSliderClosed, { kind: 'level', index: event.index });
        }
        case 'tap-auto': {
            if (state.phase === 'closed') return step(state);
            if (state.anchorIndex === EFFORT_AUTO_INDEX) return step(effortSliderClosed);
            return step(effortSliderClosed, { kind: 'auto' });
        }
        case 'dismiss':
            return step(effortSliderClosed);
    }
}

/** The wire value a commit stands for. `auto` is a reset, which is null. */
export function effortCommitKey(
    scale: EffortSliderScale,
    commit: EffortSliderCommit,
): string | null {
    if (commit.kind === 'auto') return null;
    return scale.keys[clampIndex(commit.index, scale.keys.length)] ?? null;
}

function clamp(value: number, low: number, high: number): number {
    if (high < low) return low;
    return Math.max(low, Math.min(high, value));
}

function clampIndex(index: number, count: number): number {
    const levels = Math.max(1, Math.round(count));
    return Math.max(0, Math.min(levels - 1, Math.round(index)));
}
