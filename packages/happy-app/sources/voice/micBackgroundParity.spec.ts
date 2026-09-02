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
    let sent: Array<{ session: string; text: string }>;
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
        sent = [];
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
            send: (session, text) => { sent.push({ session, text }); },
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

    it('closes on a second press AND SENDS what he said, exactly once (DROVE-370)', async () => {
        // Clay: "triple tap should also end it, and when it ends it should
        // auto-submit." The hands-free path has no screen to read the words on
        // and no send button to press, so the gesture that ends the capture is
        // the gesture that sends it.
        press(TRIPLE);
        runCue();
        await settle();
        partial('this is a note');

        press(TRIPLE);
        await settle();
        recogniser.settleStop('this is a note');
        await settle();

        expect(cues).toEqual(['micOpen', 'micClosed']);
        expect(recogniser.stops).toBe(1);
        expect(sent).toEqual([{ session: 's1', text: 'this is a note' }]);
        // A send clears the composer, so it clears the draft the composer
        // hydrates from. Leaving it would put the sent sentence back in front
        // of him the next time he opened the session.
        expect(drafts.s1).toBe('');
        expect(headless.capturing()).toBe(false);
    });

    it('a second press with nothing heard closes SILENTLY and sends nothing', async () => {
        // A mis-press, or a press into a room that stayed quiet. There is no
        // message to send, and inventing an empty one would put a blank turn
        // in front of the agent. `DictationCapture.finish` discards rather
        // than commits on an empty final, so this falls out of the commit path
        // rather than being a second rule.
        press(TRIPLE);
        runCue();
        await settle();

        press(TRIPLE);
        await settle();
        recogniser.settleStop('');
        await settle();

        expect(cues).toEqual(['micOpen', 'micClosed']);
        expect(sent).toEqual([]);
        expect(drafts.s1 ?? '').toBe('');
        expect(headless.capturing()).toBe(false);
    });

    it('sends what is in the draft, base and all, not only the last segment', async () => {
        // The base is the draft he already had. A send that posted only the
        // recogniser's final would drop it, which is the same class of bug as
        // DROVE-140's duplication seen from the other side.
        drafts.s1 = 'earlier words';

        press(TRIPLE);
        runCue();
        await settle();
        partial('and then some');

        press(TRIPLE);
        await settle();
        recogniser.settleStop('and then some');
        await settle();

        expect(sent).toEqual([{ session: 's1', text: 'earlier words and then some' }]);
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
        // ONLY A PRESS SENDS (DROVE-370). A timeout is not him asking for
        // anything, so the words wait in the draft exactly as they always did.
        expect(sent).toEqual([]);
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
        // A call taking the audio is not him pressing anything (DROVE-370).
        expect(sent).toEqual([]);
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
        // s1's note LEFT as a message rather than sitting in its draft, which
        // is DROVE-370's closing press doing its job. What this test is about
        // is unchanged: the second capture is pointed at s2 and nothing it
        // hears reaches s1.
        expect(sent).toEqual([{ session: 's1', text: 'first note' }]);
        expect(drafts.s1).toBe('');
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
 * ONE GESTURE SENDS, AND IT IS THE ONE HE NAMED (DROVE-370, superseding this
 * file's DROVE-105 source assertion).
 *
 * What used to be here read `headlessDictation.ts` as text and asserted that
 * `capture.send` was never called and the composer port's `send` was wired to
 * `() => {}`. That was the right shape of proof for a rule that said NOTHING
 * may send: the behaviour tests cannot prove the absence of a call, because an
 * assertion on a counter nothing increments passes either way.
 *
 * The rule is no longer "nothing sends". Clay named a gesture — the second
 * triple press — so the claim worth pinning changed from an absence to a
 * BOUNDARY: exactly one route sends, and every other way a capture can end
 * still leaves the words in the draft. A boundary is testable behaviourally,
 * and behaviourally is better than by regex, so it is asserted with a spy on
 * the send dep rather than by reading the file.
 *
 * The regression this guards is unchanged and is the reason the old assertion
 * existed: a sentence said into a pocket reaching an agent that he never asked
 * to send. It can now happen only on a deliberate second press, after the open
 * cue he already heard, answered by the close cue.
 */
describe('exactly one route sends, and it is the closing press (DROVE-370)', () => {
    const source = read('voice/headlessDictation.ts');

    it('close() still stops the capture rather than sending it', () => {
        expect(source).toMatch(/close\(\): void \{\s*this\.capture\.stop\(\);/);
    });

    it('commit() is the only thing that calls send on the capture', () => {
        const calls = source.match(/\bthis\.capture\.send\s*\(/g) ?? [];
        expect(calls.length).toBe(1);
        expect(source).toMatch(/commit\(\): void \{\s*this\.capture\.send\(\);/);
    });

    it('and micPress calls commit only to CLOSE, never to open', () => {
        // Opening still goes through `open`/`tap`. A `commit` on the opening
        // branch would send whatever happened to be in the draft already.
        const press = read('voice/micPress.ts');
        expect(press).toMatch(/if \(deps\.headless\.capturing\(\)\) \{\s*deps\.headless\.commit\(\);/);
        expect(press).toMatch(/if \(surface !== null && surface\.capturing\(\)\) \{\s*surface\.commit\(\);/);
        expect(press).toMatch(/deps\.headless\.open\(target\.session\);/);
    });
});
