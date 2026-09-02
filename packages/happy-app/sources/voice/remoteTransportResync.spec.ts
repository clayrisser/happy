import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A second play/pause press resumes, and never pauses again (DROVE-362).
 *
 * Clay, from TestFlight build 19: "when I pause it does pause, but I guess the
 * stream is just playing silently then, so when I push the button again it's
 * actually doing it again — I think the system thinks it's trying to pause
 * again, when in reality it should just keep flipping back and forth: pause,
 * unpause, pause, unpause." The presses were as likely a CAR's Bluetooth head
 * unit as the lock screen, which is what makes the separate `play`/`pause`
 * commands below the common case rather than an edge.
 *
 * THE DESYNC THIS PINS. `startBackgroundAudio` published the reader's transport
 * to native only when it CHANGED. That made the JS state the source of truth
 * for WHEN we speak as well as for WHAT we say, and once an outside surface had
 * drifted — an AVRCP unit still seeing the DROVE-259 keepalive produce audio
 * through a pause, so still showing a PAUSE glyph — nothing could put it back.
 * Press two arrives as `pause`, the DROVE-327 table answers `nothing`,
 * correctly, and the dedupe swallowed the re-assert too. The unit stayed wrong
 * for good and the pause was one-way.
 *
 * So these tests are about the presses that change NOTHING as much as the ones
 * that flip. `react-native` and `drover-speech` are mocked the way every voice
 * spec mocks the local native module.
 */

const h = vi.hoisted(() => ({
    appState: { currentState: 'active' as string, listeners: [] as Array<(s: string) => void> },
    hold: [] as boolean[],
    reading: [] as string[],
    remote: [] as Array<(command: string) => void>,
}));

vi.mock('react-native', () => ({
    AppState: {
        get currentState() { return h.appState.currentState; },
        addEventListener: (_type: string, cb: (s: string) => void) => {
            h.appState.listeners.push(cb);
            return { remove() { h.appState.listeners = h.appState.listeners.filter((l) => l !== cb); } };
        },
    },
}));

vi.mock('drover-speech', () => ({
    holdAudioSession: (v: boolean) => { h.hold.push(v); return Promise.resolve(); },
    setReadingState: (v: string) => { h.reading.push(v); return Promise.resolve(); },
    addRemoteCommandListener: (listener: (command: string) => void) => {
        h.remote.push(listener);
        return { remove() { h.remote = h.remote.filter((l) => l !== listener); } };
    },
    addSpeechInterruptionListener: () => ({ remove() { } }),
    speechInterruptionsHandled: () => true,
}));

import { startBackgroundAudio, type BackgroundReader } from './backgroundAudio';
import {
    duplicateRemotePressMs,
    isDiscreteSecondPress,
    isDuplicateRemotePress,
    remoteTransportEffect,
    secondPressResumesAfterMs,
    transportEffect,
} from './readAloudTransport';

/** A reader the test drives, firing the transport listener a pause rides. */
class FakeReader implements BackgroundReader {
    isEnabled = true;
    isPaused = false;
    private transportListeners: Array<() => void> = [];

    setBackgrounded(): void { }
    setPaused(paused: boolean): void {
        if (this.isPaused === paused) return;
        this.isPaused = paused;
        for (const l of this.transportListeners) l();
    }
    audioSessionRecovered(): void { }
    addInterruptListener(): () => void { return () => { }; }
    addTransportListener(listener: () => void): () => void {
        this.transportListeners.push(listener);
        return () => { this.transportListeners = this.transportListeners.filter((l) => l !== listener); };
    }
}

describe('a remote press always leaves the surfaces agreeing with the reader (DROVE-362)', () => {
    let reader: FakeReader;
    let dispose: () => void;
    let now: number;

    /** Press a remote button. The clock only moves when a test moves it. */
    function press(command: string): void {
        for (const l of [...h.remote]) l(command);
    }
    /** What native was last told read-aloud is doing. */
    function published(): string | undefined {
        return h.reading[h.reading.length - 1];
    }

    beforeEach(() => {
        h.appState.currentState = 'active';
        h.appState.listeners = [];
        h.hold = [];
        h.reading = [];
        h.remote = [];
        now = 1_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        reader = new FakeReader();
        dispose = startBackgroundAudio(reader);
        // The initial publish is not what any of these tests is about.
        h.reading = [];
    });

    afterEach(() => {
        dispose?.();
        vi.restoreAllMocks();
    });

    it('pause, then press again: it RESUMES', () => {
        // The headline. A lock screen or head unit that has caught up sends
        // `play` (or `toggle`) for the second press, and that must read.
        press('pause');
        expect(reader.isPaused).toBe(true);
        now += 5_000;
        press('play');
        expect(reader.isPaused).toBe(false);
        expect(published()).toBe('reading');
    });

    it('pause, press, press: paused again — the transport flips, it does not latch', () => {
        press('pause');
        expect(reader.isPaused).toBe(true);
        now += 5_000;
        press('play');
        expect(reader.isPaused).toBe(false);
        now += 5_000;
        press('pause');
        expect(reader.isPaused).toBe(true);
        expect(published()).toBe('paused');
    });

    it('a `pause` inside a second of the pause stays paused AND re-publishes `paused`', () => {
        // DROVE-362's case, kept whole and narrowed to the window it is
        // actually about (DROVE-370). The reader is right to do nothing; the
        // surface that sent it is wrong, and this press is the proof. Before
        // DROVE-362 the change-only dedupe swallowed the correction, so an
        // AVRCP unit that believed we were still playing could only ever send
        // `pause` and the pause became one-way.
        //
        // Past the 300 ms duplicate window, so it is a second COMMAND and not
        // one gesture arriving twice, and still well inside the second: this
        // is a head unit answering our own forced republish, not a thumb.
        press('pause');
        expect(h.reading).toEqual(['paused']);
        now += 400;
        press('pause');
        expect(reader.isPaused).toBe(true);
        expect(h.reading).toEqual(['paused', 'paused']);
    });

    it('but a `pause` a second later RESUMES — the headset with one word for its one button', () => {
        // THE DROVE-370 BUG. Clay: "headphone tap pauses but can't resume it."
        // AirPods send `togglePlayPause` and always resumed; some headsets and
        // car units have exactly one spelling for the one button, send `pause`
        // to pause and `pause` again to resume, and DROVE-362 answered the
        // second one by re-publishing `paused` at them. Correct, and still a
        // pause he could not press his way out of.
        press('pause');
        expect(reader.isPaused).toBe(true);
        now += 5_000;
        press('pause');
        expect(reader.isPaused).toBe(false);
        expect(published()).toBe('reading');
    });

    it('and it flips from there: pause, pause, pause walks paused/reading/paused', () => {
        // The transport must not latch on one spelling any more than on two.
        press('pause');
        expect(reader.isPaused).toBe(true);
        now += 5_000;
        press('pause');
        expect(reader.isPaused).toBe(false);
        now += 5_000;
        press('pause');
        expect(reader.isPaused).toBe(true);
        expect(published()).toBe('paused');
    });

    it('the second-press clock starts at the pause, not at the last press', () => {
        // A unit that re-asserts `pause` every 400 ms must not walk itself
        // over the line one echo at a time. Each echo is inside a second OF
        // THE PAUSE, so none of them resumes.
        press('pause');
        for (let i = 0; i < 2; i += 1) {
            now += 400;
            press('pause');
            expect(reader.isPaused).toBe(true);
        }
        // 1200 ms have passed and it is still paused; the next one is over the
        // line and reads.
        now += 400;
        press('pause');
        expect(reader.isPaused).toBe(false);
    });

    it('a pause taken on the ON-SCREEN speaker is resumed by the headphone too', () => {
        // The three surfaces drive one state (DROVE-233), so the clock has to
        // be the state's rather than the remote's. He holds the speaker to
        // pause, pockets the phone, and presses the headphone.
        reader.setPaused(true);
        expect(published()).toBe('paused');
        now += 5_000;
        press('pause');
        expect(reader.isPaused).toBe(false);
    });

    it('a `pause` while paused is STILL one gesture inside the 300 ms window', () => {
        // DROVE-362's dedupe runs first and is not softened: a press event and
        // a state notification milliseconds apart is one press, and one press
        // on an already-paused reader is not a second press.
        press('pause');
        now += 5_000;
        press('pause');
        expect(reader.isPaused).toBe(false);
        now += 5_000;
        press('pause');
        expect(reader.isPaused).toBe(true);
        now += duplicateRemotePressMs - 1;
        press('pause');
        expect(reader.isPaused).toBe(true);
    });

    it('a `play` while already reading stays reading AND re-publishes `reading`', () => {
        // The mirror image, and the one a head unit sends when it believes we
        // are paused while we are talking.
        expect(reader.isPaused).toBe(false);
        press('play');
        expect(reader.isPaused).toBe(false);
        expect(h.reading).toEqual(['reading']);
    });

    it('`play` never turns read-aloud ON (DROVE-189 kept verbatim)', () => {
        // A squeeze in a pocket must not wake a session he walked away from.
        reader.isEnabled = false;
        press('play');
        expect(reader.isEnabled).toBe(false);
        expect(reader.isPaused).toBe(false);
    });

    it('`toggle` flips through the DROVE-327 table in every state', () => {
        press('toggle');
        expect(reader.isPaused).toBe(true);
        now += 5_000;
        press('toggle');
        expect(reader.isPaused).toBe(false);
        now += 5_000;
        press('toggle');
        expect(reader.isPaused).toBe(true);
        expect(published()).toBe('paused');
    });

    it('the same command repeated inside 300 ms is ONE gesture', () => {
        // Some AVRCP units send a press event and a state notification as two
        // identical commands milliseconds apart. Taken at face value that is
        // pause-then-resume in one press.
        press('toggle');
        expect(reader.isPaused).toBe(true);
        now += duplicateRemotePressMs - 1;
        press('toggle');
        expect(reader.isPaused).toBe(true);
    });

    it('but a deliberate second press just past the window still reads', () => {
        press('toggle');
        expect(reader.isPaused).toBe(true);
        now += duplicateRemotePressMs + 1;
        press('toggle');
        expect(reader.isPaused).toBe(false);
    });

    it('never collapses two DIFFERENT commands, however close together', () => {
        // `pause` then `play` in 40 ms is a unit correcting itself, and both
        // halves mean something.
        press('pause');
        expect(reader.isPaused).toBe(true);
        now += 40;
        press('play');
        expect(reader.isPaused).toBe(false);
    });

    it('leaves the double and triple press alone (DROVE-225, DROVE-300)', () => {
        // The next session and the microphone have their own subscriptions.
        // Reaching the transport here would be three wrong answers.
        press('next');
        press('previous');
        expect(reader.isPaused).toBe(false);
        expect(h.reading).toEqual([]);
    });

    it('a pause still HOLDS the session — the silent hold is not what reports playing', () => {
        // DROVE-259/275: releasing the session on a pause would let iOS suspend
        // the app, and a suspended app cannot be resumed from a head unit. What
        // changes is only what we SAY about it.
        press('pause');
        expect(h.hold).not.toContain(false);
        expect(published()).toBe('paused');
    });
});

describe('a discrete second press, and only that, reinterprets a `pause` (DROVE-370)', () => {
    it('is not a second press with nothing to be second to', () => {
        expect(isDiscreteSecondPress(null, 10_000)).toBe(false);
    });

    it('is a second press from the threshold onward, and not before', () => {
        expect(isDiscreteSecondPress(0, secondPressResumesAfterMs - 1)).toBe(false);
        expect(isDiscreteSecondPress(0, secondPressResumesAfterMs)).toBe(true);
    });

    it('the window is longer than the duplicate window it sits behind', () => {
        // Otherwise the two rules would fight over the same milliseconds.
        expect(secondPressResumesAfterMs).toBeGreaterThan(duplicateRemotePressMs);
    });

    it('turns the one dead cell into a resume, and touches no other', () => {
        const late = secondPressResumesAfterMs;
        expect(remoteTransportEffect('remote-pause', 'paused', 0, late)).toBe('resume');
        expect(remoteTransportEffect('remote-pause', 'paused', 0, late - 1)).toBe('nothing');
        expect(remoteTransportEffect('remote-pause', 'paused', null, late)).toBe('nothing');
    });

    it('every other cell is the DROVE-327 table verbatim', () => {
        // Exhaustive, so a future edit to the table cannot be shadowed here.
        const gestures = ['tap', 'long-press', 'remote-play', 'remote-pause', 'remote-toggle'] as const;
        const states = ['off', 'paused', 'reading'] as const;
        for (const gesture of gestures) {
            for (const state of states) {
                if (gesture === 'remote-pause' && state === 'paused') continue;
                expect(remoteTransportEffect(gesture, state, 0, 1_000_000), `${gesture} on ${state}`)
                    .toBe(transportEffect(gesture, state));
            }
        }
    });

    it('the on-screen speaker is untouched: a hold still pauses, a tap still resumes', () => {
        // DROVE-327's row, and the one thing Clay asked to stay put. Neither
        // gesture is a remote one, so neither can reach the new cell whatever
        // the clock says.
        const ancient = 10_000_000;
        expect(remoteTransportEffect('long-press', 'reading', 0, ancient)).toBe('pause');
        expect(remoteTransportEffect('long-press', 'paused', 0, ancient)).toBe('turn-off');
        expect(remoteTransportEffect('tap', 'paused', 0, ancient)).toBe('resume');
    });

    it('a remote press still never turns read-aloud on or off (DROVE-189)', () => {
        const gestures = ['remote-play', 'remote-pause', 'remote-toggle'] as const;
        for (const gesture of gestures) {
            for (const state of ['off', 'paused', 'reading'] as const) {
                const effect = remoteTransportEffect(gesture, state, 0, 10_000_000);
                expect(effect).not.toBe('turn-on');
                expect(effect).not.toBe('turn-off');
                expect(effect).not.toBe('boss-mode');
            }
        }
    });
});

describe('isDuplicateRemotePress', () => {
    it('has nothing to compare against on the first press', () => {
        expect(isDuplicateRemotePress('pause', null, 0)).toBe(false);
    });

    it('is true only for the SAME command inside the window', () => {
        const previous = { command: 'pause', at: 0 };
        expect(isDuplicateRemotePress('pause', previous, duplicateRemotePressMs - 1)).toBe(true);
        expect(isDuplicateRemotePress('pause', previous, duplicateRemotePressMs)).toBe(false);
        expect(isDuplicateRemotePress('play', previous, 1)).toBe(false);
    });
});
