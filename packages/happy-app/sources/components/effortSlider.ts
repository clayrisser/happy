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
 * THE POPOVER IS AS WIDE AS THE COMPOSER, AND THE LAYOUT GIVES IT THAT WIDTH
 * (DROVE-229). It used to be centred on the finger and clamped to the screen,
 * drawn through a frame pinned at `left: -shellInset` so its x=0 landed on the
 * screen's edge. Clay: "Allow me to actually size this and actually fully
 * cover the width right when I click this. Or at least have it centered." So
 * it is stretched gutter to gutter by its container, exactly the rims the
 * bubble above it has, and nothing in this file computes an x. What is left
 * here is how the stops divide a width the layout hands down, expressed as a
 * style tree `flexFrames` can resolve the way Yoga will.
 *
 * That was always cosmetic: the drag reads a DELTA (effortStopForDelta), so
 * neither the old clamp nor this width can make the control lie.
 *
 * `AUTO` IS A MODE, NOT A LEVEL. `/effort auto` hands the choice back to
 * Claude Code; it is not a seventh notch and it is not below `low`. Putting it
 * on the line would mean dragging past the floor lands on it, which is the one
 * thing the ticket rules out. So it is never on the track and never reachable
 * by dragging; the drag clamps at stop 0. CHOOSING it is a row on the effort
 * sheet, which is what a tap opens (DROVE-229) — it was a pill on the popover
 * until that popover stopped taking touches at all. Its wire value is
 * `effortLevel: null`, which paneModelSync spells `/effort auto` — the reset
 * argument, the same path DROVE-164 fixed.
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
 * from a release. A drag across five stops is five `detent` ticks and zero
 * writes. This matters more than it sounds: every write is a metadata round
 * trip that ends in a `/effort` typed at a live pane.
 *
 * AND A PRESS THAT NEVER MOVED IS A TAP, WHICH IS THE PICKER (DROVE-229).
 * DROVE-200 LATCHED the popover open on a tap instead, with its stops tappable
 * and a five second timer to put it away, so that a tap was not a dead
 * gesture. That latch is what Clay was tapping at: a narrow readout anchored
 * on his finger, which a second tap re-opened and re-armed rather than
 * dismissing, and which had no tap-outside and no back gesture either. It is
 * gone. The popover now lives exactly as long as the finger, so there is no
 * state anyone can be left stuck in, and a tap opens the effort SHEET — the
 * same full-width shell the mode, model, attach and channel pickers use, which
 * brings all three dismissal routes with it and is where `Auto` lives now.
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
import type { FlexNode, FlexStyle } from './flexFrames';
import {
    effortDisplayName,
    getEffortLevelsForModel,
    type AgentFlavor,
    type EffortLevel,
} from './modelModeOptions';

export const EFFORT_SLIDER_METRICS = {
    /** DROVE-153's floor. The popover is a control, so it is a 44pt one. */
    height: 44,
    /**
     * The word slot at the head: the level the thumb is on, or `Auto`.
     *
     * It was a caption floating above the thumb, clamped by hand so it could
     * not hang off either end (DROVE-200). One fixed slot cannot hang off
     * anything, and it is legible in the same place every time.
     */
    labelWidth: 72,
    /** The same rule the capsule draws between its own segments (DROVE-153). */
    dividerWidth: 1,
    /** Air either side of that rule. */
    gap: 10,
    /** A stop the thumb is not on. */
    pipSize: 5,
    thumbSize: 26,
    /**
     * How far the FINGER travels per notch, which is not how far the drawn
     * thumb moves. See the header: the segment has 83pt of room to its left,
     * and the longest scale is six stops, so a full sweep has to fit in 90.
     */
    gestureSpacing: 18,
    /** How far the finger travels before it takes the thumb off its stop. */
    grabSlop: 6,
    /**
     * The narrowest gap that still reads as two stops and not one smear.
     *
     * A FLOOR THE SPEC MEASURES, not a clamp the code applies (DROVE-229).
     * Nothing here packs the stops: the track is a row of equal flex cells and
     * flexbox divides whatever width the composer has. So the question "does
     * the longest scale still read on the narrowest phone" is answered by
     * resolving the real style tree, not by an arithmetic guard that would
     * make the popover disagree with its own container.
     */
    minStopSpacing: 26,
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

/**
 * THE POPOVER'S LAYOUT, as style objects the renderer uses verbatim
 * (DROVE-229, after DROVE-214's `composerBubbleLayout`).
 *
 * There is no `effortSliderPlacement` any more. It took a screen width and an
 * anchor x and returned page coordinates for the popover, the track and every
 * stop, and the renderer drew from those numbers — so a spec could prove the
 * arithmetic and still miss what shipped, which is the failure flexFrames.ts
 * was built for. These are the actual styles. `effortPopoverNode` assembles
 * them into a tree `resolveFlexFrames` measures the way Yoga will, so the spec
 * asserts frames rather than restating constants.
 *
 * NOTHING HERE CARRIES A POSITION. The popover is stretched to the composer's
 * width by its container and the stops are equal flex cells, so a stop's x is
 * something flexbox worked out and not something this file decided.
 */

/** The popover: the word, a hairline, and the track. */
export const EFFORT_POPOVER_GEOMETRY: FlexStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    height: EFFORT_SLIDER_METRICS.height,
    gap: EFFORT_SLIDER_METRICS.gap,
};

/** The word slot. A leaf: it holds one line of text and centres it itself. */
export const EFFORT_POPOVER_LABEL_GEOMETRY: FlexStyle = {
    width: EFFORT_SLIDER_METRICS.labelWidth,
    height: EFFORT_SLIDER_METRICS.height,
};

export const EFFORT_POPOVER_DIVIDER_GEOMETRY: FlexStyle = {
    width: EFFORT_SLIDER_METRICS.dividerWidth,
    height: 20,
};

/** Everything left over after the word, divided into one cell per stop. */
export const EFFORT_POPOVER_TRACK_GEOMETRY: FlexStyle = {
    flex: 1,
    height: EFFORT_SLIDER_METRICS.height,
    flexDirection: 'row',
    alignItems: 'center',
};

/**
 * The rail behind the stops.
 *
 * `left: 0, right: 0` is the placement rule stated in the only two properties
 * that can state it: the track's width is the rail's width, and no x is
 * computed. It is a decoration under the pips, so it is drawn rather than laid
 * out, which is why it is not in the node tree.
 */
export const EFFORT_POPOVER_RAIL_GEOMETRY = {
    position: 'absolute' as const,
    left: 0,
    right: 0,
    height: 3,
    borderRadius: 1.5,
};

/**
 * One stop. Equal cells, so the drawn spacing is the track divided by the
 * scale and nothing multiplies a constant.
 *
 * The vertical padding is what centres the mark in the 44pt cell, spelled as
 * padding rather than `justifyContent` so the resolver sees the same thing the
 * renderer does. Two variants because the two marks are different sizes.
 */
export const EFFORT_POPOVER_STOP_GEOMETRY: FlexStyle = {
    flex: 1,
    height: EFFORT_SLIDER_METRICS.height,
    alignItems: 'center',
    paddingTop: (EFFORT_SLIDER_METRICS.height - EFFORT_SLIDER_METRICS.pipSize) / 2,
    paddingBottom: (EFFORT_SLIDER_METRICS.height - EFFORT_SLIDER_METRICS.pipSize) / 2,
};

export const EFFORT_POPOVER_THUMB_STOP_GEOMETRY: FlexStyle = {
    flex: 1,
    height: EFFORT_SLIDER_METRICS.height,
    alignItems: 'center',
    paddingTop: (EFFORT_SLIDER_METRICS.height - EFFORT_SLIDER_METRICS.thumbSize) / 2,
    paddingBottom: (EFFORT_SLIDER_METRICS.height - EFFORT_SLIDER_METRICS.thumbSize) / 2,
};

export const EFFORT_POPOVER_PIP_GEOMETRY: FlexStyle = {
    width: EFFORT_SLIDER_METRICS.pipSize,
    height: EFFORT_SLIDER_METRICS.pipSize,
    borderRadius: EFFORT_SLIDER_METRICS.pipSize / 2,
};

export const EFFORT_POPOVER_THUMB_GEOMETRY: FlexStyle = {
    width: EFFORT_SLIDER_METRICS.thumbSize,
    height: EFFORT_SLIDER_METRICS.thumbSize,
    borderRadius: EFFORT_SLIDER_METRICS.thumbSize / 2,
};

/**
 * The popover as a style tree, with the thumb on `index`.
 *
 * Named `stop-0` … `stop-n`, `thumb` and `pip-n`, so a spec can find any of
 * them by name and measure where the layout actually put it.
 */
export function effortPopoverNode(count: number, index: number): FlexNode {
    const stops = Math.max(1, Math.round(count));
    const thumbAt = clampIndex(index, stops);
    const cells: FlexNode[] = [];
    for (let stop = 0; stop < stops; stop += 1) {
        const onThumb = stop === thumbAt;
        cells.push({
            name: `stop-${stop}`,
            style: onThumb ? EFFORT_POPOVER_THUMB_STOP_GEOMETRY : EFFORT_POPOVER_STOP_GEOMETRY,
            children: [{
                name: onThumb ? 'thumb' : `pip-${stop}`,
                style: onThumb ? EFFORT_POPOVER_THUMB_GEOMETRY : EFFORT_POPOVER_PIP_GEOMETRY,
            }],
        });
    }
    return {
        name: 'popover',
        style: EFFORT_POPOVER_GEOMETRY,
        children: [
            { name: 'label', style: EFFORT_POPOVER_LABEL_GEOMETRY },
            { name: 'divider', style: EFFORT_POPOVER_DIVIDER_GEOMETRY },
            { name: 'track', style: EFFORT_POPOVER_TRACK_GEOMETRY, children: cells },
        ],
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

/**
 * Up, or not. There is no third phase (DROVE-229): the popover lives exactly
 * as long as the finger, so it cannot be left open with nothing to close it.
 */
export type EffortSliderPhase = 'closed' | 'dragging';

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
    | { type: 'dismiss' };

export type EffortSliderCommit =
    | { kind: 'level'; index: number }
    | { kind: 'auto' };

export interface EffortSliderStep {
    state: EffortSliderState;
    /**
     * The one write. Only ever produced by a release, never by a move, however
     * far the finger goes.
     */
    commit: EffortSliderCommit | null;
    /** A stop was crossed: one interaction tick, subject to DROVE-190. */
    detent: boolean;
    /**
     * The press never moved, so it was a TAP (DROVE-229). The popover is down
     * either way; the caller opens the effort picker.
     */
    tap: boolean;
}

function step(
    state: EffortSliderState,
    commit: EffortSliderCommit | null = null,
    detent: boolean = false,
    tap: boolean = false,
): EffortSliderStep {
    return { state, commit, detent, tap };
}

/**
 * The whole gesture, as a reducer.
 *
 * press-in raises the popover and changes nothing. move slides the thumb and
 * changes nothing. release commits, once, and only if the thumb actually
 * moved. A press that never moved puts the popover down and reports a TAP,
 * which the caller turns into the effort picker (DROVE-229).
 *
 * `count` is the scale's length, which is all the drag needs: it clamps to the
 * run. It used to be a placement, because a placement was also how the popover
 * was drawn; the drawing is the layout's now.
 */
export function effortSliderReduce(
    state: EffortSliderState,
    event: EffortSliderEvent,
    count: number,
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
            if (state.phase !== 'dragging') return step(state);
            if (!state.grabbed && Math.abs(event.x - state.anchorX) < EFFORT_SLIDER_METRICS.grabSlop) {
                return step(state);
            }
            const index = effortStopForDelta(state.anchorIndex, event.x - state.anchorX, count);
            if (state.grabbed && index === state.index) return step(state);
            return step({ ...state, grabbed: true, index }, null, index !== state.index);
        }
        case 'press-out': {
            if (state.phase !== 'dragging') return step(state);
            if (!state.grabbed) return step(effortSliderClosed, null, false, true);
            if (state.index === state.anchorIndex) return step(effortSliderClosed);
            return step(effortSliderClosed, { kind: 'level', index: state.index });
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

function clampIndex(index: number, count: number): number {
    const levels = Math.max(1, Math.round(count));
    return Math.max(0, Math.min(levels - 1, Math.round(index)));
}
