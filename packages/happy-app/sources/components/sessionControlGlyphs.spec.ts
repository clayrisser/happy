/**
 * The composer's two session glyphs (DROVE-141).
 *
 * Clay: "use better icons for these." What replaced them is a judgement he has
 * to make with his eyes, so the rendered samples go on the ticket; what a
 * spec can hold is that the judgement stayed made. Chiefly: no mode is drawn
 * as an error any more, no two modes share a silhouette, and the effort needle
 * reports a POSITION that means the same thing on a four-level scale and a
 * six-level one.
 */
import { describe, expect, it } from 'vitest';
import {
    effortAccessibility,
    effortGaugeAngle,
    effortGaugePoint,
    effortGaugeSweep,
    effortGaugeTrackPath,
    permissionModeAccessibility,
    permissionModeGlyph,
} from './sessionControlGlyphs';

describe('the permission mode glyph', () => {
    it('never draws a working session as an error', () => {
        for (const mode of [
            'yolo', 'bypassPermissions', 'full', 'safe-yolo', 'workspace',
            'read-only', 'plan', 'acceptEdits', 'auto', 'default', null, undefined, '',
        ]) {
            expect(permissionModeGlyph(mode), String(mode)).not.toMatch(/warning|alert/);
        }
    });

    it('is a padlock for the two modes Clay switches between, open for yolo and shut for the default', () => {
        expect(permissionModeGlyph('yolo')).toBe('lock-open-outline');
        expect(permissionModeGlyph('bypassPermissions')).toBe('lock-open-outline');
        expect(permissionModeGlyph(null, 'default')).toBe('lock-closed-outline');
        expect(permissionModeGlyph(null, null)).toBe('lock-closed-outline');
    });

    it('gives plan, read-only, edits and the fenced modes each their own shape', () => {
        expect(permissionModeGlyph(null, 'plan')).toBe('map-outline');
        expect(permissionModeGlyph('read-only')).toBe('eye-outline');
        expect(permissionModeGlyph(null, 'acceptEdits')).toBe('create-outline');
        expect(permissionModeGlyph('safe-yolo')).toBe('shield-checkmark-outline');
    });

    it('has no two modes drawn the same, which is what "distinguishable at a glance" costs', () => {
        const drawn = ['read-only', 'plan', 'acceptEdits', 'yolo', 'safe-yolo', 'default']
            .map((mode) => permissionModeGlyph(null, mode));
        expect(new Set(drawn).size).toBe(drawn.length);
    });

    it('reads the kind first and falls back to the key', () => {
        // The composer knows both; the picker list only ever knows the kind.
        expect(permissionModeGlyph('yolo', 'plan')).toBe('lock-open-outline');
        expect(permissionModeGlyph(null, 'PLAN')).toBe('map-outline');
    });
});

describe('the effort dial', () => {
    it('puts the ends of any scale at the ends of the sweep', () => {
        for (const count of [4, 5, 6]) {
            expect(effortGaugeAngle(0, count), `${count} low`).toBe(effortGaugeSweep.startDeg);
            expect(effortGaugeAngle(count - 1, count), `${count} high`).toBe(effortGaugeSweep.endDeg);
        }
    });

    it('reads as a position, not a count: the same level on scales of different length points differently', () => {
        // Fourth of six is two thirds up the dial; fourth of four is the top.
        expect(effortGaugeAngle(3, 6)).toBeCloseTo(26, 5);
        expect(effortGaugeAngle(3, 4)).toBe(130);
    });

    it('separates neighbouring levels by enough angle to see on the longest scale', () => {
        // Six levels is the most any model offers (DROVE-101). 52 degrees
        // apart is the worst case, and it is not a count anyone has to make.
        const step = effortGaugeAngle(1, 6) - effortGaugeAngle(0, 6);
        expect(step).toBeCloseTo(52, 5);
    });

    it('clamps rather than swinging the needle off the dial', () => {
        expect(effortGaugeAngle(-3, 5)).toBe(effortGaugeSweep.startDeg);
        expect(effortGaugeAngle(99, 5)).toBe(effortGaugeSweep.endDeg);
        // A scale with one level has no position to report, so it points up.
        expect(effortGaugeAngle(0, 1)).toBe(0);
        expect(effortGaugeAngle(0, 0)).toBe(0);
    });

    it('measures degrees from straight up, clockwise', () => {
        const top = effortGaugePoint(10, 8, 0);
        expect([top.x, top.y]).toEqual([10, 2]);
        const right = effortGaugePoint(10, 8, 90);
        expect(right.x).toBeCloseTo(18, 5);
        expect(right.y).toBeCloseTo(10, 5);
    });

    it('draws the track as one large clockwise arc, because the sweep is past a half turn', () => {
        expect(effortGaugeSweep.endDeg - effortGaugeSweep.startDeg).toBeGreaterThan(180);
        expect(effortGaugeTrackPath(17, 1.75)).toMatch(/^M [\d.-]+ [\d.-]+ A [\d.]+ [\d.]+ 0 1 1 [\d.-]+ [\d.-]+$/);
    });
});

describe('what a screen reader hears where the glyph is', () => {
    it('names the control and then its state, for both glyphs', () => {
        expect(permissionModeAccessibility('Yolo')).toEqual({ label: 'Permission mode', value: 'Yolo' });
        expect(effortAccessibility('High', 3, 6))
            .toEqual({ label: 'Reasoning effort', value: 'High, 4 of 6' });
    });

    it('says the position out loud too, since the dial draws one', () => {
        expect(effortAccessibility('Low', 0, 4).value).toBe('Low, 1 of 4');
        expect(effortAccessibility('Max', 3, 4).value).toBe('Max, 4 of 4');
    });

    it('still names the control when there is no state to report', () => {
        expect(permissionModeAccessibility(null)).toEqual({ label: 'Permission mode' });
        expect(permissionModeAccessibility('  ')).toEqual({ label: 'Permission mode' });
        expect(effortAccessibility(null, 0, 4)).toEqual({ label: 'Reasoning effort' });
        expect(effortAccessibility('Only', 0, 1)).toEqual({ label: 'Reasoning effort', value: 'Only' });
    });
});
