import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMicPress, type MicPressDeps } from './micPress';
import { HeadlessDictation, MIC_IDLE_TICK_MS } from './headlessDictation';
import { mountedDictationSurface, onDictationSurfaceChange, resetDictationSurfaces } from './dictationSurface';
import { DICTATION_LATCH_IDLE_MS } from './micMode';
import { RECOGNISER_FINAL, type DictationEngine } from './dictationCapture';
import type { ReadAloudInterruption } from './readAloud';
import type { AudioCueId } from './audioCues';
import type { RemoteCommand } from './headphonePress';

/**
 * THE PHONE IN HIS POCKET, ALL THE WAY THROUGH (DROVE-302).
 *
 * micPress.spec.ts pins the decision — who a triple press dictates into — and
 * headphoneMic.spec.ts pins the cue ordering. Neither of them opens a
 * microphone, so neither can tell you whether the press with NO SESSION SCREEN
 * MOUNTED actually captures anything, which is the acceptance criterion this
 * ticket exists for. So this file wires the module-scope press to a REAL
 * `HeadlessDictation` over a hand-driven recogniser and a hand-held draft
 * store, and asserts on what lands in the draft.
 *
 * THERE IS NO REACT ANYWHERE IN HERE, and no surface is ever registered. That
 * is the parity claim written as a test rather than as a comment: if this
 * passes, the same code runs identically with the phone locked, because
 * nothing in the path can ask which screen is up.
 *
 * WHAT IS STILL NOT COVERED, said plainly rather than implied by a green run:
 * that iOS delivers `previousTrackCommand` to a backgrounded app at all, and
 * that the first-ever microphone permission cannot be granted from the
 * background, are device facts. They are stated on the ticket, not tested here.
 */

const TRIPLE: RemoteCommand = 'previous';

/** The recogniser, driven by hand. Counts are how the test sees the mic. */
class FakeRecogniser implements DictationEngine {
    starts = 0;
    stops = 0;
    cancels = 0;
    private stopResolvers: ((text: string) => void)[] = [];

    start(): Promise<unknown> {
        this.starts += 1;
        return Promise.resolve(true);
    }

    stop(): Promise<string> {
        this.stops += 1;
        return new Promise<string>((resolve) => { this.stopResolvers.push(resolve); });
    }

    cancel(): void {
        this.cancels += 1;
    }

    /** Apple resolving the pending stop with its final transcript. */
    settleStop(text: string): void {
        const resolve = this.stopResolvers.shift();
        if (resolve === undefined) throw new Error('nothing is stopping');
        resolve(text);
    }
}

async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('a triple press with the app backgrounded and no screen mounted', () => {
    let recogniser: FakeRecogniser;
    let drafts: Record<string, string>;
    let held: boolean[];
    let cuts: number;
    let cues: AudioCueId[];
    let errors: string[];
    let clock: number;
    let ticks: Array<{ run: () => void; ms: number }>;
    let pendingCue: Array<() => void>;
    let partial: (text: string) => void;
    let ended: (text: string, reason?: string) => void;
    let interrupt: (reason: ReadAloudInterruption) => void;
    let headless: HeadlessDictation;
    let press: (command: RemoteCommand) => void;
    let holder: string | null;
    let stop: () => void;

    beforeEach(() => {
        resetDictationSurfaces();
        recogniser = new FakeRecogniser();
        drafts = {};
        held = [];
        cuts = 0;
        cues = [];
        errors = [];
        clock = 1_000;
        ticks = [];
        pendingCue = [];
        partial = () => { };
        ended = () => { };
        interrupt = () => { };
        holder = 's1';

        headless = new HeadlessDictation({
            engine: recogniser,
            draft: (session) => drafts[session] ?? '',
            setDraft: (session, text) => { drafts[session] = text; },
            micHeld: (next) => { held.push(next); },
            cutReading: () => {
                cuts += 1;
                // The reader's own interrupt bus, exactly as readAloudService
                // wires it: cutting reading for the mic reaches the capture.
                interrupt('mic');
            },
            onError: (message) => { errors.push(message); },
            onInterrupt: (listener) => { interrupt = listener; return () => { interrupt = () => { }; }; },
            onPartial: (listener) => { partial = listener; return () => { partial = () => { }; }; },
            onEnded: (listener) => { ended = listener; return () => { ended = () => { }; }; },
            interval: (run, ms) => {
                const entry = { run, ms };
                ticks.push(entry);
                return () => { ticks = ticks.filter((each) => each !== entry); };
            },
            now: () => clock,
        });

        const deps: MicPressDeps = {
            available: () => true,
            holder: () => holder,
            mounted: () => mountedDictationSurface(),
            onSurfaceChange: (listener) => onDictationSurfaceChange(listener),
            headless,
            blocked: () => false,
            ack: (id) => { cues.push(id); },
            duration: () => 200,
            delay: (run) => {
                pendingCue.push(run);
                return () => { pendingCue = pendingCue.filter((each) => each !== run); };
            },
            subscribe: (listener) => {
                press = listener;
                return { remove: () => { press = () => { }; } };
            },
        };
        press = () => { };
        stop = startMicPress(deps);
    });

    afterEach(() => {
        stop();
        headless.dispose();
        resetDictationSurfaces();
    });

    /** The open cue finishing, which the microphone waits for. */
    function runCue(): void {
        for (const run of pendingCue.splice(0)) run();
    }

    /** The 500ms idle clock firing once. */
    function tick(): void {
        for (const entry of [...ticks]) entry.run();
    }

    it('opens the microphone into the session holding the voice', async () => {
        expect(mountedDictationSurface()).toBe(null);

        press(TRIPLE);
        runCue();
        await settle();

        expect(cues).toEqual(['micOpen']);
        expect(recogniser.starts).toBe(1);
        expect(headless.capturing()).toBe(true);
        expect(headless.session).toBe('s1');
    });

    it('puts what he says in that session draft, where the composer will find it', async () => {
        press(TRIPLE);
        runCue();
        await settle();

        partial('remind me to');
        partial('remind me to buy milk');

        expect(drafts.s1).toBe('remind me to buy milk');
    });

    it('joins onto the draft he already had, once, not once per partial', async () => {
        // The base is snapshotted when the mic opens. Reading it live would
        // re-join the transcript onto itself on every partial, which is
        // DROVE-140's duplication bug reached from a new direction.
        drafts.s1 = 'earlier words';

        press(TRIPLE);
        runCue();
        await settle();

        partial('and');
        partial('and then some');

        expect(drafts.s1).toBe('earlier words and then some');
    });

    it('gates the reader for the whole capture and gives the session back after', async () => {
        press(TRIPLE);
        runCue();
        await settle();
        expect(held).toEqual([true]);
        expect(cuts).toBe(1);

        partial('hello');
        press(TRIPLE);
        await settle();
        recogniser.settleStop('hello');
        await settle();

        expect(held).toEqual([true, false]);
    });

    it('closes on a second press, keeps the words and SENDS NOTHING', async () => {
        press(TRIPLE);
        runCue();
        await settle();
        partial('this is a note');

        press(TRIPLE);
        await settle();
        recogniser.settleStop('this is a note');
        await settle();

        expect(cues).toEqual(['micOpen', 'micClosed']);
        // DROVE-105: only a LIFT sends, and a headphone press has no lift. A
        // close is a `stop`, which transcribes and keeps; `send` is never
        // reached from here, which the source assertion at the bottom pins.
        expect(recogniser.stops).toBe(1);
        expect(drafts.s1).toBe('this is a note');
        expect(headless.capturing()).toBe(false);
    });

    it('stops itself when the latch goes idle, so a pocket mic is never stranded', async () => {
        // DROVE-259: the capture holds the audio session in .playAndRecord,
        // and nothing on screen is going to close it. The idle clock is the
        // only thing standing between a mis-press and a phone recording all
        // afternoon, so it has to run with no component driving it.
        press(TRIPLE);
        runCue();
        await settle();
        partial('a half sentence');

        expect(ticks.length).toBe(1);
        expect(ticks[0].ms).toBe(MIC_IDLE_TICK_MS);

        clock += DICTATION_LATCH_IDLE_MS + 1;
        tick();
        await settle();
        recogniser.settleStop('a half sentence');
        await settle();

        expect(headless.capturing()).toBe(false);
        expect(drafts.s1).toBe('a half sentence');
        expect(ticks.length).toBe(0);
    });

    it('survives the recogniser finalising an utterance mid-pause', async () => {
        // DROVE-140: a `final` is a pause, not an ending. It must reopen the
        // microphone here exactly as it does on screen, or a breath ends the
        // capture in his pocket.
        press(TRIPLE);
        runCue();
        await settle();
        partial('first sentence');

        ended('first sentence', RECOGNISER_FINAL);
        await settle();

        expect(headless.capturing()).toBe(true);
        expect(recogniser.starts).toBe(2);

        partial('second sentence');
        expect(drafts.s1).toBe('first sentence second sentence');
    });

    it('keeps the words when something else takes the audio', async () => {
        press(TRIPLE);
        runCue();
        await settle();
        partial('half said');

        interrupt('call-started');
        await settle();

        expect(headless.capturing()).toBe(false);
        expect(drafts.s1).toBe('half said');
    });

    it('writes into the session of the CURRENT press, not the one before it', async () => {
        // The draft a capture belongs to is decided at every open. A second
        // press after the voice moved must not still be pointed at the first
        // session's composer.
        press(TRIPLE);
        runCue();
        await settle();
        partial('first note');
        press(TRIPLE);
        await settle();
        recogniser.settleStop('first note');
        await settle();

        holder = 's2';
        press(TRIPLE);
        runCue();
        await settle();
        partial('second note');

        expect(headless.session).toBe('s2');
        expect(drafts.s2).toBe('second note');
        expect(drafts.s1).toBe('first note');
    });

    it('will not open a second capture over a live one', async () => {
        // Nothing on the press path can reach this today — `HeadphoneMic`
        // closes a live capture rather than opening, and refuses while the
        // recogniser settles — so it is defence in depth against the next
        // caller. Two `begin`s over one recogniser would re-snapshot the base
        // and lose everything already heard.
        press(TRIPLE);
        runCue();
        await settle();
        partial('mid sentence');

        headless.open('s2');
        await settle();

        expect(headless.session).toBe('s1');
        expect(recogniser.starts).toBe(1);
        expect(drafts.s1).toBe('mid sentence');
        expect(drafts.s2).toBeUndefined();
    });

    it('never opens against a session he is not listening to', async () => {
        // The double press moved the voice, and there is no screen to check
        // against, so the mic follows the VOICE. It can only ever open on the
        // session that is being read to him.
        holder = 's2';

        press(TRIPLE);
        runCue();
        await settle();

        expect(headless.session).toBe('s2');
        expect(drafts.s1).toBeUndefined();
    });
});

const sourcesRoot = resolve(__dirname, '..');

function read(relative: string): string {
    return readFileSync(join(sourcesRoot, relative), 'utf8');
}

/**
 * A HEADPHONE PRESS NEVER SENDS, read out of the source (DROVE-105).
 *
 * `DictationCapture.send()` is the only path that sets `shouldSend`, and the
 * behaviour test above cannot prove a call that is not there: an assertion on
 * a counter nothing increments passes whether or not the rule holds. So the
 * rule is asserted where it actually lives — this path calls `stop()` and
 * never `send()`, and its composer port's `send` is wired to nothing.
 *
 * Coarse, and it catches the exact regression that matters: a sentence said
 * into a pocket reaching an agent with nobody having read it first.
 */
describe('a press in his pocket cannot send (DROVE-105)', () => {
    const source = read('voice/headlessDictation.ts');

    it('never calls send on the capture', () => {
        expect(source).not.toMatch(/\bcapture\.send\s*\(/);
    });

    it('stops the capture instead', () => {
        expect(source).toMatch(/\bcapture\.stop\s*\(/);
    });

    it('wires the composer port send to nothing', () => {
        expect(source).toMatch(/send:\s*\(\)\s*=>\s*\{\s*\}/);
    });
});
