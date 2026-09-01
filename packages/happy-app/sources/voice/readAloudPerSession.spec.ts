import { beforeEach, describe, expect, it } from 'vitest';
import { ReadAloudReader, type SpeakOptions } from './readAloud';
import { readingSessionState, voiceMove } from './readingVoice';
import type { Message } from '@/sync/typesMessage';

/**
 * Reading is per session, and navigating to a reading session TAKES the voice
 * from the one that had it (DROVE-297).
 *
 * Clay, stating the rule exactly: "when I go to the phone and enable reading it
 * pauses all the other ones that are reading. More specifically, when you
 * simply navigate to another session, IF ITS READING IS ENABLED it switches to
 * it and pauses the other ones that are reading — but if it's not actively
 * having reading enabled, it does NOT pause what's currently reading."
 *
 * THREE SESSIONS, because the rule is invisible with two: the case that matters
 * is walking THROUGH a session he has not armed on his way to one he has, and
 * with two sessions there is no through.
 *
 * THE MEASUREMENT this file exists for, beside every branch of the rule: NO
 * TAKE AND NO VISIT EVER ADVANCES A PLAYHEAD. That is DROVE-289's invariant
 * carried forward, and it is the one Clay named — "if I'm switching I don't
 * wanna jump ahead". Every yield here is checked as a pause, not a stop: the
 * position is exactly where the voice left it and the return resumes on the
 * next unsaid sentence.
 */

function prose(id: string, text: string, createdAt: number): Message {
    return { id, localId: null, createdAt, kind: 'agent-text', text } as unknown as Message;
}

/** An engine whose utterances finish when the test says so. */
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

    get speaking(): boolean {
        return this.resolvers.length > 0;
    }
}

async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('the rule itself (DROVE-297)', () => {
    it('a visit takes the voice only when the target is enabled', () => {
        expect(voiceMove('visit', { holder: 'a', session: 'b', enabled: true }))
            .toEqual({ kind: 'take', session: 'b', yielding: 'a' });
        expect(voiceMove('visit', { holder: 'a', session: 'b', enabled: false }))
            .toEqual({ kind: 'keep' });
    });

    it('a visit never releases: navigation alone silences nothing', () => {
        // Even in the impossible case where the target somehow both holds the
        // voice and reads as disabled, arriving there cannot be what stops it.
        expect(voiceMove('visit', { holder: 'b', session: 'b', enabled: false }))
            .toEqual({ kind: 'keep' });
        expect(voiceMove('visit', { holder: 'b', session: 'b', enabled: true }))
            .toEqual({ kind: 'keep' });
    });

    it('enabling takes the voice wherever the request came from', () => {
        // Invariant 4, and the reason DROVE-298 can drive this from a terminal:
        // there is nothing about a thumb in it.
        expect(voiceMove('enable', { holder: 'a', session: 'c', enabled: false }))
            .toEqual({ kind: 'take', session: 'c', yielding: 'a' });
        expect(voiceMove('enable', { holder: null, session: 'c', enabled: false }))
            .toEqual({ kind: 'take', session: 'c', yielding: null });
    });

    it('disabling releases only the session that has the voice', () => {
        expect(voiceMove('disable', { holder: 'a', session: 'a', enabled: true }))
            .toEqual({ kind: 'release', session: 'a' });
        // Turning another session off must not start anything talking.
        expect(voiceMove('disable', { holder: 'a', session: 'b', enabled: true }))
            .toEqual({ kind: 'keep' });
    });

    it('names the three states the list has to tell apart', () => {
        const facts = { holder: 'a' as string | null, paused: false };
        expect(readingSessionState({ ...facts, session: 'b', enabled: false })).toBe('off');
        expect(readingSessionState({ ...facts, session: 'a', enabled: true })).toBe('reading');
        expect(readingSessionState({ ...facts, session: 'b', enabled: true })).toBe('yielded');
        // And the fourth, which is HIS pause and not a yield.
        expect(readingSessionState({ holder: 'a', session: 'a', enabled: true, paused: true }))
            .toBe('paused');
        // A session that is off is off however the voice is placed.
        expect(readingSessionState({ holder: null, session: 'a', enabled: false, paused: true }))
            .toBe('off');
    });
});

describe('reading per session, over the real reader (DROVE-297)', () => {
    let engine: FakeEngine;
    let reader: ReadAloudReader;

    /** Read the first two sentences of a four-sentence reply, then stop there. */
    async function readTwoOf(sessionId: string, messageId: string, at: number): Promise<void> {
        reader.onMessages(sessionId, [prose(messageId, 'One. Two. Three. Four.', at)]);
        await settle();
        engine.finish();
        await settle();
    }

    beforeEach(async () => {
        engine = new FakeEngine();
        reader = new ReadAloudReader(engine);
        // The default is OFF, which is the shipped default of
        // localSettings.readAloudEnabled. Every session below is armed by hand,
        // which is what the ticket is about.
        reader.setEnabled(false);
    });

    it('enable in A, visit B which is off: A keeps speaking', async () => {
        reader.setSessionEnabled('a', true);
        reader.visit('a');
        await readTwoOf('a', 'm1', 10);
        expect(engine.spoken).toEqual(['One.', 'Two.']);
        expect(engine.speaking).toBe(true);

        // THE CASE THE TICKET IS ABOUT. He walks into a session he never armed.
        reader.visit('b');
        await settle();

        expect(reader.readingSessionId).toBe('a');
        expect(reader.visitedSessionId).toBe('b');
        expect(engine.speaking, 'walking into an unarmed session silenced the voice').toBe(true);
        expect(engine.stops, 'walking into an unarmed session cut the utterance').toBe(0);
        expect(reader.readingStateOf('a')).toBe('reading');
        expect(reader.readingStateOf('b')).toBe('off');

        // And it goes on reading A's reply while he sits in B.
        engine.finish();
        await settle();
        expect(engine.spoken).toEqual(['One.', 'Two.', 'Three.']);
    });

    it('visit C which IS enabled: C speaks from its own place, A pauses at its sentence', async () => {
        reader.setSessionEnabled('a', true);
        reader.setSessionEnabled('c', true);

        // C reads two of its own four first, then he leaves it for A.
        reader.visit('c');
        reader.onMessages('c', [prose('mc', 'C one. C two. C three. C four.', 5)]);
        await settle();
        engine.finish();
        await settle();
        expect(engine.spoken).toEqual(['C one.', 'C two.']);

        reader.visit('a');
        await settle();
        await readTwoOf('a', 'ma', 10);
        expect(engine.spoken).toEqual(['C one.', 'C two.', 'One.', 'Two.']);
        expect(reader.readingSessionId).toBe('a');

        // Now C, which is armed. It takes the voice.
        reader.visit('c');
        await settle();

        expect(reader.readingSessionId).toBe('c');
        // A is holding its place, not stopped: it is armed and yielded.
        expect(reader.readingStateOf('a')).toBe('yielded');
        expect(reader.hasHeldReading('a')).toBe(true);
        // C resumed at ITS OWN position — the sentence after the last one it
        // said — not A's place and not C's tail.
        expect(engine.spoken).toEqual(['C one.', 'C two.', 'One.', 'Two.', 'C three.']);
    });

    it('return to A: A resumes where it paused, and C pauses at its own', async () => {
        reader.setSessionEnabled('a', true);
        reader.setSessionEnabled('c', true);

        reader.visit('a');
        await readTwoOf('a', 'ma', 10);
        expect(engine.spoken).toEqual(['One.', 'Two.']);

        reader.visit('c');
        await settle();
        reader.onMessages('c', [prose('mc', 'C one. C two. C three.', 20)]);
        await settle();
        expect(engine.spoken[2]).toBe('C one.');

        // Back to A. It resumes on the NEXT unsaid sentence, never re-reading
        // 'Two.' and never jumping to 'Four.'.
        reader.visit('a');
        await settle();
        expect(engine.spoken[3]).toBe('Three.');
        expect(reader.readingSessionId).toBe('a');
        expect(reader.readingStateOf('c')).toBe('yielded');
        expect(reader.hasHeldReading('c')).toBe(true);

        // And C resumes on ITS next unsaid sentence when it gets the voice back.
        engine.finish();
        await settle();
        reader.visit('c');
        await settle();
        expect(engine.spoken[engine.spoken.length - 1]).toBe('C two.');
    });

    it('enabling a session while another speaks takes the voice, with no overlap', async () => {
        reader.setSessionEnabled('a', true);
        reader.visit('a');
        await readTwoOf('a', 'ma', 10);
        expect(engine.speaking).toBe(true);

        // Invariant 4, and the shape DROVE-298 drives from the terminal: the
        // session being enabled is not even the one he is looking at.
        reader.setSessionEnabled('b', true);
        await settle();

        expect(reader.readingSessionId).toBe('b');
        expect(reader.readingStateOf('a')).toBe('yielded');
        // ONE VOICE: the take cut A's utterance before B could say anything,
        // so at no point were two sentences at the synthesiser.
        expect(engine.stops).toBeGreaterThan(0);
        expect(engine.spoken).toEqual(['One.', 'Two.']);

        reader.onMessages('b', [prose('mb', 'B one.', 30)]);
        await settle();
        expect(engine.spoken).toEqual(['One.', 'Two.', 'B one.']);
    });

    it('NO TAKE AND NO VISIT EVER ADVANCES A PLAYHEAD', async () => {
        reader.setSessionEnabled('a', true);
        reader.setSessionEnabled('c', true);
        reader.visit('a');
        await readTwoOf('a', 'ma', 10);
        const aHeld = reader.readPosition;

        // Everything the rule can do, in one run: through an unarmed session,
        // into an armed one, enabled from outside, and back.
        reader.visit('b');
        await settle();
        expect(reader.readPosition, 'a visit to an unarmed session moved the place').toBe(aHeld);

        reader.visit('c');
        await settle();
        reader.visit('b');
        await settle();
        reader.setSessionEnabled('b', true);
        await settle();
        reader.setSessionEnabled('b', false);
        await settle();
        reader.visit('a');
        await settle();

        // Back on A's own sentence, and the sentence it resumes on is the one
        // AFTER the last one heard — never 'Two.' again, never 'Four.'.
        expect(reader.readingSessionId).toBe('a');
        expect(engine.spoken.filter((s) => s === 'Three.').length).toBe(1);
        expect(engine.spoken).not.toContain('Four.');
        expect(engine.spoken.filter((s) => s === 'Two.').length).toBe(1);
    });

    it('a yielded session keeps filling, so the resume reads on through it', async () => {
        reader.setSessionEnabled('a', true);
        reader.setSessionEnabled('c', true);
        reader.visit('a');
        await readTwoOf('a', 'ma', 10);

        reader.visit('c');
        await settle();
        // A's reply grows while C has the voice (DROVE-289's fillHeld, which
        // must survive being reached through a yield rather than a bare focus).
        reader.onMessages('a', [prose('ma', 'One. Two. Three. Four. Five.', 10)]);
        await settle();

        reader.visit('a');
        await settle();
        expect(engine.spoken[engine.spoken.length - 1]).toBe('Three.');
        engine.finish();
        await settle();
        engine.finish();
        await settle();
        // It reads THROUGH to the sentence that landed while he was away
        // rather than skipping to it (DROVE-263).
        expect(engine.spoken.slice(-3)).toEqual(['Three.', 'Four.', 'Five.']);
    });

    it('a yielded session keeps filling even while the talking one is switched off', async () => {
        reader.setSessionEnabled('a', true);
        reader.setSessionEnabled('c', true);
        reader.visit('a');
        await readTwoOf('a', 'ma', 10);

        reader.visit('c');
        await settle();
        // He switches C off, so nothing at all is being read. A is still armed
        // and still holding a place, so its reply must go on queueing: a hole
        // here is a sentence he never hears.
        reader.setSessionEnabled('c', false);
        await settle();
        expect(reader.readingSessionId).toBe(null);

        reader.onMessages('a', [prose('ma', 'One. Two. Three. Four. Five.', 10)]);
        await settle();

        reader.visit('a');
        await settle();
        engine.finish();
        await settle();
        engine.finish();
        await settle();
        expect(engine.spoken.slice(-3)).toEqual(['Three.', 'Four.', 'Five.']);
    });

    it('switching a session off releases the voice and starts nothing else', async () => {
        reader.setSessionEnabled('a', true);
        reader.setSessionEnabled('c', true);
        reader.visit('c');
        await readTwoOf('c', 'mc', 5);
        reader.visit('a');
        await settle();
        await readTwoOf('a', 'ma', 10);
        const said = engine.spoken.length;

        reader.setSessionEnabled('a', false);
        await settle();

        expect(reader.readingSessionId).toBe(null);
        expect(reader.readingStateOf('a')).toBe('off');
        // C is armed and holding a place, and it stays quiet: turning one
        // session off must never start another one talking.
        expect(reader.readingStateOf('c')).toBe('yielded');
        expect(engine.spoken.length).toBe(said);
        expect(engine.speaking).toBe(false);

        // Off subsumes pause, per session: A's position is gone, so coming
        // back on is a START at new content rather than a resume (DROVE-226).
        expect(reader.hasHeldReading('a')).toBe(false);
        reader.setSessionEnabled('a', true);
        await settle();
        expect(engine.spoken.length).toBe(said);
    });

    it('switching a YIELDED session off drops its held place too', async () => {
        // Off subsumes pause, per session (DROVE-289 decision 4), and this is
        // the long way round to breaking it: A is armed, yielded and holding a
        // place. Switching it off from over here must throw that place away,
        // or coming back on resumes in the middle of a reply from before he
        // switched it off.
        reader.setSessionEnabled('a', true);
        reader.setSessionEnabled('c', true);
        reader.visit('a');
        await readTwoOf('a', 'ma', 10);
        expect(engine.spoken).toEqual(['One.', 'Two.']);

        reader.visit('c');
        await settle();
        expect(reader.hasHeldReading('a')).toBe(true);
        expect(reader.readingStateOf('a')).toBe('yielded');

        reader.setSessionEnabled('a', false);
        await settle();
        expect(reader.hasHeldReading('a'), 'a switched-off session kept its place').toBe(false);
        expect(reader.readingStateOf('a')).toBe('off');
        // C never had the voice taken from it: switching A off is not a claim.
        expect(reader.readingSessionId).toBe('c');

        // Back on, and into it: a START at new content, not a resume at the
        // stale sentence (DROVE-226).
        reader.setSessionEnabled('a', true);
        await settle();
        const said = engine.spoken.length;
        reader.visit('a');
        await settle();
        expect(engine.spoken.length, 'a re-armed session resumed a stale place').toBe(said);
        expect(engine.spoken).not.toContain('Three.');
    });

    it('the default arms a session nobody has said anything about (DROVE-179 kept)', async () => {
        // With the persisted setting on and no session individually switched
        // off, every session is enabled, so navigating takes the voice exactly
        // as it did before this ticket. That is the reconciliation with
        // DROVE-179's "the reader follows him", not a walk-back of it.
        reader.setEnabled(true);
        expect(reader.isSessionEnabled('anything-at-all')).toBe(true);
        reader.visit('a');
        await readTwoOf('a', 'ma', 10);
        reader.visit('b');
        await settle();
        expect(reader.readingSessionId).toBe('b');

        // And one session switched off is the exception, not the rule.
        reader.setSessionEnabled('c', false);
        reader.visit('c');
        await settle();
        expect(reader.readingSessionId).toBe('b');
        expect(reader.readingStateOf('c')).toBe('off');
    });

    it('the master off silences everything and forgets every session switch', async () => {
        reader.setSessionEnabled('a', true);
        reader.visit('a');
        await readTwoOf('a', 'ma', 10);

        reader.setEnabled(true);
        reader.setEnabled(false);
        await settle();
        expect(reader.readingSessionId).toBe(null);
        expect(reader.isSessionEnabled('a')).toBe(false);
        expect(engine.speaking).toBe(false);
    });

    it('a redundant master call leaves the session switches alone', async () => {
        // Two chat surfaces can be mounted and both run the effect that calls
        // this on mount, so a redundant call has to be free: one that cleared
        // the per-session switches would wipe them on every navigation.
        reader.setSessionEnabled('a', true);
        reader.visit('a');
        await readTwoOf('a', 'ma', 10);

        reader.setEnabled(false);
        reader.setEnabled(false);
        await settle();
        expect(reader.readingSessionId).toBe('a');
        expect(engine.speaking).toBe(true);
    });

    it('a call takes the route and gives the session back afterwards', async () => {
        reader.setSessionEnabled('a', true);
        reader.visit('a');
        await readTwoOf('a', 'ma', 10);

        reader.setSuspended(true);
        await settle();
        expect(reader.readingSessionId).toBe(null);
        expect(reader.readingStateOf('a')).toBe('off');
        expect(engine.speaking).toBe(false);

        // A call is not him turning reading off, so the switch he set is still
        // set when the call ends.
        reader.setSuspended(false);
        await settle();
        expect(reader.isSessionEnabled('a')).toBe(true);
        expect(reader.readingSessionId).toBe('a');
    });

    it('tells the transport listeners on every take, yield and release', async () => {
        // The wrist's reading names the session (DROVE-275) and its publish
        // rides these listeners; the change guard compares `sessionId`, so a
        // take that moved nothing else would otherwise leave the watch
        // narrating the session that yielded.
        reader.setSessionEnabled('a', true);
        reader.setSessionEnabled('b', true);
        reader.visit('a');
        await settle();

        let fired = 0;
        reader.addTransportListener(() => { fired += 1; });

        reader.visit('b');
        await settle();
        expect(fired, 'a take was silent on the wire').toBeGreaterThan(0);

        const afterTake = fired;
        reader.setSessionEnabled('b', false);
        await settle();
        expect(fired, 'a release was silent on the wire').toBeGreaterThan(afterTake);
    });

    it('reports what the phone is reading, for the terminal to print (DROVE-298)', async () => {
        expect(reader.readingReport()).toEqual({
            session: null, state: 'off', sentence: null, defaultEnabled: false,
        });

        reader.setSessionEnabled('a', true);
        reader.visit('a');
        await readTwoOf('a', 'ma', 10);
        expect(reader.readingReport()).toEqual({
            session: 'a', state: 'reading', sentence: 'Two.', defaultEnabled: false,
        });

        reader.setPaused(true);
        await settle();
        expect(reader.readingReport()).toMatchObject({ session: 'a', state: 'paused' });

        // It names the session SPEAKING, not the one focused. Switching A off
        // leaves its screen — and its focus — exactly where they were, and a
        // terminal that printed "reading a" there would be reporting a voice
        // that is not talking.
        reader.setPaused(false);
        reader.setSessionEnabled('a', false);
        await settle();
        expect(reader.focusedSessionId).toBe('a');
        expect(reader.readingReport()).toMatchObject({ session: null, state: 'off' });

        // The default is reported rather than quietly fixed: reading being off
        // by default is something the terminal SAYS, because switching audio
        // on in a phone in his pocket from a Mac is a surprise.
        reader.setEnabled(true);
        expect(reader.readingReport().defaultEnabled).toBe(true);
    });

    it('the reading session is the one speaking, not merely the one focused', async () => {
        // What `collectReading` publishes and what the Now Playing card is
        // about: the session actually speaking. A focused session he has
        // switched off has given the voice up even though its screen is there.
        reader.setSessionEnabled('a', true);
        reader.visit('a');
        await readTwoOf('a', 'ma', 10);
        expect(reader.readingSessionId).toBe('a');
        expect(reader.focusedSessionId).toBe('a');

        reader.setSessionEnabled('a', false);
        await settle();
        expect(reader.focusedSessionId).toBe('a');
        expect(reader.readingSessionId).toBe(null);
        expect(reader.isEnabled).toBe(false);
    });
});
