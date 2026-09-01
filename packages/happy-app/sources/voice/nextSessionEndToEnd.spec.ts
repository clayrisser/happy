import { beforeEach, describe, expect, it } from 'vitest';
import { ReadAloudReader, type SpeakOptions } from './readAloud';
import { startNextSessionPress } from './nextSession';
import type { RemoteCommand } from './headphonePress';
import type { Message } from '@/sync/typesMessage';

/**
 * The double press, driven through the REAL reader (DROVE-300).
 *
 * nextSession.spec.ts pins the decision and readingCycle.spec.ts pins the set.
 * Neither of them touches a reader, so neither can tell you whether the press
 * actually hands the voice over without losing a place — which is the whole
 * acceptance criterion, and the exact thing that was silently broken before
 * DROVE-289 (`focus` threw the reading away and coming back resumed at the
 * tail). So this file wires the press to a real `ReadAloudReader` with two and
 * three sessions and asserts positions on both sides of every press.
 *
 * THE CYCLE IS ASKED OF THE REAL READER, not handed in as a literal, so
 * DROVE-297's per-session switch is in the loop: a session switched off drops
 * out of the ring here the same way it does on his phone.
 *
 * NO MOUNTED SCREEN ANYWHERE IN HERE, which is the parity claim stated as a
 * test rather than as a comment. The press stream, the reader and the cycle
 * are all plain objects; there is no react, no navigation and no AppState. If
 * this passes, the same code path runs identically with the phone locked,
 * because there is nothing in it that could ask.
 */

function prose(id: string, text: string, createdAt: number): Message {
    return { id, localId: null, createdAt, kind: 'agent-text', text } as unknown as Message;
}

/** The engine from readAloudSessionSwitch.spec.ts: utterances finish on cue. */
class FakeEngine {
    spoken: string[] = [];
    stops = 0;
    private resolvers: Array<() => void> = [];

    speak(text: string, _options?: SpeakOptions): Promise<unknown> {
        this.spoken.push(text);
        return new Promise<void>((resolve) => { this.resolvers.push(resolve); });
    }

    stop(): void {
        this.stops += 1;
        for (const resolve of this.resolvers.splice(0)) resolve();
    }

    finish(): void {
        const resolve = this.resolvers.shift();
        if (resolve === undefined) throw new Error('nothing is speaking');
        resolve();
    }

    /** Two utterances in flight at once would be two voices at once. */
    get inFlight(): number {
        return this.resolvers.length;
    }
}

async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('a double press hands the voice to the next reading-enabled session', () => {
    let engine: FakeEngine;
    let reader: ReadAloudReader;
    let sessions: string[];
    let press: (command: RemoteCommand) => void;
    let stop: () => void;
    let cued: string[];
    let named: string[];
    /** Every side effect of one press, in the order it happened. */
    let order: string[];

    beforeEach(() => {
        cued = [];
        named = [];
        order = [];
        engine = new FakeEngine();
        reader = new ReadAloudReader(engine);
        // The master default, which DROVE-297 makes a default rather than a
        // command: every session is armed until he switches one off.
        reader.setEnabled(true);
        reader.visit('s1');
        sessions = ['s1', 's2'];
        let listener: ((command: RemoteCommand) => void) | null = null;
        stop = startNextSessionPress({
            // readingCycle.ts's job, with the store's rows stubbed to a plain
            // list: the ORDER is the list's and the MEMBERSHIP is DROVE-297's,
            // asked of the real reader.
            cycle: () => sessions.filter((id) => reader.isSessionEnabled(id)),
            current: () => reader.readingSessionId,
            take: (sessionId) => {
                order.push(`take:${sessionId}`);
                reader.takeVoice(sessionId);
            },
            ack: (id) => {
                cued.push(id);
                order.push(`cue:${id}`);
            },
            announce: (sessionId) => {
                named.push(sessionId);
                order.push(`named:${sessionId}`);
            },
            subscribe: (fn) => {
                listener = fn;
                return { remove: () => { listener = null; } };
            },
        });
        press = (command) => listener?.(command);
    });

    it('pauses the current session at its sentence and never advances it', async () => {
        reader.onMessages('s1', [prose('m1', 'One. Two. Three. Four.', 10)]);
        await settle();
        engine.finish();
        await settle();
        // 'Two.' is at the synthesiser when he double-presses.
        expect(engine.spoken).toEqual(['One.', 'Two.']);

        const before = engine.spoken.length;
        press('next');
        await settle();

        // The utterance in flight is cut, nothing new is said out of s1, and
        // s1 is holding its place rather than having been stopped.
        expect(engine.spoken.length).toBe(before);
        expect(reader.hasHeldReading('s1')).toBe(true);
        expect(reader.readingSessionId).toBe('s2');
        expect(reader.isSessionEnabled('s1')).toBe(true);
    });

    it('never has two sessions speaking at once', async () => {
        reader.onMessages('s1', [prose('m1', 'One. Two. Three.', 10)]);
        await settle();
        expect(engine.inFlight).toBe(1);

        press('next');
        await settle();
        // The old session's utterance was settled by the switch, and the new
        // session has nothing to say yet, so the synthesiser is empty.
        expect(engine.inFlight).toBe(0);

        reader.onMessages('s2', [prose('m2', 'Alpha. Beta.', 20)]);
        await settle();
        expect(engine.inFlight).toBe(1);
        expect(engine.spoken).toEqual(['One.', 'Alpha.']);
    });

    it('resumes the session it comes back to at ITS own held position', async () => {
        reader.onMessages('s1', [prose('m1', 'One. Two. Three. Four.', 10)]);
        await settle();
        engine.finish();
        await settle();
        expect(engine.spoken).toEqual(['One.', 'Two.']);

        press('next');
        await settle();
        reader.onMessages('s2', [prose('m2', 'Alpha. Beta. Gamma.', 20)]);
        await settle();
        expect(engine.spoken).toEqual(['One.', 'Two.', 'Alpha.']);

        // Wraps back to s1, which resumes at the sentence after the one it was
        // cut in — DROVE-233's granularity, and never at the tail.
        press('next');
        await settle();
        expect(reader.readingSessionId).toBe('s1');
        expect(engine.spoken).toEqual(['One.', 'Two.', 'Alpha.', 'Three.']);
    });

    it('walks the whole ring and wraps at the end', async () => {
        sessions = ['s1', 's2', 's3'];
        press('next');
        await settle();
        expect(reader.readingSessionId).toBe('s2');
        press('next');
        await settle();
        expect(reader.readingSessionId).toBe('s3');
        press('next');
        await settle();
        expect(reader.readingSessionId).toBe('s1');
    });

    it('skips the sessions whose reading he switched off (DROVE-297)', async () => {
        // Not a list this file filters: `setSessionEnabled(false)` is his own
        // switch, and the ring reads it through `isSessionEnabled`. No number
        // of presses reaches s2.
        sessions = ['s1', 's2', 's3'];
        reader.setSessionEnabled('s2', false);
        press('next');
        await settle();
        expect(reader.readingSessionId).toBe('s3');
        press('next');
        await settle();
        expect(reader.readingSessionId).toBe('s1');
    });

    it('does nothing at all when only one session has reading enabled', async () => {
        sessions = ['s1', 's2'];
        reader.setSessionEnabled('s2', false);
        reader.onMessages('s1', [prose('m1', 'One. Two. Three.', 10)]);
        await settle();
        expect(engine.spoken).toEqual(['One.']);
        const stopsBefore = engine.stops;

        press('next');
        press('next');
        await settle();

        // Not a stop, not a pause, not a lost place: the sentence in flight is
        // still in flight and the reader has not moved.
        expect(engine.stops).toBe(stopsBefore);
        expect(engine.spoken).toEqual(['One.']);
        expect(reader.readingSessionId).toBe('s1');
        expect(reader.isPaused).toBe(false);
        expect(reader.isSessionEnabled('s1')).toBe(true);

        engine.finish();
        await settle();
        expect(engine.spoken).toEqual(['One.', 'Two.']);
    });

    it('does not turn reading on from a pocket', async () => {
        // Reading switched off everywhere empties the cycle, so the press has
        // nowhere to go. DROVE-189's rule, structural rather than a flag.
        reader.setEnabled(false);
        press('next');
        press('next');
        await settle();
        expect(reader.readingSessionId).toBeNull();
        expect(engine.spoken).toEqual([]);
    });

    it('leaves the single press and the triple press alone', async () => {
        reader.onMessages('s1', [prose('m1', 'One. Two.', 10)]);
        await settle();
        press('toggle');
        press('play');
        press('pause');
        press('previous');
        await settle();
        // The transport is backgroundAudio.ts's and the mic is
        // useVoiceComposer's. This subscription must not answer either.
        expect(reader.readingSessionId).toBe('s1');
        expect(reader.isPaused).toBe(false);
    });

    it('does not claim he navigated anywhere', async () => {
        // `takeVoice`, not `visit`. The phone is in his pocket: the session he
        // is LOOKING at has not changed, and a press that moved it would have
        // the list and the composer draw a screen he never opened.
        press('next');
        await settle();
        expect(reader.readingSessionId).toBe('s2');
        expect(reader.visitedSessionId).toBe('s1');
    });

    it('stops answering once it is torn down', async () => {
        stop();
        press('next');
        await settle();
        expect(reader.readingSessionId).toBe('s1');
    });

    it('answers the press out loud, and names the session before it speaks', async () => {
        // The gap is the point. He presses in the street, s2 is waiting on a
        // reply and says nothing for a minute: without a cue the press is
        // indistinguishable from a dead button, and without a name the lock
        // screen still says s1 the whole time.
        press('next');
        await settle();
        expect(cued).toEqual(['sessionSkipped']);
        expect(named).toEqual(['s2']);
        expect(reader.readingSessionId).toBe('s2');
    });

    it('names the session BEFORE the take, so a sentence can overwrite it', async () => {
        // Ordering, and it is the reason `announce` is a line above `take`
        // rather than below it. The take can start s2's first sentence
        // synchronously and the synthesiser titles the card with what it is
        // saying; naming the session after that would replace a true title
        // with a weaker one. The cue leads both, so it plays into the gap the
        // take opens rather than over the sentence it starts.
        order.length = 0;
        press('next');
        await settle();
        expect(order).toEqual(['cue:sessionSkipped', 'named:s2', 'take:s2']);

        // And the sentence that overwrites the name really does come after
        // it, which is what makes the ordering matter rather than being a
        // preference. Fed AFTER the press because a session with no held
        // reading is not listening until it has the voice.
        reader.onMessages('s2', [prose('m2', 'Alpha.', 20)]);
        await settle();
        expect(engine.spoken).toEqual(['Alpha.']);
    });

    it('refuses out loud when only one session is armed', async () => {
        // The ticket's own words: "a double press is a no-op rather than a
        // stop — say so if that reads badly in practice". Silent was the way
        // it read badly, so the no-op now says so.
        reader.setSessionEnabled('s2', false);
        await settle();
        cued.length = 0;
        named.length = 0;
        press('next');
        await settle();
        expect(cued).toEqual(['skipRefused']);
        expect(named).toEqual([]);
        expect(reader.readingSessionId).toBe('s1');
    });

    it('refuses out loud with reading switched off everywhere', async () => {
        // DROVE-189's rule is structural now — an empty cycle — and it must
        // still make a sound, or a phone with reading off everywhere has a
        // headphone button that is silently dead.
        reader.setSessionEnabled('s1', false);
        reader.setSessionEnabled('s2', false);
        await settle();
        cued.length = 0;
        press('next');
        await settle();
        expect(cued).toEqual(['skipRefused']);
    });
});
