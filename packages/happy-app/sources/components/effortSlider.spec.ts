import { describe, expect, it } from 'vitest';
import type { Metadata } from '@/sync/storageTypes';
import {
    EFFORT_AUTO_INDEX,
    EFFORT_SLIDER_METRICS,
    effortAutoX,
    effortCommitKey,
    effortSliderAccessibility,
    effortSliderClosed,
    effortSliderIndex,
    effortSliderPlacement,
    effortSliderReduce,
    effortSliderScale,
    effortSliderScaleFromLevels,
    effortSliderStopName,
    effortStopForDelta,
    effortStopForX,
    effortStopX,
    type EffortSliderEvent,
    type EffortSliderPlacement,
    type EffortSliderState,
} from './effortSlider';

const screenWidth = 390;

function place(count: number, anchorX: number = 83): EffortSliderPlacement {
    return effortSliderPlacement({ screenWidth, anchorX, count });
}

/** A finger travelling `notches` stops from where it landed. */
function travel(notches: number): number {
    return notches * EFFORT_SLIDER_METRICS.gestureSpacing;
}

function drive(
    events: EffortSliderEvent[],
    placement: EffortSliderPlacement,
    from: EffortSliderState = effortSliderClosed,
) {
    let state = from;
    const commits = [];
    let detents = 0;
    for (const event of events) {
        const step = effortSliderReduce(state, event, placement);
        state = step.state;
        if (step.commit) commits.push(step.commit);
        if (step.detent) detents += 1;
    }
    return { state, commits, detents };
}

describe('the scale is the model\'s, and its ends are the model\'s real ends', () => {
    it('gives Opus 5 the whole Claude run, ultracode included', () => {
        const scale = effortSliderScale('claude', 'claude-opus-5');
        expect(scale.keys).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
        expect(scale.keys[scale.keys.length - 1]).toBe('ultracode');
    });

    it('reads the 1M bracket variant as the model it is a variant of', () => {
        expect(effortSliderScale('claude', 'claude-opus-5[1m]').keys)
            .toEqual(effortSliderScale('claude', 'claude-opus-5').keys);
    });

    it('stops a sub-xhigh Claude model at max, with no xhigh and no ultracode', () => {
        const scale = effortSliderScale('claude', 'claude-opus-4-6');
        expect(scale.keys).toEqual(['low', 'medium', 'high', 'max']);
        expect(scale.keys).not.toContain('xhigh');
        expect(scale.keys).not.toContain('ultracode');
    });

    it('puts every claude-3 below the xhigh line', () => {
        expect(effortSliderScale('claude', 'claude-3-5-sonnet-20241022').keys)
            .toEqual(['low', 'medium', 'high', 'max']);
    });

    it('keeps the whole scale for a Claude model no table has heard of', () => {
        expect(effortSliderScale('claude', 'claude-opus-9').keys)
            .toContain('ultracode');
    });

    it('gives each Codex model exactly what its registry publishes', () => {
        expect(effortSliderScale('codex', 'gpt-5.6-sol').keys)
            .toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
        expect(effortSliderScale('codex', 'gpt-5.6-luna').keys)
            .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
        expect(effortSliderScale('codex', 'a-workspace-model').keys)
            .toEqual(['low', 'medium', 'high', 'xhigh']);
    });

    it('has no line at all for a flavor with no effort', () => {
        expect(effortSliderScale('gemini', 'gemini-3.1-pro-preview').keys).toEqual([]);
    });

    it('takes a rig session\'s published levels rather than a hardcoded table', () => {
        const metadata = {
            client: { id: 'rig' },
            rigMetadataVersion: 1,
            reasoning: { levels: ['off', 'think', 'think-harder'], current: 'think' },
        } as unknown as Metadata;
        expect(effortSliderScale('claude', 'whatever', metadata).keys)
            .toEqual(['off', 'think', 'think-harder']);
    });

    it('drops the picker\'s disabled rows, so the last stop is reachable', () => {
        const scale = effortSliderScaleFromLevels([
            { key: 'low', name: 'Low' },
            { key: 'medium', name: 'Medium' },
            { key: 'ultracode', name: 'Ultracode', disabled: true, description: 'needs Opus 4.7+' },
        ]);
        expect(scale.keys).toEqual(['low', 'medium']);
    });

    it('names each stop with the display spelling, xHigh included', () => {
        expect(effortSliderScale('claude', 'claude-opus-5').names)
            .toEqual(['Low', 'Medium', 'High', 'xHigh', 'Max', 'Ultracode']);
    });
});

describe('switching model re-scales the line', () => {
    it('moves ultracode from the sixth stop to the ceiling of a shorter scale', () => {
        const wide = effortSliderScale('claude', 'claude-opus-5');
        const narrow = effortSliderScale('claude', 'claude-opus-4-6');
        expect(effortSliderIndex(wide, 'ultracode')).toBe(5);
        // Off the new scale entirely, so it lands on what the new model can
        // actually run, which is where updateModelMode puts it too.
        expect(effortSliderIndex(narrow, 'ultracode')).toBe(3);
        expect(narrow.keys[3]).toBe('max');
    });

    it('keeps a level that survives the change on its own key, not its old index', () => {
        const wide = effortSliderScale('claude', 'claude-opus-5');
        const narrow = effortSliderScale('claude', 'claude-opus-4-6');
        expect(effortSliderIndex(wide, 'high')).toBe(2);
        expect(effortSliderIndex(narrow, 'high')).toBe(2);
        expect(effortSliderIndex(effortSliderScale('codex', 'gpt-5.6-luna'), 'max')).toBe(4);
    });

    it('reads no effort as auto, which is off the run', () => {
        const scale = effortSliderScale('claude', 'claude-opus-5');
        expect(effortSliderIndex(scale, null)).toBe(EFFORT_AUTO_INDEX);
        expect(effortSliderIndex(scale, undefined)).toBe(EFFORT_AUTO_INDEX);
        expect(effortSliderIndex(scale, '')).toBe(EFFORT_AUTO_INDEX);
    });

    it('has nowhere to put a thumb when the model offers no scale', () => {
        expect(effortSliderIndex({ keys: [], names: [] }, 'high')).toBe(EFFORT_AUTO_INDEX);
    });
});

describe('the popover is drawn around the finger, and the drawing decides nothing', () => {
    it('centres on the touch when there is room', () => {
        const placement = place(4, 190);
        expect(placement.left + placement.width / 2).toBeCloseTo(190, 5);
    });

    it('never runs off either edge of the screen', () => {
        const m = EFFORT_SLIDER_METRICS;
        const atLeft = place(6, 30);
        expect(atLeft.left).toBeGreaterThanOrEqual(m.edgeMargin);
        const atRight = place(6, screenWidth - 30);
        expect(atRight.left + atRight.width).toBeLessThanOrEqual(screenWidth - m.edgeMargin);
    });

    it('holds the stop gap between its bounds however long the scale is', () => {
        const m = EFFORT_SLIDER_METRICS;
        for (const count of [2, 4, 5, 6, 9]) {
            const placement = place(count);
            expect(placement.spacing).toBeGreaterThanOrEqual(m.minStopSpacing);
            expect(placement.spacing).toBeLessThanOrEqual(m.maxStopSpacing);
        }
    });

    it('has no gap to hold on a one-stop scale', () => {
        expect(place(1).spacing).toBe(0);
    });

    it('puts the ends of the drawn track at the ends of the run', () => {
        const placement = place(6);
        expect(effortStopX(0, placement)).toBeCloseTo(placement.trackLeft, 5);
        expect(effortStopX(5, placement) - effortStopX(0, placement))
            .toBeCloseTo(placement.spacing * 5, 5);
        // The auto pill is left of the track's first stop, off the run.
        expect(effortAutoX(placement)).toBeLessThan(effortStopX(0, placement));
    });

    it('lands on the same stop wherever the popover was clamped to', () => {
        // The same drag, from a popover pinned at the left edge and one pinned
        // at the right. Placement is cosmetic; the delta is the control.
        const atLeft = place(6, 20);
        const atRight = place(6, screenWidth - 20);
        expect(atLeft.left).not.toBe(atRight.left);
        expect(effortStopForDelta(2, travel(2), atLeft.count))
            .toBe(effortStopForDelta(2, travel(2), atRight.count));
    });
});

describe('the drag lands on stops, and never falls off the run onto auto', () => {
    it('moves one stop per notch of travel, in either direction', () => {
        expect(effortStopForDelta(2, travel(2), 6)).toBe(4);
        expect(effortStopForDelta(2, -travel(1), 6)).toBe(1);
        expect(effortStopForDelta(2, 0, 6)).toBe(2);
    });

    it('crosses the longest scale inside the room the segment actually has', () => {
        // The effort segment sits about 83pt from the left edge, so a leftward
        // sweep of the whole six-stop scale has to fit in that.
        expect(travel(5)).toBeLessThanOrEqual(90);
        expect(effortStopForDelta(5, -travel(5), 6)).toBe(0);
    });

    it('stays on the floor when the finger keeps going left', () => {
        expect(effortStopForDelta(3, -500, 6)).toBe(0);
    });

    it('stays on the ceiling when the finger keeps going right', () => {
        expect(effortStopForDelta(3, 500, 6)).toBe(5);
    });

    it('never reports auto, because auto is not on the line', () => {
        for (let dx = -400; dx < 400; dx += 3) {
            expect(effortStopForDelta(3, dx, 6)).toBeGreaterThanOrEqual(0);
            expect(effortStopForDelta(EFFORT_AUTO_INDEX, dx, 6)).toBeGreaterThanOrEqual(0);
        }
    });

    it('hit-tests a tap on a latched popover by where the stop is drawn', () => {
        const placement = place(6, 190);
        expect(effortStopForX(effortStopX(2, placement) + 3, placement)).toBe(2);
        expect(effortStopForX(effortStopX(2, placement) + placement.spacing * 0.6, placement)).toBe(3);
        expect(effortStopForX(placement.trackLeft - 500, placement)).toBe(0);
        expect(effortStopForX(effortStopX(5, placement) + 500, placement)).toBe(5);
    });
});

describe('one write, on release, never per movement', () => {
    const placement = place(6, 83);
    const start = 83;

    it('writes nothing on press-in', () => {
        const run = drive([{ type: 'press-in', x: start, index: 2 }], placement);
        expect(run.commits).toEqual([]);
        expect(run.state.phase).toBe('dragging');
    });

    it('writes nothing across a drag over the whole scale, and ticks once per stop', () => {
        const events: EffortSliderEvent[] = [{ type: 'press-in', x: start, index: 2 }];
        // Every 2pt from the third stop to the sixth: thirty-odd moves.
        for (let dx = 0; dx <= travel(3); dx += 2) {
            events.push({ type: 'move', x: start + dx });
        }
        const run = drive(events, placement);
        expect(run.commits).toEqual([]);
        expect(run.state.index).toBe(5);
        // Three stops crossed, three ticks, whatever the sample rate was.
        expect(run.detents).toBe(3);
    });

    it('writes exactly once, on release, with the stop it landed on', () => {
        const run = drive([
            { type: 'press-in', x: start, index: 2 },
            { type: 'move', x: start + travel(2) },
            { type: 'move', x: start + travel(3) },
            { type: 'press-out' },
        ], placement);
        expect(run.commits).toEqual([{ kind: 'level', index: 5 }]);
        expect(run.state.phase).toBe('closed');
    });

    it('writes nothing when the finger wanders and comes home', () => {
        const run = drive([
            { type: 'press-in', x: start, index: 2 },
            { type: 'move', x: start + travel(3) },
            { type: 'move', x: start },
            { type: 'press-out' },
        ], placement);
        expect(run.commits).toEqual([]);
    });

    it('ignores a twitch inside the slop, so a tap cannot become a drag', () => {
        const run = drive([
            { type: 'press-in', x: start, index: 2 },
            { type: 'move', x: start + EFFORT_SLIDER_METRICS.grabSlop - 1 },
            { type: 'press-out' },
        ], placement);
        expect(run.commits).toEqual([]);
        // A press that never moved latches the popover open instead of
        // flashing it: the stops are the picker now.
        expect(run.state.phase).toBe('open');
    });

    it('ignores a move that arrives with no gesture running', () => {
        const step = effortSliderReduce(effortSliderClosed, { type: 'move', x: 300 }, placement);
        expect(step.state).toBe(effortSliderClosed);
        expect(step.commit).toBeNull();
    });

    it('ignores a move before the popover has been laid out', () => {
        const opened = effortSliderReduce(effortSliderClosed, { type: 'press-in', x: start, index: 2 }, null);
        const moved = effortSliderReduce(opened.state, { type: 'move', x: start + travel(3) }, null);
        expect(moved.state.index).toBe(2);
        expect(moved.commit).toBeNull();
    });

    it('writes once when a latched stop is tapped, and not when it is the one already set', () => {
        const latched = drive([
            { type: 'press-in', x: start, index: 2 },
            { type: 'press-out' },
        ], placement).state;
        expect(drive([{ type: 'tap-stop', index: 4 }], placement, latched).commits)
            .toEqual([{ kind: 'level', index: 4 }]);
        expect(drive([{ type: 'tap-stop', index: 2 }], placement, latched).commits).toEqual([]);
    });

    it('writes nothing when the popover is not up', () => {
        expect(drive([{ type: 'tap-stop', index: 4 }], placement).commits).toEqual([]);
        expect(drive([{ type: 'tap-auto' }], placement).commits).toEqual([]);
    });

    it('closes on a dismiss without writing', () => {
        const run = drive([
            { type: 'press-in', x: start, index: 2 },
            { type: 'dismiss' },
        ], placement);
        expect(run.commits).toEqual([]);
        expect(run.state.phase).toBe('closed');
    });
});

describe('auto is a mode, reachable but off the ordered run', () => {
    const scale = effortSliderScale('claude', 'claude-opus-5');
    const placement = place(6, 83);
    const latchedFrom = (index: number) => drive([
        { type: 'press-in', x: 83, index },
        { type: 'press-out' },
    ], placement).state;

    it('is one tap from anywhere on the scale', () => {
        const run = drive([{ type: 'tap-auto' }], placement, latchedFrom(4));
        expect(run.commits).toEqual([{ kind: 'auto' }]);
        expect(run.state.phase).toBe('closed');
    });

    it('is not a level, so it has no key: the wire value is the reset', () => {
        expect(effortCommitKey(scale, { kind: 'auto' })).toBeNull();
        expect(effortCommitKey(scale, { kind: 'level', index: 5 })).toBe('ultracode');
        expect(effortCommitKey(scale, { kind: 'level', index: 0 })).toBe('low');
    });

    it('writes nothing when the session is already on auto', () => {
        expect(drive([{ type: 'tap-auto' }], placement, latchedFrom(EFFORT_AUTO_INDEX)).commits)
            .toEqual([]);
    });

    it('cannot be dragged onto from the floor, however far left the finger goes', () => {
        const run = drive([
            { type: 'press-in', x: 83, index: 1 },
            { type: 'move', x: 83 - travel(1) },
            { type: 'move', x: 83 - travel(9) },
            { type: 'press-out' },
        ], placement);
        expect(run.commits).toEqual([{ kind: 'level', index: 0 }]);
    });

    it('starts a gesture from auto and climbs onto the scale from the floor', () => {
        const run = drive([
            { type: 'press-in', x: 83, index: EFFORT_AUTO_INDEX },
            { type: 'move', x: 83 + travel(3) },
            { type: 'press-out' },
        ], placement);
        expect(run.commits).toEqual([{ kind: 'level', index: 3 }]);
    });

    it('cannot be dragged back onto once the gesture has left it', () => {
        const run = drive([
            { type: 'press-in', x: 83, index: EFFORT_AUTO_INDEX },
            { type: 'move', x: 83 + travel(2) },
            { type: 'move', x: 83 - travel(9) },
            { type: 'press-out' },
        ], placement);
        expect(run.commits).toEqual([{ kind: 'level', index: 0 }]);
    });

    it('says so in words, and names where a level sits on its scale', () => {
        expect(effortSliderStopName(scale, EFFORT_AUTO_INDEX)).toBe('Auto');
        expect(effortSliderStopName(scale, 5)).toBe('Ultracode');
        expect(effortSliderAccessibility(scale, EFFORT_AUTO_INDEX).value).toBe('Auto, chosen for you');
        expect(effortSliderAccessibility(scale, 5)).toEqual({
            label: 'Reasoning effort',
            value: 'Ultracode, 6 of 6',
        });
        expect(effortSliderAccessibility(effortSliderScale('claude', 'claude-opus-4-6'), 3).value)
            .toBe('Max, 4 of 4');
    });
});

describe('the touch target floor survives (DROVE-153)', () => {
    it('draws the popover at 44pt, and never packs stops tighter than a readable gap', () => {
        expect(EFFORT_SLIDER_METRICS.height).toBeGreaterThanOrEqual(44);
        expect(EFFORT_SLIDER_METRICS.minStopSpacing).toBeGreaterThanOrEqual(26);
    });

    it('fits the longest scale on the narrowest phone without shrinking past that floor', () => {
        const narrow = effortSliderPlacement({ screenWidth: 320, anchorX: 83, count: 6 });
        expect(narrow.spacing).toBeGreaterThanOrEqual(EFFORT_SLIDER_METRICS.minStopSpacing);
        expect(narrow.left).toBeGreaterThanOrEqual(EFFORT_SLIDER_METRICS.edgeMargin);
        expect(narrow.left + narrow.width).toBeLessThanOrEqual(320 - EFFORT_SLIDER_METRICS.edgeMargin);
    });
});
