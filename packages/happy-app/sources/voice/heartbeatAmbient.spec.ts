import { beforeEach, describe, expect, it } from 'vitest';
import { AudioCueMixer, cueStaleMs } from './audioCueMixer';
import { createCuedSpeechEngine } from './cuedSpeechEngine';
import { ReadAloudReader, type SpeakOptions } from './readAloud';
import { isWorkingCue, type AudioCueId } from './audioCues';
import { audioCuesDefaults, type AudioCues } from '@/sync/settings';
import type { Message } from '@/sync/typesMessage';

/**
 * THE HEARTBEAT IS AMBIENT. AN EARCON IS AN EVENT (DROVE-197).
 *
 * Clay, minutes after the cue layer shipped: "Why did heartbeat stop." He had
 * asked for "a heartbeat that pulses when the reading isn't talking yet we
 * still have things working", and DROVE-174 took exactly that case away.
 *
 * Not by gating the beat on `speechPending`, which is where the ticket
 * expected to find it, and not by dropping it as stale, which never touched it
 * because a beat is never queued. By something duller: the beat was decided
 * LAST in a tick, after the event queue and after a 700ms courtesy window that
 * kept ambient clear of every earcon. Both were written when a tool cue was
 * one per RUN and capped at six a minute. DROVE-174 made it one per CALL with
 * no cap, so on any working session the courtesy window was open essentially
 * always and the beat had nowhere left to land. Measured below: sixty earcons
 * in a minute, zero beats.
 *
 * The fix is the distinction, written into audioCueMixer.ts so it cannot blur
 * again. An EVENT is tied to a moment: it queues, it waits for a genuine gap,
 * and it is dropped if none opens. The HEARTBEAT is ambient and periodic: it
 * is never queued, so it can never be stale; it sounds when the route is clear
 * and is simply not heard when it is not; and its cadence is measured from the
 * beat that was HEARD, so a busy stretch costs the beats inside it and nothing
 * after them.
 *
 * The scenarios with speech in them drive the REAL reader through the REAL
 * engine wrapper, because "is the voice talking" is a fact about that wiring
 * and asserting it against a hand-set boolean would prove nothing.
 */

describe('the heartbeat is ambient, the earcon is an event', () => {
    let now = 0;
    let played: string[] = [];
    let spoken: string[] = [];
    let config: Required<AudioCues>;
    let reader: ReadAloudReader;
    let mixer: AudioCueMixer;
    /** Resolvers for the utterances still at the synthesiser. */
    let inFlight: (() => void)[] = [];

    function message(id: string, text: string, createdAt: number): Message {
        return { id, localId: null, createdAt, kind: 'agent-text', text } as unknown as Message;
    }

    /** Beats only. An assertion about the heartbeat is not about earcons. */
    function beats(): string[] {
        return played.filter((id) => isWorkingCue(id as AudioCueId) || id.startsWith('waiting'));
    }

    beforeEach(() => {
        now = 1_000_000;
        played = [];
        spoken = [];
        inFlight = [];
        config = { ...audioCuesDefaults };
        mixer = new AudioCueMixer({
            now: () => now,
            play: (id) => { played.push(id); },
            settings: () => config,
            speechPending: () => reader.speechPending,
        });
        reader = new ReadAloudReader(
            createCuedSpeechEngine(
                {
                    speak(text: string, _options?: SpeakOptions) {
                        spoken.push(text);
                        return new Promise<void>((resolve) => { inFlight.push(() => resolve()); });
                    },
                    stop() { },
                },
                mixer,
            ),
            { now: () => now },
        );
        reader.setEnabled(true);
        reader.focus('s1');
        mixer.setState({ reading: true, working: true, pendingKinds: [], agents: 0 });
    });

    /** The reader chains through a few microtasks before it speaks. */
    async function settle(): Promise<void> {
        for (let i = 0; i < 8; i++) await Promise.resolve();
    }

    /** End the utterance at the synthesiser, as the engine's promise would. */
    async function finishSentence(): Promise<void> {
        inFlight.shift()?.();
        await settle();
    }

    /** Run the owner's clock forward, ticking as the cue service does. */
    function run(ms: number, everyMs = 50): void {
        for (let elapsed = 0; elapsed < ms; elapsed += everyMs) {
            now += everyMs;
            mixer.tick();
        }
    }

    it('pulses through a long silent working stretch', () => {
        // Nothing at the synthesiser and nothing queued to say: the plain case
        // Clay described, and the one everything else is a variation on. At
        // the 6s default that is ten beats a minute.
        run(60_000);
        expect(beats().length).toBe(10);
    });

    it('pulses on a BUSY session, where an earcon lands every second', async () => {
        // THE REGRESSION. A working session firing a tool call a second, each
        // with a short spoken title, so there is real speech and a real earcon
        // in every second of the minute — and 700ms of genuine silence too,
        // which is all a beat has ever needed. This measured zero beats.
        for (let second = 0; second < 60; second++) {
            reader.onMessages('s1', [message(`m${second}`, 'Reading.', now)]);
            mixer.event('toolCall');
            await settle();
            run(300);
            await finishSentence();
            run(700);
        }
        expect(beats().length).toBe(10);
        // And not by taking anything from the earcons, which is the other half
        // of the trade this could have been fixed with and must not be.
        expect(played.filter((id) => id === 'toolCall').length).toBe(60);
        expect(mixer.dropped).toBe(0);
    });

    it('skips while a sentence is at the synthesiser, and resumes after it', async () => {
        // Skipped, never cancelled. The voice owns the route for ten seconds
        // and the beat is simply not heard; nothing has to re-arm it.
        reader.onMessages('s1', [message('m1', 'A long answer that is being read out.', now)]);
        await settle();
        expect(spoken.length).toBe(1);
        run(10_000);
        expect(beats()).toEqual([]);

        await finishSentence();
        run(15_000);
        expect(beats().length).toBeGreaterThanOrEqual(2);
        // The voice was never touched by any of it.
        expect(spoken).toEqual(['A long answer that is being read out.']);
    });

    it('resumes on the first beat after speech stops, not an interval later', async () => {
        // "Resumes" has to mean promptly. A cadence that restarted its clock
        // only once six more seconds had passed would read, in a pocket, as
        // the heartbeat still being dead.
        reader.onMessages('s1', [message('m1', 'Working on it.', now)]);
        await settle();
        run(20_000);
        expect(beats()).toEqual([]);
        await finishSentence();
        run(500);
        expect(beats().length).toBe(1);
    });

    it('is never dropped as stale; only an event cue is', async () => {
        // A beat is not a claim about a moment, so there is nothing about it
        // that can stop being true. Twenty minutes of a silent working session
        // is twenty minutes of beats and not one drop.
        run(20 * 60_000, 250);
        expect(beats().length).toBe(200);
        expect(mixer.dropped).toBe(0);
    });

    it('still drops an event cue when no gap ever opens', async () => {
        // DROVE-174 intact, and this is the half that must NOT change: an
        // earcon with nowhere to go is dropped rather than played late.
        reader.onMessages('s1', [message('m1', 'One. Two. Three. Four.', now)]);
        await settle();
        mixer.event('toolCall');
        run(cueStaleMs + 500);
        expect(played.filter((id) => id === 'toolCall')).toEqual([]);
        expect(mixer.dropped).toBe(1);
        expect(mixer.pending).toBe(0);
    });

    it('stops the beat when the state it describes goes away', () => {
        // The one thing that DOES end the heartbeat: the session is no longer
        // working, so there is nothing for a beat to mean.
        run(12_000);
        const before = beats().length;
        expect(before).toBeGreaterThan(0);
        mixer.setState({ reading: true, working: false, pendingKinds: [], agents: 0 });
        run(30_000);
        expect(beats().length).toBe(before);
    });

    it('beats at once when the state changes, without waiting out the cadence', () => {
        // DROVE-182: an agent starting changes the count the beat is saying,
        // and going to waiting-on-Clay changes the pulse entirely. Either is
        // the moment the sound exists to report.
        run(1_000);
        expect(beats()).toEqual(['working:1']);
        mixer.setState({ reading: true, working: true, pendingKinds: ['question'], agents: 0 });
        // Past the working beat's own length: a change of state does not cut
        // the beat already sounding, it lands the moment that one is over.
        run(500);
        expect(beats()).toEqual(['working:1', 'waitingQuestion']);
    });
});
