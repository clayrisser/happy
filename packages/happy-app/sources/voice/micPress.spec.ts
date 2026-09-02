import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { micTarget, startMicPress, type MicPressDeps } from './micPress';
import {
    mountedDictationSurface,
    onDictationSurfaceChange,
    registerDictationSurface,
    resetDictationSurfaces,
    type DictationSurface,
} from './dictationSurface';
import type { HeadlessDictationPort } from './headlessDictation';
import type { AudioCueId } from './audioCues';
import type { RemoteCommand } from './headphonePress';

/**
 * WHO A TRIPLE PRESS DICTATES INTO, decided with no screen in the room
 * (DROVE-302).
 *
 * The bug this pins: after DROVE-300 the mic lived in `useVoiceComposer`, so
 * the press only ever reached a MOUNTED session screen. Background the app
 * from the session list and it reached nothing. Every case below is asked of
 * plain values and plain objects — no react, no navigation, no AppState — so
 * the answer with the phone locked is the same answer as with it in his hand.
 */

/** The one press class that means the microphone, since DROVE-300. */
const TRIPLE: RemoteCommand = 'previous';

describe('the mic follows the voice, not the screen', () => {
    it('dictates into the session holding the voice when NO screen is mounted', () => {
        // Backgrounded from the session LIST while streaming: this is the
        // whole ticket. Nothing is mounted and the press still lands.
        expect(micTarget('s1', null)).toEqual({ kind: 'dictate', session: 's1', surface: 'draft' });
    });

    it('uses the mounted composer when the screen IS the session being read', () => {
        expect(micTarget('s1', 's1')).toEqual({ kind: 'dictate', session: 's1', surface: 'composer' });
    });

    it('REFUSES when a mounted screen is not the session holding the voice', () => {
        // DROVE-300's rule, kept bit for bit: a triple press after a double
        // press must not put words in a composer he is not listening to.
        expect(micTarget('s2', 's1')).toEqual({ kind: 'refuse', why: 'other-session' });
    });

    it('dictates into the mounted screen when nothing holds the voice', () => {
        // Reading switched off everywhere. The on-screen mic works, so the
        // headphone press must too.
        expect(micTarget(null, 's1')).toEqual({ kind: 'dictate', session: 's1', surface: 'composer' });
    });

    it('refuses when there is neither a voice nor a screen', () => {
        // Nothing to dictate INTO. Inventing a session here is how words end
        // up somewhere he will never look.
        expect(micTarget(null, null)).toEqual({ kind: 'refuse', why: 'nowhere' });
    });
});

/** A composer that has announced itself, driven by hand. */
function surface(
    session: string,
    capturing = false,
): DictationSurface & { taps: number; commits: number; live: boolean } {
    const it = {
        session,
        taps: 0,
        // The verb that SENDS (DROVE-370). Counted apart from `taps` on
        // purpose: the whole point of the ticket is that the headphone's
        // closing press and the screen's own second tap are different calls.
        commits: 0,
        live: capturing,
        capturing: () => it.live,
        tap: () => { it.taps += 1; },
        commit: () => { it.commits += 1; it.live = false; },
    };
    return it;
}

class FakeHeadless implements HeadlessDictationPort {
    opened: string[] = [];
    closes = 0;
    /** Closed AND sent (DROVE-370), kept apart from a plain close. */
    commits = 0;
    private live = false;
    private settle = false;

    capturing(): boolean { return this.live; }
    settling(): boolean { return this.settle; }
    open(session: string): void { this.opened.push(session); this.live = true; }
    close(): void { this.closes += 1; this.live = false; }
    commit(): void { this.commits += 1; this.live = false; }
    setSettling(next: boolean): void { this.settle = next; }
}

describe('the subscription is at module scope and resolves with nothing mounted', () => {
    let cues: AudioCueId[];
    let headless: FakeHeadless;
    let holder: string | null;
    let blocked: boolean;
    let available: boolean;
    let press: (command: RemoteCommand) => void;
    let subscriptions: number;
    let pending: Array<() => void>;
    let stop: () => void;

    function start(): void {
        const deps: MicPressDeps = {
            available: () => available,
            holder: () => holder,
            // THE REAL REGISTRY, not a stub of it: whether a screen is mounted
            // is exactly the thing this ticket got wrong, so the test asks the
            // same module the app asks.
            mounted: () => mountedDictationSurface(),
            onSurfaceChange: (listener) => onDictationSurfaceChange(listener),
            headless,
            blocked: () => blocked,
            ack: (id) => { cues.push(id); },
            duration: () => 200,
            delay: (run) => {
                pending.push(run);
                return () => { pending = pending.filter((each) => each !== run); };
            },
            subscribe: (listener) => {
                subscriptions += 1;
                press = listener;
                return { remove: () => { subscriptions -= 1; } };
            },
        };
        stop = startMicPress(deps);
    }

    /** Let the open cue finish, which is what the mic waits for. */
    function runCue(): void {
        for (const run of pending.splice(0)) run();
    }

    beforeEach(() => {
        resetDictationSurfaces();
        cues = [];
        headless = new FakeHeadless();
        holder = null;
        blocked = false;
        available = true;
        subscriptions = 0;
        pending = [];
        press = () => { };
        stop = () => { };
    });

    afterEach(() => {
        stop();
        resetDictationSurfaces();
    });

    it('opens the mic on a triple press with no screen mounted at all', () => {
        holder = 's1';
        start();
        expect(mountedDictationSurface()).toBe(null);

        press(TRIPLE);
        runCue();

        expect(cues).toEqual(['micOpen']);
        expect(headless.opened).toEqual(['s1']);
    });

    it('leaves the single and the double press alone', () => {
        holder = 's1';
        start();

        press('toggle');
        press('next');
        press('play');
        press('pause');
        runCue();

        expect(cues).toEqual([]);
        expect(headless.opened).toEqual([]);
    });

    it('routes to a mounted composer rather than opening a second capture', () => {
        holder = 's1';
        start();
        const screen = surface('s1');
        registerDictationSurface(screen);

        press(TRIPLE);
        runCue();

        expect(headless.opened).toEqual([]);
        expect(screen.taps).toBe(1);
        // OPENING is still the tap. Only the closing press sends (DROVE-370).
        expect(screen.commits).toBe(0);
    });

    it('refuses audibly when the mounted screen is not the session being read', () => {
        // The double-press skip moved the voice to s2 while s1's screen is
        // still up. DROVE-300's refusal, now with a test on it.
        holder = 's2';
        start();
        const screen = surface('s1');
        registerDictationSurface(screen);

        press(TRIPLE);
        runCue();

        expect(cues).toEqual(['micRefused']);
        expect(headless.opened).toEqual([]);
        expect(screen.taps).toBe(0);
    });

    it('refuses rather than guessing when nothing holds the voice and nothing is mounted', () => {
        start();
        press(TRIPLE);
        runCue();

        expect(cues).toEqual(['micRefused']);
        expect(headless.opened).toEqual([]);
    });

    it('refuses when the build cannot dictate at all', () => {
        holder = 's1';
        blocked = true;
        start();

        press(TRIPLE);
        runCue();

        expect(cues).toEqual(['micRefused']);
        expect(headless.opened).toEqual([]);
    });

    it('refuses while the recogniser is still settling the last stop', () => {
        holder = 's1';
        start();
        headless.setSettling(true);

        press(TRIPLE);
        runCue();

        expect(cues).toEqual(['micRefused']);
        expect(headless.opened).toEqual([]);
    });

    it('closes the headless capture a press opened, AND SENDS (DROVE-370)', () => {
        // Clay: "triple tap starts the mic, but triple tap should also end it,
        // and when it ends it should auto-submit." Closing it is what it
        // already did; the send is the ticket. `commit` rather than `close`,
        // because every OTHER way this capture can end — the idle stop, a
        // recogniser giving up, a screen arriving — still keeps the words in
        // the draft without sending them.
        holder = 's1';
        start();
        press(TRIPLE);
        runCue();
        expect(headless.capturing()).toBe(true);

        press(TRIPLE);

        expect(cues).toEqual(['micOpen', 'micClosed']);
        expect(headless.commits).toBe(1);
        expect(headless.closes).toBe(0);
        expect(headless.capturing()).toBe(false);
    });

    it('still closes a headless capture after the voice moved away', () => {
        // A press closes what a press opened, whatever the target rule would
        // say NOW. Otherwise a double press between the two triples leaves a
        // hot mic in his pocket that no gesture can shut.
        holder = 's1';
        start();
        press(TRIPLE);
        runCue();
        holder = 's2';

        press(TRIPLE);

        expect(headless.commits).toBe(1);
        expect(headless.capturing()).toBe(false);
    });

    it('does not subscribe on a build that cannot deliver the triple press', () => {
        // Build 15 and earlier disable previousTrackCommand outright.
        available = false;
        start();
        expect(subscriptions).toBe(0);
    });

    it('unsubscribes when stopped', () => {
        start();
        expect(subscriptions).toBe(1);
        stop();
        expect(subscriptions).toBe(0);
    });

    it('closes a capture the THUMB started, at once and with the close cue', () => {
        // The mic on screen is latched and he presses the headphones. It is
        // one capture with three doors on it (DROVE-210), so this must read as
        // a close: `micClosed` now, not `micOpen` a quarter of a second later.
        holder = 's1';
        start();
        const screen = surface('s1', true);
        registerDictationSurface(screen);

        press(TRIPLE);

        expect(cues).toEqual(['micClosed']);
        // COMMIT, NOT TAP (DROVE-370). The composer's own second tap still
        // stops and keeps the words (DROVE-105) — that is `tap`, and the
        // screen still calls it. The headphone press is the hands-free path
        // and it sends, so it needs its own verb rather than a changed one.
        expect(screen.commits).toBe(1);
        expect(screen.taps).toBe(0);
        expect(pending.length).toBe(0);
    });

    it('still closes an on-screen capture after the voice moved away', () => {
        // The mic is latched on s1's screen and a double press hands the voice
        // to s2. The target rule would now REFUSE, and a close that re-asked it
        // would leave a hot microphone nothing can shut. A press closes what a
        // press opened, wherever it was opened.
        holder = 's1';
        start();
        const screen = surface('s1', true);
        registerDictationSurface(screen);
        holder = 's2';

        press(TRIPLE);

        expect(cues).toEqual(['micClosed']);
        expect(screen.commits).toBe(1);
        expect(screen.taps).toBe(0);
    });

    it('hands a live headless capture over when a screen arrives', () => {
        holder = 's1';
        start();
        press(TRIPLE);
        runCue();
        expect(headless.capturing()).toBe(true);

        registerDictationSurface(surface('s1'));

        // Closed, not abandoned: `close` commits the words to the draft, so a
        // screen arriving mid-sentence cannot leave two mics on one recogniser.
        // A HANDOVER IS NOT A SEND (DROVE-370). The screen is about to offer
        // its own microphone and the words go to the draft it hydrates from;
        // nothing was asked for and nothing goes out.
        expect(headless.closes).toBe(1);
        expect(headless.commits).toBe(0);
    });

    it('is not fooled by the outgoing screen unregistering after the next one arrived', () => {
        // React mounts the next screen before it unmounts the last. A naive
        // registry would let the leaving screen wipe the arriving one, and the
        // press would then be resolved as if nothing were mounted.
        holder = 's1';
        start();
        const leaving = surface('s1');
        const unregisterLeaving = registerDictationSurface(leaving);
        const arriving = surface('s1');
        registerDictationSurface(arriving);
        unregisterLeaving();

        press(TRIPLE);
        runCue();

        expect(headless.opened).toEqual([]);
        expect(arriving.taps).toBe(1);
        expect(leaving.taps).toBe(0);
    });
});
