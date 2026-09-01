import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { DroverReading, DroverTransportEvent } from 'drover-watch';

/**
 * The wrist's half of the player, pinned at both ends (DROVE-275).
 *
 * The reading state is resolved on the PHONE and rendered on the wrist, which
 * is DROVE-129's rule: the watch cannot import the reader, so the phone sends
 * the answer rather than each side working it out. That leaves exactly one way
 * to drift — rename a state or an action on one side and ship a binary that
 * has never heard of it — and the failure is silent both ways. A watch that
 * does not recognise "paused" draws a Pause button over a reader that is
 * already held; a phone that does not recognise "resume" drops the press and
 * the wrist looks broken.
 *
 * The watch binary is TestFlight and cannot be updated over the air, so the
 * two halves genuinely do ship apart. Hence this, in the shape
 * sessionStateWire.spec.ts and wristCues.spec.ts already use: read the Swift,
 * check it against the TypeScript, and fail a test rather than a wrist.
 */
const shared = readFileSync(
    resolve(__dirname, '../../watch/DroverWatch/Shared/DroverSnapshot.swift'),
    'utf8',
);
const bridge = readFileSync(
    resolve(__dirname, '../../modules/drover-watch/ios/DroverWatchModule.swift'),
    'utf8',
);
const store = readFileSync(
    resolve(__dirname, '../../watch/DroverWatch/Model/GateStore.swift'),
    'utf8',
);
const feed = readFileSync(resolve(__dirname, './droverWatchFeed.ts'), 'utf8');

/** `static let readingState = "reading"` and its siblings, by name. */
function swiftConstants(source: string, type: string): Record<string, string> {
    const start = source.indexOf(`struct ${type}`);
    expect(start, `DroverSnapshot.swift declares struct ${type}`).toBeGreaterThan(-1);
    const end = source.indexOf('\n}', start);
    const body = source.slice(start, end === -1 ? undefined : end);
    const out: Record<string, string> = {};
    for (const match of body.matchAll(/static let (\w+) = "([^"]*)"/g)) out[match[1]] = match[2];
    return out;
}

const reading = swiftConstants(shared, 'DroverReading');
const transport = swiftConstants(shared, 'DroverTransport');

/**
 * The state union, spelled out. Adding a member to `DroverReading['state']`
 * fails to compile here until it is listed, which is the point: this array is
 * the checklist, and the assertions below are what it is checked against.
 */
const states: DroverReading['state'][] = ['reading', 'paused'];

/** The same, for the actions the wrist may press. */
const actions = ['pause', 'resume'] as const;
const _actionsAreTheEventType: DroverTransportEvent['action'][] = [...actions];

describe('the reading state, phone and wrist', () => {
    it('spells every state the same on both sides', () => {
        expect(Object.values(reading).sort()).toEqual([...states].sort());
    });

    // A third spelling here would be a state with no Swift constant behind it,
    // which renders as "reading" on the wrist however wrong that is: `isPaused`
    // is the only question the watch asks, and everything that is not the
    // paused spelling answers it false.
    it('asks exactly one question of the state, against the paused spelling', () => {
        expect(reading.pausedState).toBe('paused');
        expect(shared).toContain('var isPaused: Bool { state == Self.pausedState }');
    });

    // OFF IS THE FIELD BEING ABSENT, not a third state. The native
    // `ReadingState` in DroverSpeechModule does have an off case; this
    // deliberately does not, so the two enumerations cannot drift.
    it('has no off state, because off is the key not being sent', () => {
        expect(Object.values(reading)).not.toContain('off');
        expect(feed).toContain('if (!readAloud.isEnabled) return null;');
        expect(feed).toContain('...(reading ? { reading } : {}),');
    });

    /**
     * DROVE-297. Reading is per session now, so the reader has two session
     * ids: `focused` is whose timeline it holds, `readingSessionId` is who is
     * actually SPEAKING. The wrist scopes its pause control by the id in this
     * payload (`DroverReading.applies(to:)`), so the wrong one would offer a
     * pause on a session that has given the voice up.
     *
     * Asserted as SOURCE rather than as behaviour on purpose, and the same way
     * every other claim in this file is: today the two ids agree wherever
     * `collectReading` gets past its guard, so a behavioural test could only
     * force the reader into a state it cannot reach. What is worth pinning is
     * that the payload asks the right QUESTION, so the day the two come apart
     * the wire is already right.
     */
    it('names the session speaking, not merely the one focused', () => {
        expect(feed).toContain('const sessionId = readAloud.readingSessionId;');
        expect(feed).not.toContain('const sessionId = readAloud.focusedSessionId;');
    });
});

describe('the transport press, wrist to phone', () => {
    it('spells every action the same on both sides', () => {
        expect(transport.pauseAction).toBe('pause');
        expect(transport.resumeAction).toBe('resume');
        expect([transport.pauseAction, transport.resumeAction]).toEqual([...actions]);
    });

    it('names the kind the phone dispatches on', () => {
        expect(transport.kindValue).toBe('transport');
        expect(bridge).toContain('payload["kind"] as? String == "transport"');
    });

    /**
     * THE ORDERING TRAP, which is a real one and is documented in `forward`
     * itself: the answer guard is `guard let allow = payload["allow"] as? Bool
     * else { return }`, and a transport press carries no `allow`. A branch that
     * drifted BELOW that guard would be swallowed in silence — the press
     * travels off the wrist, reaches the phone, and stops.
     */
    it('forwards the press above the guard that would swallow it', () => {
        const branch = bridge.indexOf('payload["kind"] as? String == "transport"');
        const guard = bridge.indexOf('guard let id = payload["id"] as? String,');
        expect(branch).toBeGreaterThan(-1);
        expect(guard).toBeGreaterThan(-1);
        expect(branch).toBeLessThan(guard);
    });

    // Explicit, never a toggle, on both sides: the wrist presses off a
    // snapshot that may be a minute old, and a toggle from a stale screen
    // resumes exactly the reading he had just paused.
    it('sends a destination rather than a toggle', () => {
        expect(store).toContain('DroverTransport(paused: paused)');
        expect(feed).toContain("if (event.action !== 'pause' && event.action !== 'resume') return;");
    });

    // Never queued. A pause delivered when the pair reconnects would stop a
    // reading he started since — and the wrist says so instead of looking
    // exactly like a press that worked.
    it('is sent live or refused out loud, never queued', () => {
        const start = store.indexOf('func setReadingPaused');
        expect(start).toBeGreaterThan(-1);
        const body = store.slice(start, store.indexOf('\n    }', start));
        expect(body).toContain('session.isReachable');
        expect(body).toContain('lastError =');
        expect(body).toContain('session.sendMessage(dict, replyHandler: nil, errorHandler: nil)');
        expect(body).not.toContain('transferUserInfo');
    });
});

describe('what the wrist draws', () => {
    const view = readFileSync(
        resolve(__dirname, '../../watch/DroverWatch/Views/TranscriptView.swift'),
        'utf8',
    );

    // The control is offered on the session being READ and nowhere else. A
    // pause pressed on another session's transcript would stop a voice reading
    // something he is not looking at — the same guard the phone's sentence tap
    // has (readAloudTap.ts `steers`).
    it('offers the control only on the session being read', () => {
        expect(shared).toContain('func applies(to sessionId: String) -> Bool');
        for (const name of ['WristReadingButton', 'WristReadingBar']) {
            const start = view.indexOf(`struct ${name}: View`);
            expect(start, `TranscriptView.swift declares ${name}`).toBeGreaterThan(-1);
            const body = view.slice(start, view.indexOf('\n}', start));
            expect(body).toContain('store.snapshot.reading');
            expect(body).toContain('reading.applies(to: session.id)');
        }
    });

    // The button says which press is OFFERED; the bar says what is HAPPENING.
    // "Resume" and a reader that is off look identical if the button is the
    // only evidence on screen.
    it('shows the state as well as the press', () => {
        expect(view).toContain('reading.isPaused ? "Resume" : "Pause"');
        expect(view).toContain('reading.isPaused ? "Paused" : "Reading"');
    });
});
