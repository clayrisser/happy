import { describe, expect, it } from 'vitest';
import type { Metadata } from '@/sync/storageTypes';
import * as effortSliderModule from './effortSlider';
import {
    EFFORT_AUTO_INDEX,
    effortSliderIndex,
    effortSliderScale,
    effortSliderScaleFromLevels,
} from './effortSlider';

/**
 * WHAT IS LEFT OF THE SLIDER IS THE SCALE (DROVE-242).
 *
 * This file used to spec a drag: the popover's layout resolved through
 * flexFrames, the delta-to-stop mapping, the one-write-on-release reducer, and
 * the tap that DROVE-229 turned into the sheet. Clay, with a screenshot of that
 * readout over his field: "Why does it show the old shitty slider when I hold
 * down effort?" The drag is deleted and effort is a picker segment like the
 * mode and the model beside it, so those assertions describe nothing now.
 *
 * The scale was never the drag's. The DIAL reads it for the needle's angle and
 * the sheet reads it for its rows, and both did before DROVE-200 existed, so
 * every assertion below is the same one it was.
 */

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

describe('the drag is gone, and nothing can raise it (DROVE-242)', () => {
    it('exports no gesture and no popover geometry any more', () => {
        // The whole point of the deletion: there is no second surface for
        // effort to live on, so no gesture can put one up. A press on the
        // segment opens the same sheet the mode and the model open, which is
        // the only place effort is set from now.
        for (const gone of [
            'effortSliderReduce',
            'effortStopForDelta',
            'effortSliderClosed',
            'effortCommitKey',
            'effortPopoverNode',
            'EFFORT_SLIDER_METRICS',
            'EFFORT_POPOVER_GEOMETRY',
            'EFFORT_POPOVER_TRACK_GEOMETRY',
        ]) {
            expect(gone in effortSliderModule, gone).toBe(false);
        }
    });

    it('keeps only what the dial and the sheet read', () => {
        expect(Object.keys(effortSliderModule).sort()).toEqual([
            'EFFORT_AUTO_INDEX',
            'effortSliderIndex',
            'effortSliderScale',
            'effortSliderScaleFromLevels',
        ]);
    });
});
