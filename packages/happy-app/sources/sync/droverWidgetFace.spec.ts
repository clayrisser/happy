import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { statusDotColors, statusDotLabels } from '@/components/statusDotState';
import {
    WIDGET_CLEAR_TRUSTED_MS,
    WIDGET_COUNT_TRUSTED_MS,
    droverWidgetFace,
    widgetTrust,
    worstDot,
    type WidgetSessionFacts,
} from './droverWidgetFace';

const HOUR = 60 * 60 * 1000;

function gate(id: string, title: string, createdAt: number) {
    return { id, title, createdAt };
}

function session(id: string, dot: WidgetSessionFacts['dot'], subagents?: number): WidgetSessionFacts {
    return subagents === undefined ? { id, dot } : { id, dot, subagents };
}

describe('the face the phone hands the widget', () => {
    it('leads with the count when something is waiting, in the phone\'s own amber', () => {
        const face = droverWidgetFace({
            gates: [gate('a', 'Run the migration', 200), gate('b', 'clear the build dir', 100)],
            sessions: [session('s', 'waiting')],
            now: 1_000,
        });
        expect(face.count).toBe(2);
        expect(face.headline).toBe('2');
        expect(face.dot).toBe('waiting');
        expect(face.tintHex).toBe(statusDotColors.waiting);
    });

    /**
     * The OLDEST gate, not the newest. When one is waiting the title is the
     * decision; when five are, the one that has been ignored longest is the one
     * worth naming, and the newest is the one he has just been buzzed about.
     */
    it('names the oldest gate underneath, not the newest', () => {
        const face = droverWidgetFace({
            gates: [gate('a', 'newest', 900), gate('b', 'oldest', 100)],
            sessions: [],
            now: 1_000,
        });
        expect(face.detail).toBe('oldest');
    });

    it('shows no number at all when nothing is waiting', () => {
        const face = droverWidgetFace({
            gates: [],
            sessions: [session('s', 'working', 3)],
            now: 1_000,
        });
        expect(face.count).toBe(0);
        expect(face.headline).toBe(statusDotLabels.working);
        expect(face.headline).not.toContain('0');
        expect(face.detail).toBe('3 workers');
    });

    /**
     * An empty store is what a phone that has never synced looks like, and it
     * is also what a machine with everything shut down looks like. Neither is
     * an all-clear, and green on either is the failure this whole ticket is
     * about (DROVE-255's shape, on a new surface).
     */
    it('reads no sessions as disconnected, never as connected', () => {
        const face = droverWidgetFace({ gates: [], sessions: [], now: 1_000 });
        expect(face.dot).toBe('disconnected');
        expect(face.tintHex).toBe(statusDotColors.disconnected);
    });

    /**
     * The face carries its OWN age. The snapshot blob beside it is written by
     * the wrist publish and this one by whichever path moved the widget, so a
     * face read against the other's timestamp would be aged by an unrelated
     * write — or freshened by one, which is the direction that lies.
     */
    it('stamps the moment it was resolved, not the snapshot\'s', () => {
        const face = droverWidgetFace({ gates: [], sessions: [], now: 12_345 });
        expect(face.updatedAt).toBe(12_345);
    });

    it('ranks a session waiting on him above every other state', () => {
        expect(worstDot([session('a', 'connected'), session('b', 'waiting')])).toBe('waiting');
        expect(worstDot([session('a', 'working'), session('b', 'disconnected')])).toBe('disconnected');
        expect(worstDot([session('a', 'connected'), session('b', 'working')])).toBe('working');
    });

    /**
     * THE REUSE CHECK, and the reason this file exists at all. Every tint the
     * face can produce is a value already in `statusDotColors`. A widget that
     * could reach a hex not in that table would be the fifth derivation
     * DROVE-257 caught the fourth of.
     */
    it('never produces a hex that is not already in statusDotColors', () => {
        const known = new Set(Object.values(statusDotColors));
        const inputs = [
            { gates: [gate('a', 't', 1)], sessions: [], now: 1_000 },
            { gates: [], sessions: [], now: 1_000 },
            ...Object.keys(statusDotColors).map((dot) => ({
                gates: [],
                sessions: [session('s', dot as WidgetSessionFacts['dot'])],
                now: 1_000,
            })),
        ];
        for (const input of inputs) {
            expect(known.has(droverWidgetFace(input).tintHex)).toBe(true);
        }
    });
});

describe('how long the widget may state what it is holding', () => {
    /**
     * The asymmetry, which is the whole staleness design. The push that writes
     * this fires on a gate CHANGE, so silence over a count is innocent and
     * silence over a zero is exactly the dropped push.
     */
    it('stops calling a zero clear after an hour', () => {
        const at = (age: number) => widgetTrust({ count: 0, updatedAt: 0, now: age });
        expect(at(WIDGET_CLEAR_TRUSTED_MS - 1)).toBe('trusted');
        expect(at(WIDGET_CLEAR_TRUSTED_MS + 1)).toBe('dated');
    });

    it('lets a count stand far longer than a zero', () => {
        expect(WIDGET_COUNT_TRUSTED_MS).toBeGreaterThan(WIDGET_CLEAR_TRUSTED_MS);
        const at = (age: number) => widgetTrust({ count: 2, updatedAt: 0, now: age });
        expect(at(WIDGET_CLEAR_TRUSTED_MS + HOUR)).toBe('trusted');
        expect(at(WIDGET_COUNT_TRUSTED_MS + 1)).toBe('dated');
    });

    /** A snapshot stamped in the future is a clock that moved, not a fresh one. */
    it('refuses a snapshot from the future', () => {
        expect(widgetTrust({ count: 3, updatedAt: 1_000, now: 0 })).toBe('dated');
    });
});

/**
 * THE SWIFT PIN, the same arrangement sessionStateWire.spec.ts has with
 * DroverSnapshot.swift. The widget extension cannot import any of this, so the
 * only thing stopping the two halves from drifting is a test that reads the
 * Swift and checks it. Edit a constant on this side and this says which line to
 * change over there.
 */
const swiftFace = readFileSync(
    resolve(__dirname, '../../widget/DroverWidgetFace.swift'),
    'utf8',
);
const swiftWidget = readFileSync(
    resolve(__dirname, '../../widget/DroverPhoneWidget.swift'),
    'utf8',
);

function swiftInterval(source: string, name: string): number {
    const found = source.match(new RegExp(`let ${name}: TimeInterval = ([0-9_.]+)`));
    expect(found, `DroverWidgetFace.swift declares ${name}`).not.toBeNull();
    return Number(found![1].replace(/_/g, ''));
}

describe('the Swift the widget actually renders', () => {
    it('holds the phone\'s two trust budgets, in seconds', () => {
        expect(swiftInterval(swiftFace, 'widgetClearTrusted')).toBe(WIDGET_CLEAR_TRUSTED_MS / 1000);
        expect(swiftInterval(swiftFace, 'widgetCountTrusted')).toBe(WIDGET_COUNT_TRUSTED_MS / 1000);
    });

    /**
     * The fallback face a widget shows when it has never been written. It must
     * be the disconnected hex and not a hopeful one, for the same reason the
     * empty-store case above must be.
     */
    it('falls back to the phone\'s disconnected hex, not a hopeful one', () => {
        const tint = swiftFace.match(/tintHex: "(#[0-9A-Fa-f]{6})"/)?.[1];
        expect(tint).toBe(statusDotColors.disconnected);
    });

    /**
     * And the fallback's own age is `.distantPast`, so a widget that has never
     * been written is dated by the same rule as one that went quiet, rather
     * than by a separate "unwritten" branch that could disagree with it.
     */
    it('ages its own face, and ages the never-written one out of trust', () => {
        expect(swiftFace).toContain('let updatedAt: Date');
        expect(swiftFace).toContain('updatedAt: .distantPast');
    });

    /**
     * ONE SIZE, PINNED. The discipline this ticket is about is what the widget
     * leaves out, and a supportedFamilies list is where that decision either
     * holds or quietly grows a `.systemMedium` nobody argued for.
     */
    it('declares exactly one family, and it is systemSmall', () => {
        const families = swiftWidget.match(/supportedFamilies\(\[([^\]]*)\]\)/)?.[1] ?? '';
        expect(families.trim()).toBe('.systemSmall');
    });

    /**
     * The Lock Screen families are deliberately absent: they render in
     * `.vibrant`, which desaturates, and every state this widget can be in is
     * carried by hue. Adding one without a monochrome vocabulary is how the
     * dot's meaning would silently stop arriving.
     */
    it('claims no accessory family until a monochrome vocabulary exists', () => {
        expect(swiftWidget).not.toContain('.accessoryRectangular');
        expect(swiftWidget).not.toContain('.accessoryCircular');
        expect(swiftWidget).not.toContain('.accessoryInline');
    });
});
