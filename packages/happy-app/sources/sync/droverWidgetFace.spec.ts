import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { statusDotColors, statusDotLabels } from '@/components/statusDotState';
import {
    WIDGET_CLEAR_TRUSTED_MS,
    WIDGET_COUNT_TRUSTED_MS,
    WIDGET_RELOAD_FLOOR_MS,
    droverWidgetFace,
    shouldReloadWidget,
    widgetFaceForSnapshot,
    widgetReloadWorthIt,
    widgetTrust,
    worstDot,
    type DroverWidgetFace,
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
const widgetDir = resolve(__dirname, '../../widget/DroverPhoneWidget');
const swiftFace = readFileSync(resolve(widgetDir, 'DroverWidgetFace.swift'), 'utf8');
const swiftWidget = readFileSync(resolve(widgetDir, 'DroverPhoneWidget.swift'), 'utf8');
const widgetEntitlements = readFileSync(
    resolve(widgetDir, 'DroverPhoneWidget.entitlements'),
    'utf8',
);
const widgetPlist = readFileSync(resolve(widgetDir, 'Info.plist'), 'utf8');
const nativeModule = readFileSync(
    resolve(__dirname, '../../modules/drover-watch/ios/DroverWatchModule.swift'),
    'utf8',
);
const appConfig = readFileSync(resolve(__dirname, '../../app.config.js'), 'utf8');
// The widget reads the group through `DroverSnapshot.appGroupSuiteName`, which
// is where the literal lives on the extension's side: the same tracked file
// compiles into the watch app, the watch complication and now the phone widget.
const swiftSnapshot = readFileSync(
    resolve(__dirname, '../../watch/DroverWatch/Shared/DroverSnapshot.swift'),
    'utf8',
);
const graft = readFileSync(
    resolve(__dirname, '../../watch/scripts/add-watch-targets.rb'),
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

/**
 * THE WATCH'S OWN PIN (DROVE-260). One signal on every slot the face offers.
 *
 * The complication carries the gate count on all four accessory families and
 * nothing from the `.system*` set, which a watch cannot draw anyway. The pin is
 * here so "the same count, one more slot" cannot quietly grow a family that
 * shows something else, or a second set of words for the inline line.
 */
const swiftWatchWidget = readFileSync(
    resolve(__dirname, '../../watch/DroverWatchWidget/DroverWatchWidget.swift'),
    'utf8',
);

describe('the watch complication', () => {
    it('offers the same count on every accessory family, inline included', () => {
        const families = swiftWatchWidget.match(/supportedFamilies\(\[([^\]]*)\]\)/)?.[1] ?? '';
        const declared = families.split(',').map((f) => f.trim()).filter(Boolean).sort();
        expect(declared).toEqual([
            '.accessoryCircular',
            '.accessoryCorner',
            '.accessoryInline',
            '.accessoryRectangular',
        ]);
    });

    /**
     * The inline branch READS the label and the glyph the circular draws; it
     * does not carry words of its own. One `label`, one `symbol`, for every
     * family.
     */
    it('draws inline off the same label and glyph the circular draws', () => {
        expect(swiftWatchWidget).toContain('Label(label, systemImage: symbol)');
        expect(swiftWatchWidget.match(/private var label: String/g)).toHaveLength(1);
        expect(swiftWatchWidget.match(/private var symbol: String/g)).toHaveLength(1);
    });
});

/**
 * THE ADAPTER. Both writers hand over the same shapes the wrist takes, and
 * this is the one place those shapes become a face — because two call sites
 * mapping the same fields by hand is precisely how the wrist's colour table
 * drifted from the phone's (DROVE-257).
 */
describe('turning what the wrist is sent into what the widget shows', () => {
    it('reads the ISO timestamps the wire carries, and still names the oldest', () => {
        const face = widgetFaceForSnapshot({
            gates: [
                { id: 'a', title: 'newest', createdAt: '2026-09-01T10:00:00.000Z' },
                { id: 'b', title: 'oldest', createdAt: '2026-09-01T08:00:00.000Z' },
            ],
            sessions: [],
            now: 1_000,
        });
        expect(face.count).toBe(2);
        expect(face.detail).toBe('oldest');
    });

    /**
     * A gate whose timestamp will not parse sorts LAST, so a malformed date
     * cannot capture the one title the face gets to name. It is still counted:
     * the count is the thing waiting on him and no parse failure changes that.
     */
    it('does not let an unparseable date capture the title', () => {
        const face = widgetFaceForSnapshot({
            gates: [
                { id: 'a', title: 'broken', createdAt: 'not a date' },
                { id: 'b', title: 'real', createdAt: '2026-09-01T08:00:00.000Z' },
            ],
            sessions: [],
            now: 1_000,
        });
        expect(face.count).toBe(2);
        expect(face.detail).toBe('real');
    });

    /**
     * `dotState` is a bare string on the wire. A value this build has never
     * heard of reads as a FAULT, not as a cast and not as calm — the same rule
     * `DroverWidgetFace.empty` follows in Swift, and the same reason: a widget
     * from an older build meeting a newer state should look like something is
     * wrong, because from its point of view something is.
     */
    it('reads a dot it has never heard of as disconnected', () => {
        const face = widgetFaceForSnapshot({
            gates: [],
            sessions: [{ id: 's', dotState: 'transcendent' }],
            now: 1_000,
        });
        expect(face.dot).toBe('disconnected');
        expect(face.tintHex).toBe(statusDotColors.disconnected);
    });

    it('carries the dot and the workers through when they are known', () => {
        const face = widgetFaceForSnapshot({
            gates: [],
            sessions: [
                { id: 'a', dotState: 'connected', subagents: 1 },
                { id: 'b', dotState: 'compacting', subagents: 2 },
            ],
            now: 1_000,
        });
        expect(face.dot).toBe('compacting');
        expect(face.detail).toBe('3 workers');
    });
});

function face(over: Partial<DroverWidgetFace> = {}): DroverWidgetFace {
    return {
        count: 0,
        dot: 'connected',
        tintHex: statusDotColors.connected,
        headline: statusDotLabels.connected,
        detail: '',
        updatedAt: 0,
        ...over,
    };
}

/**
 * THE RELOAD BUDGET, which is the constraint the proposal did not have to
 * answer and the wiring does. WidgetKit hands out roughly 40-70 timeline
 * reloads a day. The face is written on every publish — a heartbeat a minute
 * while the app is open — so what is rationed is not the WRITE, it is the
 * telling.
 */
describe('when the widget is actually told', () => {
    it('always tells it the first time, having nothing to compare against', () => {
        expect(shouldReloadWidget({ previous: null, next: face(), lastReloadAt: null })).toBe(true);
    });

    it('spends a reload the moment the count moves, in either direction', () => {
        expect(widgetReloadWorthIt(face({ count: 0 }), face({ count: 1, dot: 'waiting' }))).toBe(true);
        expect(widgetReloadWorthIt(face({ count: 2, dot: 'waiting' }), face({ count: 0 }))).toBe(true);
    });

    /**
     * A machine that died is worth the same urgency as a gate that was raised:
     * a home screen still saying "Working" over it is the same lie in a
     * quieter register.
     */
    it('spends one when a fault appears, and again when it clears', () => {
        expect(widgetReloadWorthIt(face({ dot: 'working' }), face({ dot: 'disconnected' }))).toBe(true);
        expect(widgetReloadWorthIt(face({ dot: 'recentlyDisconnected' }), face({ dot: 'connected' }))).toBe(true);
    });

    /**
     * And spends NOTHING on churn. `working` and `connected` swap on every
     * turn a session takes; a widget chasing them would have no budget left
     * for the raise that is the whole reason it exists.
     */
    it('does not spend one on a session merely going busy or idle', () => {
        expect(widgetReloadWorthIt(face({ dot: 'connected' }), face({ dot: 'working' }))).toBe(false);
        expect(widgetReloadWorthIt(face({ dot: 'working' }), face({ dot: 'compacting' }))).toBe(false);
        expect(
            widgetReloadWorthIt(face({ detail: '1 worker' }), face({ detail: '4 workers' })),
        ).toBe(false);
    });

    it('holds churn back until the floor, then lets one through', () => {
        const previous = face({ dot: 'connected' });
        const churn = (at: number) => face({ dot: 'working', updatedAt: at });
        expect(
            shouldReloadWidget({ previous, next: churn(WIDGET_RELOAD_FLOOR_MS - 1), lastReloadAt: 0 }),
        ).toBe(false);
        expect(
            shouldReloadWidget({ previous, next: churn(WIDGET_RELOAD_FLOOR_MS), lastReloadAt: 0 }),
        ).toBe(true);
    });

    /**
     * THE FLOOR IS HALF THE CLEAR WINDOW, and that is the whole reason it is
     * 30 minutes rather than a number that felt right. A phone being used at
     * all restamps the widget twice inside every hour a clear face is trusted
     * for, so it cannot fall out of trust while the app is awake — and a
     * widget saying "Not heard from" over a phone in his hand is DROVE-22's
     * failure moved to a new surface.
     */
    it('leaves room to restamp a clear face twice before it falls out of trust', () => {
        expect(WIDGET_RELOAD_FLOOR_MS * 2).toBe(WIDGET_CLEAR_TRUSTED_MS);
    });
});

/**
 * THE WIRING PINS. Everything above is about what the widget says; these are
 * about whether it is ever told anything at all. Each one is a failure that
 * reaches a home screen rather than a build log — a widget quietly stuck on
 * "Not yet synced" — which is why they are assertions and not a checklist in
 * a doc.
 */
describe('the plumbing the widget cannot work without', () => {
    const appGroup = 'group.com.bitspur.drover';

    /**
     * FOUR COPIES OF ONE STRING, and they have to agree: the extension's
     * entitlements, the phone app's, the phone's write and the widget's read.
     * Nothing fails loudly when they do not — the write lands in a container
     * the widget cannot open and the widget shows its never-written face
     * forever.
     */
    it('names the same app group everywhere the group is named', () => {
        expect(widgetEntitlements).toContain(appGroup);
        expect(swiftSnapshot).toContain(`appGroupSuiteName = "${appGroup}"`);
        expect(nativeModule).toContain(`UserDefaults(suiteName: "${appGroup}")`);
        // The phone app's own claim, which is what makes its write reach the
        // shared container at all. It was never needed while the wrist was the
        // only other surface, because WatchConnectivity is its own channel.
        expect(appConfig).toContain(appGroup);
    });

    /** And the same key, which is the other half of finding the same blob. */
    it('writes the face under the key the widget reads', () => {
        const key = swiftFace.match(/widgetFaceKey = "([^"]+)"/)?.[1];
        expect(key).toBe('drover.widget.face.v1');
        expect(nativeModule).toContain(`forKey: "${key}"`);
    });

    /**
     * The extension has to be a WIDGET extension. An Info.plist without this
     * point identifier produces a target that compiles, embeds, signs and then
     * simply does not appear in the widget gallery.
     */
    it('declares itself a widgetkit extension', () => {
        expect(widgetPlist).toContain('com.apple.widgetkit-extension');
    });

    /**
     * The version keys stay build variables, for the reason the watch's do:
     * an embedded bundle whose CFBundleVersion disagrees with the app around
     * it is an upload Apple refuses, twenty minutes into an archive.
     */
    it('leaves its versions to the build settings', () => {
        expect(widgetPlist).toContain('$(MARKETING_VERSION)');
        expect(widgetPlist).toContain('$(CURRENT_PROJECT_VERSION)');
    });

    /**
     * `ios/` is gitignored and prebuild rewrites it, so a target that is not
     * in the graft is a target that does not exist. The bundle id must match
     * what app.config.js declares to EAS, or EAS mints a profile for an id
     * nothing builds and the archive dies at signing.
     */
    it('is grafted onto the generated project under the id EAS is told about', () => {
        expect(graft).toContain("phone_widget_name = 'DroverPhoneWidget'");
        expect(graft).toContain('phone_widget_bundle_id = "#{host_bundle_id}.widget"');
        expect(appConfig).toContain('targetName: "DroverPhoneWidget"');
        expect(appConfig).toContain('bundleIdentifier: `${bundleId}.widget`');
    });

    /**
     * An iOS extension on a watchOS SDK compiles and embeds and then fails on
     * the device with nothing useful said. The graft asserts this itself; this
     * asserts the graft still does.
     */
    it('builds the phone widget against the phone SDK', () => {
        expect(graft).toContain("'SDKROOT' => 'iphoneos'");
        expect(graft).toContain('expected \\"iphoneos\\"');
    });
});
