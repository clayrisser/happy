import { describe, expect, it } from 'vitest';
import type { Metadata } from '@/sync/storageTypes';
import {
    MOBILE_COMPOSER_METRICS,
    resolveMobileComposerEffortLayerGeometry,
} from './agentInputLayout';
import { findFrame, resolveFlexFrames, type FlexFrame } from './flexFrames';
import {
    EFFORT_AUTO_INDEX,
    EFFORT_POPOVER_DIVIDER_GEOMETRY,
    EFFORT_POPOVER_GEOMETRY,
    EFFORT_POPOVER_LABEL_GEOMETRY,
    EFFORT_POPOVER_PIP_GEOMETRY,
    EFFORT_POPOVER_STOP_GEOMETRY,
    EFFORT_POPOVER_THUMB_GEOMETRY,
    EFFORT_POPOVER_THUMB_STOP_GEOMETRY,
    EFFORT_POPOVER_TRACK_GEOMETRY,
    EFFORT_SLIDER_METRICS,
    effortCommitKey,
    effortPopoverNode,
    effortSliderAccessibility,
    effortSliderClosed,
    effortSliderIndex,
    effortSliderReduce,
    effortSliderScale,
    effortSliderScaleFromLevels,
    effortSliderStopName,
    effortStopForDelta,
    type EffortSliderEvent,
    type EffortSliderState,
} from './effortSlider';

const screenWidth = 390;

/** A finger travelling `notches` stops from where it landed. */
function travel(notches: number): number {
    return notches * EFFORT_SLIDER_METRICS.gestureSpacing;
}

function drive(
    events: EffortSliderEvent[],
    count: number,
    from: EffortSliderState = effortSliderClosed,
) {
    let state = from;
    const commits = [];
    let detents = 0;
    let taps = 0;
    for (const event of events) {
        const step = effortSliderReduce(state, event, count);
        state = step.state;
        if (step.commit) commits.push(step.commit);
        if (step.detent) detents += 1;
        if (step.tap) taps += 1;
    }
    return { state, commits, detents, taps };
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

/**
 * THE ONE PLACEMENT RULE (DROVE-229).
 *
 * Clay: "Allow me to actually size this and actually fully cover the width
 * right when I click this. Or at least have it centered." Full width, for
 * every composer picker. The sheets already had it from ComposerSheet; this
 * readout was the last surface placing itself by hand.
 *
 * These assertions RESOLVE the real style objects the renderer uses, through
 * the same flexbox resolver DROVE-214 built, so a stop's x is measured and not
 * restated. The old spec proved arithmetic that the renderer then drew from,
 * which is the failure mode both tickets are about.
 */
describe('the readout fills the composer, and the layout is what fills it', () => {
    const composerWidth = (screen: number) => screen - MOBILE_COMPOSER_METRICS.shellInset * 2;
    const layer = resolveMobileComposerEffortLayerGeometry();

    function layout(count: number, index = 0, screen = screenWidth): FlexFrame {
        return resolveFlexFrames(effortPopoverNode(count, index), composerWidth(screen));
    }

    const centreX = (frame: { x: number; width: number }) => frame.x + frame.width / 2;

    function stopCentres(frames: FlexFrame, count: number): number[] {
        const centres: number[] = [];
        for (let stop = 0; stop < count; stop += 1) {
            centres.push(centreX(findFrame(frames, `stop-${stop}`)));
        }
        return centres;
    }

    it('states the rule in the only two properties that can state it', () => {
        // Not an anchor and not a computed x: the container stretches it, and
        // the gutter is the same token the bubble line carries.
        expect(layer.left).toBe(0);
        expect(layer.right).toBe(0);
        expect(layer.paddingHorizontal).toBe(MOBILE_COMPOSER_METRICS.shellInset);
    });

    it('clears the control row it sits above, whatever the row does', () => {
        expect(layer.bottom).toBeGreaterThanOrEqual(
            MOBILE_COMPOSER_METRICS.actionRowHeight + MOBILE_COMPOSER_METRICS.controlsBottomGap,
        );
    });

    it('is exactly as wide as the bubble above it, on every phone', () => {
        for (const screen of [320, 375, 390, 430]) {
            expect(layout(6, 3, screen).width).toBe(composerWidth(screen));
        }
    });

    it('spreads the stops evenly across whatever width it was handed', () => {
        const centres = stopCentres(layout(6, 3), 6);
        const gaps = centres.slice(1).map((x, i) => x - centres[i]);
        for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0], 5);
    });

    it('centres the thumb on the stop it is on, at either end and in between', () => {
        for (const index of [0, 3, 5]) {
            const frames = layout(6, index);
            expect(centreX(findFrame(frames, 'thumb')))
                .toBeCloseTo(centreX(findFrame(frames, `stop-${index}`)), 5);
        }
    });

    it('draws a pip on every other stop and never two thumbs', () => {
        const frames = layout(6, 2);
        expect(findFrame(frames, 'pip-2')).toBeUndefined();
        for (const stop of [0, 1, 3, 4, 5]) {
            expect(findFrame(frames, `pip-${stop}`)).toBeTruthy();
        }
    });

    it('keeps every mark inside the popover, so nothing hangs off a rim', () => {
        for (const count of [1, 2, 4, 6, 9]) {
            for (const index of [0, count - 1]) {
                const frames = layout(count, index);
                const thumb = findFrame(frames, 'thumb');
                expect(thumb.x).toBeGreaterThanOrEqual(0);
                expect(thumb.x + thumb.width).toBeLessThanOrEqual(frames.width);
            }
        }
    });

    it('holds a readable stop gap on the narrowest phone anyone runs', () => {
        // The floor is MEASURED here, not clamped in the code: flexbox divides
        // the track and this asks whether the answer still reads as stops.
        const centres = stopCentres(layout(6, 0, 320), 6);
        expect(centres[1] - centres[0]).toBeGreaterThanOrEqual(EFFORT_SLIDER_METRICS.minStopSpacing);
    });

    it('gives the word a slot of its own, ahead of every stop', () => {
        const frames = layout(6, 0);
        const label = findFrame(frames, 'label');
        expect(label.width).toBe(EFFORT_SLIDER_METRICS.labelWidth);
        expect(label.x + label.width).toBeLessThanOrEqual(findFrame(frames, 'stop-0').x);
    });

    it('has one stop and no gap when the model offers one level', () => {
        const frames = layout(1, 0);
        expect(findFrame(frames, 'stop-0').width).toBe(findFrame(frames, 'track').width);
    });

    it('refuses any hand-placed offset in the readout\'s geometry', () => {
        for (const geometry of [
            EFFORT_POPOVER_GEOMETRY,
            EFFORT_POPOVER_LABEL_GEOMETRY,
            EFFORT_POPOVER_DIVIDER_GEOMETRY,
            EFFORT_POPOVER_TRACK_GEOMETRY,
            EFFORT_POPOVER_STOP_GEOMETRY,
            EFFORT_POPOVER_THUMB_STOP_GEOMETRY,
            EFFORT_POPOVER_PIP_GEOMETRY,
            EFFORT_POPOVER_THUMB_GEOMETRY,
        ]) {
            for (const key of ['position', 'top', 'bottom', 'left', 'right', 'marginLeft', 'marginRight']) {
                expect(geometry).not.toHaveProperty(key);
            }
        }
    });

    it('reproduces the anchored popover it replaces, so what changed is on the record', () => {
        // DROVE-200's `effortSliderPlacement`, modelled by hand: a fixed
        // chrome, a stop gap clamped to at most 44, and a left edge centred on
        // the finger and clamped to an 8pt screen margin.
        const anchored = (anchorX: number, count = 6) => {
            const chrome = 52 + 10 + 22 * 2;
            const room = screenWidth - 8 * 2 - chrome;
            const spacing = Math.max(26, Math.min(room / (count - 1), 44));
            const width = chrome + spacing * (count - 1);
            const highest = Math.max(8, screenWidth - 8 - width);
            return { left: Math.max(8, Math.min(anchorX - width / 2, highest)), width };
        };
        // Narrower than the composer, by most of a stop.
        expect(anchored(83).width).toBe(326);
        expect(anchored(83).width).toBeLessThan(composerWidth(screenWidth));
        // And its left edge was wherever the finger was, clamped: the effort
        // segment sits about 83pt in, so it pinned against the screen's edge
        // rather than landing under the control or spanning the composer.
        expect(anchored(83).left).toBe(8);
        expect(anchored(300).left).not.toBe(anchored(83).left);
        // Neither full width nor centred, which is the whole of Clay's message.
        expect(anchored(83).left + anchored(83).width / 2).not.toBeCloseTo(screenWidth / 2, 0);
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

});

describe('one write, on release, never per movement', () => {
    const count = 6;
    const start = 83;

    it('writes nothing on press-in', () => {
        const run = drive([{ type: 'press-in', x: start, index: 2 }], count);
        expect(run.commits).toEqual([]);
        expect(run.state.phase).toBe('dragging');
    });

    it('writes nothing across a drag over the whole scale, and ticks once per stop', () => {
        const events: EffortSliderEvent[] = [{ type: 'press-in', x: start, index: 2 }];
        // Every 2pt from the third stop to the sixth: thirty-odd moves.
        for (let dx = 0; dx <= travel(3); dx += 2) {
            events.push({ type: 'move', x: start + dx });
        }
        const run = drive(events, count);
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
        ], count);
        expect(run.commits).toEqual([{ kind: 'level', index: 5 }]);
        expect(run.state.phase).toBe('closed');
    });

    it('writes nothing when the finger wanders and comes home', () => {
        const run = drive([
            { type: 'press-in', x: start, index: 2 },
            { type: 'move', x: start + travel(3) },
            { type: 'move', x: start },
            { type: 'press-out' },
        ], count);
        expect(run.commits).toEqual([]);
    });

    it('ignores a twitch inside the slop, so a tap cannot become a drag', () => {
        const run = drive([
            { type: 'press-in', x: start, index: 2 },
            { type: 'move', x: start + EFFORT_SLIDER_METRICS.grabSlop - 1 },
            { type: 'press-out' },
        ], count);
        expect(run.commits).toEqual([]);
        // A press that never moved is a TAP: the readout goes down and the
        // caller opens the effort picker (DROVE-229).
        expect(run.taps).toBe(1);
        expect(run.state.phase).toBe('closed');
    });

    it('ignores a move that arrives with no gesture running', () => {
        const step = effortSliderReduce(effortSliderClosed, { type: 'move', x: 300 }, count);
        expect(step.state).toBe(effortSliderClosed);
        expect(step.commit).toBeNull();
    });

    it('closes on a dismiss without writing', () => {
        const run = drive([
            { type: 'press-in', x: start, index: 2 },
            { type: 'dismiss' },
        ], count);
        expect(run.commits).toEqual([]);
        expect(run.state.phase).toBe('closed');
    });
});

describe('auto is a mode, reachable but off the ordered run', () => {
    const scale = effortSliderScale('claude', 'claude-opus-5');
    const count = 6;

    it('is not a level, so it has no key: the wire value is the reset', () => {
        expect(effortCommitKey(scale, { kind: 'auto' })).toBeNull();
        expect(effortCommitKey(scale, { kind: 'level', index: 5 })).toBe('ultracode');
        expect(effortCommitKey(scale, { kind: 'level', index: 0 })).toBe('low');
    });

    it('is chosen on the SHEET now, and the line only reports the tap that opens it', () => {
        // DROVE-200 put a tappable `Auto` pill on the popover, which is the
        // surface DROVE-229 stopped taking touches on. A press that never
        // moved is a tap, the readout goes down, and the caller opens the
        // effort picker, where `Auto` is a row.
        const run = drive([
            { type: 'press-in', x: 83, index: 4 },
            { type: 'press-out' },
        ], count);
        expect(run.taps).toBe(1);
        expect(run.commits).toEqual([]);
        expect(run.state.phase).toBe('closed');
    });

    it('cannot be dragged onto from the floor, however far left the finger goes', () => {
        const run = drive([
            { type: 'press-in', x: 83, index: 1 },
            { type: 'move', x: 83 - travel(1) },
            { type: 'move', x: 83 - travel(9) },
            { type: 'press-out' },
        ], count);
        expect(run.commits).toEqual([{ kind: 'level', index: 0 }]);
    });

    it('starts a gesture from auto and climbs onto the scale from the floor', () => {
        const run = drive([
            { type: 'press-in', x: 83, index: EFFORT_AUTO_INDEX },
            { type: 'move', x: 83 + travel(3) },
            { type: 'press-out' },
        ], count);
        expect(run.commits).toEqual([{ kind: 'level', index: 3 }]);
    });

    it('cannot be dragged back onto once the gesture has left it', () => {
        const run = drive([
            { type: 'press-in', x: 83, index: EFFORT_AUTO_INDEX },
            { type: 'move', x: 83 + travel(2) },
            { type: 'move', x: 83 - travel(9) },
            { type: 'press-out' },
        ], count);
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
    it('draws the readout at 44pt, the same as every other composer control', () => {
        expect(EFFORT_SLIDER_METRICS.height).toBeGreaterThanOrEqual(44);
        expect(EFFORT_POPOVER_GEOMETRY.height).toBe(EFFORT_SLIDER_METRICS.height);
    });
});

/**
 * "And if I click a second time it will go away." On this control there is no
 * second time to worry about: the readout is up for the length of a press and
 * takes no touches, so it cannot be left open by any route. What a tap opens
 * is the sheet, and composerPicker.spec.ts holds the second tap there.
 */
describe('the readout cannot be left up (DROVE-229)', () => {
    const count = 6;

    it('has two phases, so there is no state to be stuck in', () => {
        const held = drive([{ type: 'press-in', x: 83, index: 2 }], count);
        expect(held.state.phase).toBe('dragging');
        expect(drive([{ type: 'press-out' }], count, held.state).state.phase).toBe('closed');
    });

    it('goes down on a tap, on a drag that changed nothing, and on a commit', () => {
        const tapped = drive([
            { type: 'press-in', x: 83, index: 2 },
            { type: 'press-out' },
        ], count);
        expect(tapped.state.phase).toBe('closed');
        expect(tapped.taps).toBe(1);

        const wandered = drive([
            { type: 'press-in', x: 83, index: 2 },
            { type: 'move', x: 83 + travel(2) },
            { type: 'move', x: 83 },
            { type: 'press-out' },
        ], count);
        expect(wandered.state.phase).toBe('closed');
        expect(wandered.taps).toBe(0);

        const committed = drive([
            { type: 'press-in', x: 83, index: 2 },
            { type: 'move', x: 83 + travel(2) },
            { type: 'press-out' },
        ], count);
        expect(committed.state.phase).toBe('closed');
        expect(committed.commits).toEqual([{ kind: 'level', index: 4 }]);
    });

    it('goes down when the responder is taken off it mid-gesture', () => {
        const run = drive([
            { type: 'press-in', x: 83, index: 2 },
            { type: 'move', x: 83 + travel(2) },
            { type: 'dismiss' },
        ], count);
        expect(run.state.phase).toBe('closed');
        expect(run.commits).toEqual([]);
    });

    it('reports a tap exactly once, so one press cannot open two pickers', () => {
        const run = drive([
            { type: 'press-in', x: 83, index: 2 },
            { type: 'press-out' },
            { type: 'press-out' },
        ], count);
        expect(run.taps).toBe(1);
    });
});
