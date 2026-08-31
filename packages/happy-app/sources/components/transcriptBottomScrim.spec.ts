import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    CHAT_BOTTOM_SCRIM_OVERLAY_OPACITY,
    DOCK_CONTENT_BOTTOM_PADDING,
    STATUS_ROW_BOTTOM_CLEARANCE,
    TRANSCRIPT_GLASS_ALPHA,
    resolveDockBottomOffset,
    resolveDockInset,
    resolveTranscriptBottomScrim,
    scrimTransmission,
} from './agentDockLayout';
import {
    MOBILE_HEADER_EDGE_RAMP_POINTS,
    MOBILE_STRONG_HEADER_SCRIM_RESTING_OPACITY,
    MOBILE_STRONG_HEADER_SCRIM_UNDERLAP_OPACITY,
    STRONG_TINT_PEAK_DARK,
    STRONG_TINT_PEAK_LIGHT,
} from './navigation/mobileHeaderScrimMetrics';

/**
 * DROVE-219. Clay, with the chat on screen: "Why is the fade mask at the
 * bottom not masking the fade mask at the top".
 *
 * The answer these tests pin down is that the bottom was never short of DIM.
 * `resolveTranscriptMask` already takes the transcript to TRANSCRIPT_GLASS_ALPHA
 * behind the composer, which lands inside the header's own range. What it had
 * no part of is the header's BLUR, and alpha does not soften an edge, which is
 * why "Ran 2 shell commands" read sharp in the gaps between the bubble, the
 * control row and the status strip.
 */

const sourcesRoot = resolve(__dirname, '..');
const contentView = readFileSync(
    join(sourcesRoot, 'components/AgentContentView.ios.tsx'),
    'utf8',
);
const scrim = readFileSync(
    join(sourcesRoot, 'components/navigation/MobileHeaderScrim.tsx'),
    'utf8',
);

// Clay's handset, the same numbers agentDockLayout.test.ts measures against.
const safeAreaBottom = 34;
const dockBottomOffset = STATUS_ROW_BOTTOM_CLEARANCE - DOCK_CONTENT_BOTTOM_PADDING;
const composerOnly = 76;
const withControlRow = composerOnly + 44;
const withControlRowAndStatus = withControlRow + 24;
/** Three lines of typing, which is what makes a fixed-height mask wrong. */
const multiLineField = withControlRowAndStatus + 40;

describe('the bottom fade hangs off the composer, not off a number', () => {
    it('covers exactly what the composer occupies, gap over the indicator included', () => {
        const bottom = resolveTranscriptBottomScrim(withControlRowAndStatus, safeAreaBottom);
        expect(bottom.visible).toBe(true);
        expect(bottom.height).toBe(withControlRowAndStatus + dockBottomOffset);
        expect(bottom.overhang).toBe(dockBottomOffset);
    });

    it('is the same band the chat list already reserves, so the two cannot drift', () => {
        for (const dockHeight of [composerOnly, withControlRow, withControlRowAndStatus, multiLineField]) {
            expect(resolveTranscriptBottomScrim(dockHeight, safeAreaBottom).height).toBe(
                resolveDockInset({ dockHeight, safeAreaBottom, floatingDock: true }),
            );
        }
    });

    it('grows point for point with the field and with the control row', () => {
        const base = resolveTranscriptBottomScrim(composerOnly, safeAreaBottom).height;
        expect(resolveTranscriptBottomScrim(withControlRow, safeAreaBottom).height - base)
            .toBe(withControlRow - composerOnly);
        expect(resolveTranscriptBottomScrim(multiLineField, safeAreaBottom).height - base)
            .toBe(multiLineField - composerOnly);
    });

    it('reaches below the dock frame by the gap under it, and no further', () => {
        for (const inset of [0, 10, 20, 34, 44]) {
            const bottom = resolveTranscriptBottomScrim(withControlRowAndStatus, inset);
            expect(bottom.overhang).toBe(resolveDockBottomOffset(inset, true));
            expect(bottom.height - bottom.overhang).toBe(withControlRowAndStatus);
        }
    });

    it('paints nothing until the dock has been measured', () => {
        const unmeasured = resolveTranscriptBottomScrim(0, safeAreaBottom);
        expect(unmeasured).toEqual({ visible: false, overhang: 0, height: 0 });
    });
});

describe('top and bottom are one definition, mirrored', () => {
    it('mounts the header’s own scrim at the bottom rather than a second gradient', () => {
        expect(contentView).toContain("from './navigation/MobileHeaderScrim'");
        expect(contentView).toContain('<MobileHeaderScrim');
        expect(contentView).toContain('edge="bottom"');
    });

    it('branches the two edges on direction only, never on colour', () => {
        // The stops are computed ONCE and both edges read the same arrays; all
        // `edge` decides is which end of the box the ramp starts from. That is
        // what makes the bottom the top mirrored instead of a copy of it.
        expect(scrim).toContain('start={edge === \'bottom\' ? BOTTOM_START : TOP_START}');
        expect(scrim).toContain('end={edge === \'bottom\' ? BOTTOM_END : TOP_END}');
        expect(scrim).not.toMatch(/colors=\{edge/);
        expect(scrim).not.toMatch(/locations=\{edge/);
        // One ramp length for both, and it is the header's.
        expect(scrim.match(/MOBILE_HEADER_EDGE_RAMP_POINTS/g)?.length).toBeGreaterThan(0);
        expect(MOBILE_HEADER_EDGE_RAMP_POINTS).toBe(36);
    });

    it('keeps the chat out of the business of defining a fade of its own', () => {
        // The chat still owns the DROVE-180 alpha mask, which is a different
        // job. What it must not own is a second feather: no ramp constant, no
        // hand-placed stops for the bottom edge.
        expect(contentView).not.toContain('feather(');
        expect(contentView).not.toContain('EDGE_RAMP');
    });
});

describe('nothing in the composer is dimmed by it', () => {
    it('is painted before the composer, inside the same measured box', () => {
        const dock = contentView.slice(contentView.indexOf('bottomScrim.visible'));
        expect(dock.indexOf('<MobileHeaderScrim')).toBeLessThan(dock.indexOf('{input}'));
    });

    it('answers no touches, so the control row keeps every press', () => {
        const mount = contentView.slice(
            contentView.indexOf('{bottomScrim.visible'),
            contentView.indexOf('{input}', contentView.indexOf('{bottomScrim.visible')),
        );
        expect(mount).toContain('pointerEvents="none"');
    });

    it('rides the dock’s own keyboard transform instead of animating a mask', () => {
        // It lives inside the dock's Animated.View, which already carries
        // `animatedInputStyle`. With the keyboard up the fade lands on the
        // composer at every position without a second animation to keep in
        // step, and without driving a layer UIKit has taken out of the
        // hierarchy to use as a mask.
        const dockContainer = contentView.slice(contentView.indexOf('animatedInputStyle,'));
        expect(dockContainer.indexOf('bottomScrim.visible')).toBeGreaterThan(-1);
        expect(dockContainer.indexOf('bottomScrim.visible'))
            .toBeLessThan(dockContainer.indexOf('{input}'));
    });
});

describe('the tint is held at zero, and that is a measurement', () => {
    const headerRange = [
        scrimTransmission(STRONG_TINT_PEAK_LIGHT, MOBILE_STRONG_HEADER_SCRIM_UNDERLAP_OPACITY),
        scrimTransmission(STRONG_TINT_PEAK_DARK, MOBILE_STRONG_HEADER_SCRIM_RESTING_OPACITY),
    ] as const;

    it('states what the header actually lets through, both themes and both strengths', () => {
        expect(scrimTransmission(STRONG_TINT_PEAK_DARK, MOBILE_STRONG_HEADER_SCRIM_RESTING_OPACITY))
            .toBeCloseTo(0.56, 3);
        expect(scrimTransmission(STRONG_TINT_PEAK_LIGHT, MOBILE_STRONG_HEADER_SCRIM_RESTING_OPACITY))
            .toBeCloseTo(0.392, 3);
        expect(scrimTransmission(STRONG_TINT_PEAK_DARK, MOBILE_STRONG_HEADER_SCRIM_UNDERLAP_OPACITY))
            .toBeCloseTo(0.472, 3);
        expect(scrimTransmission(STRONG_TINT_PEAK_LIGHT, MOBILE_STRONG_HEADER_SCRIM_UNDERLAP_OPACITY))
            .toBeCloseTo(0.27, 3);
    });

    it('leaves the transcript behind the composer inside that range', () => {
        const behindComposer = TRANSCRIPT_GLASS_ALPHA
            * scrimTransmission(STRONG_TINT_PEAK_DARK, CHAT_BOTTOM_SCRIM_OVERLAY_OPACITY);
        expect(behindComposer).toBeGreaterThanOrEqual(headerRange[0]);
        expect(behindComposer).toBeLessThanOrEqual(headerRange[1]);
        expect(behindComposer).toBeCloseTo(0.4, 3);
    });

    it('records why any tint at all would be too much', () => {
        // Add the header's own resting tint on top of the mask and the chat
        // drops out the bottom of the header's range: 0.224 dark, 0.157 light.
        // That is DROVE-168's erasure reached by a second route, and the glass
        // is back to refracting nothing (DROVE-171).
        for (const peak of [STRONG_TINT_PEAK_DARK, STRONG_TINT_PEAK_LIGHT]) {
            const tinted = TRANSCRIPT_GLASS_ALPHA
                * scrimTransmission(peak, MOBILE_STRONG_HEADER_SCRIM_RESTING_OPACITY);
            expect(tinted).toBeLessThan(headerRange[0]);
        }
        expect(CHAT_BOTTOM_SCRIM_OVERLAY_OPACITY).toBe(0);
    });

    it('is the header’s strong peak being held at zero, not a peak of its own', () => {
        expect(contentView).toContain('variant="strong"');
        expect(contentView).toContain('overlayOpacity={CHAT_BOTTOM_SCRIM_OVERLAY_OPACITY}');
    });
});
