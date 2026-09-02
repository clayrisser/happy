import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A pause silences the WHOLE audio channel, not only the voice (DROVE-354).
 *
 * Clay, on build 19, pausing from the lock screen with the reading on the
 * island: "when I pause, it does pause the reading, but it doesn't pause all
 * the beeping. It should pause everything, because the whole point of pausing
 * is to have it be silent."
 *
 * WHY IT LEAKED, because the shape of the bug is what this file has to pin.
 * DROVE-233's pause stops the voice and holds the place, and `speechPending`
 * answers FALSE while paused on purpose — a pause lasts until he presses
 * something, and a mixer that read it as "speech is coming" would hold every
 * earcon until it went stale and silence the heartbeat for the duration. That
 * is the right answer to the question it was asked, and it is exactly what
 * left the cues playing: to the mixer a pause looked like the genuine gap it
 * had been waiting for. The reader keeps ingesting for the focused session
 * while paused (DROVE-233 again: the timeline keeps filling), so every tool
 * call, every agent and the first prose of every reply walked the message path
 * and fired an earcon into the silence he had just asked for. DROVE-341 had
 * put those earcons on the same session and the same gain as the voice, so
 * they arrived at the volume of the thing he paused.
 *
 * WHAT IS REAL HERE. The service, the mixer, the title tracker, the gate
 * collection, the reader and the transport table are all the real ones, wired
 * the way readAloudService.ts and backgroundAudio.ts wire them. Two seams are
 * cut: `cuePlayer`, the one file in the cue system that touches the device,
 * and the store the service reads its ambient state from. Everything the
 * ticket is about is on this side of those two.
 */

const fake = vi.hoisted(() => ({
    played: [] as string[],
    state: {
        settings: {} as Record<string, unknown>,
        sessions: {} as Record<string, unknown>,
    },
}));

// The device. react-native and expo-audio live behind this import, and a cue
// reaching it is the whole definition of "a sound was made".
vi.mock('./cuePlayer', () => ({
    playCue: (id: string) => { fake.played.push(id); },
    warmCuePlayers: () => {},
    releaseCuePlayers: () => {},
}));

// The store the service reads the ambient state out of: `thinking` for the
// working pulse and `agentState.requests` for the gates, which are the same
// two the status row and the gate cards are drawn from.
vi.mock('@/sync/storage', () => ({ storage: { getState: () => fake.state } }));

import { audioCues } from './audioCueService';
import { ReadAloudReader } from './readAloud';
import { createCuedSpeechEngine } from './cuedSpeechEngine';
import { readAloudTransport, transportEffect, type TransportGesture } from './readAloudTransport';
import type { Message } from '@/sync/typesMessage';

function toolCall(id: string, name = 'Bash'): Message {
    return {
        id,
        localId: null,
        createdAt: 1,
        kind: 'tool-call',
        tool: { name, state: 'running', input: {} },
    } as unknown as Message;
}

/** A subagent spawning, which is `agentStart` rather than a tool tick. */
function agentSpawn(id: string): Message {
    return toolCall(id, 'Task');
}

function prose(id: string, text: string): Message {
    return { id, localId: null, createdAt: 2, kind: 'agent-text', text } as unknown as Message;
}

describe('a pause silences the cues too', () => {
    /**
     * An hour on for every test, and it is not decoration.
     *
     * The service is a SINGLETON — one speaker on the device — so it carries
     * its own last-read stamp between tests, while `useFakeTimers` rewinds the
     * clock to the wall time of whatever test is starting. The second test
     * then sits a few seconds BEFORE the stamp the first one left, the ambient
     * state is never re-read, and the mixer beats about the previous test's
     * session. That is a harness fault reading exactly like a product one, and
     * it cost the gate assertion below its meaning until the clock only ever
     * moved forward.
     */
    let clock = Date.now();

    /** A fresh id per test, so the title tracker's fold starts clean. */
    let seq = 0;
    let session: string;
    let reader: ReadAloudReader;
    let said: string[];

    async function settle(): Promise<void> {
        for (let i = 0; i < 20; i++) await Promise.resolve();
    }

    /**
     * A press, through the REAL table.
     *
     * The two lines under the switch are backgroundAudio.ts's verbatim, which
     * is what makes the pause this file takes the same pause the lock screen,
     * the headphones and the in-app hold take. A gesture that lands on any
     * other effect is a test that has stopped describing the product, so it
     * throws rather than quietly doing nothing.
     */
    function press(gesture: TransportGesture): void {
        const effect = transportEffect(gesture, readAloudTransport(reader.isEnabled, reader.isPaused));
        if (effect === 'pause') reader.setPaused(true);
        else if (effect === 'resume') reader.setPaused(false);
        else throw new Error(`expected a pause or a resume, got ${effect}`);
    }

    /** The service's own clock, run forward. Every cue below comes off it. */
    function run(ms: number): void {
        vi.advanceTimersByTime(ms);
    }

    /** Gates the way the store holds them, which is what `gatesForSession` reads. */
    let requests: Record<string, unknown> = {};
    function raiseGate(requestId: string): void {
        requests = { ...requests, [requestId]: { tool: 'AskUserQuestion', arguments: {} } };
        fake.state.sessions = { [session]: { thinking: true, agentState: { requests } } };
    }

    beforeEach(() => {
        clock += 3_600_000;
        vi.useFakeTimers();
        vi.setSystemTime(clock);
        seq += 1;
        session = `s${seq}`;
        fake.played = [];
        said = [];
        // Titles off so the only thing under test is the CUE. A spoken title
        // is speech, and speech is already allowed to hold a cue back
        // (DROVE-174) — leaving it on would let the right assertion pass for
        // the wrong reason.
        fake.state.settings = { audioCues: { speakTitles: false, speakGates: false } };
        requests = {};
        fake.state.sessions = { [session]: { thinking: true } };
        reader = new ReadAloudReader(
            createCuedSpeechEngine(
                {
                    speak: (text: string) => { said.push(text); return Promise.resolve(); },
                    stop: () => {},
                },
                audioCues,
            ),
            {
                skipMarker: '',
                onSkip: () => audioCues.skipped(),
                asideFor: (message, sessionId) => audioCues.titleFor(message, sessionId),
            },
        );
        reader.setEnabled(true);
        reader.focus(session);
        audioCues.attach(reader);
    });

    afterEach(() => {
        audioCues.stop();
        vi.useRealTimers();
    });

    /**
     * The negative below is worth nothing without this. Every cue the paused
     * tests assert the absence of is heard here, on the same harness, one
     * press earlier.
     */
    it('READING: the heartbeat, the tool tick, the agent and the reply are all heard', async () => {
        run(3_000);
        expect(fake.played.some((id) => id.startsWith('working'))).toBe(true);

        fake.played = [];
        reader.onMessages(session, [toolCall('t1'), agentSpawn('a1'), prose('p1', 'Done.')]);
        await settle();
        run(1_000);
        expect(fake.played).toContain('toolCall');
        expect(fake.played).toContain('agentStart');
        expect(fake.played).toContain('reply');
    });

    it('PAUSED: the heartbeat stops', () => {
        press('long-press');
        expect(readAloudTransport(reader.isEnabled, reader.isPaused)).toBe('paused');
        fake.played = [];
        run(10_000);
        expect(fake.played).toEqual([]);
    });

    it('PAUSED: a session event plays no tick, no agent cue and no reply cue', async () => {
        press('long-press');
        fake.played = [];
        reader.onMessages(session, [toolCall('t1'), agentSpawn('a1'), prose('p1', 'Done.')]);
        await settle();
        run(10_000);
        expect(fake.played).toEqual([]);
        // Still a pause and not a drop: the reply is owed, and DROVE-233 says
        // so. Only the SOUND was dropped.
        expect(said).toEqual([]);
    });

    it('PAUSED: a gate plays no waiting pulse, the one already up or a new one', () => {
        // Heard first, because a gate that never reached the mixer would make
        // every assertion below pass on its own.
        raiseGate('r1');
        run(3_000);
        expect(fake.played.some((id) => id.startsWith('waiting'))).toBe(true);

        press('long-press');
        fake.played = [];
        // The pulse for the gate that was already sounding, and a second gate
        // raised INSIDE the pause: neither is heard.
        raiseGate('r2');
        run(10_000);
        expect(fake.played).toEqual([]);
    });

    it('RESUMED: the cues come back, and the ones dropped during the pause do not', async () => {
        press('long-press');
        reader.onMessages(session, [toolCall('t1'), toolCall('t2'), toolCall('t3'), agentSpawn('a1')]);
        await settle();
        run(1_000);
        expect(fake.played).toEqual([]);

        press('tap');
        expect(readAloudTransport(reader.isEnabled, reader.isPaused)).toBe('reading');
        // Deliberately inside `cueStaleMs` of the burst above: if those cues
        // were still queued they would play here, and staleness would not have
        // had time to cover for a missing drop.
        run(500);
        expect(fake.played).not.toContain('toolCall');
        expect(fake.played).not.toContain('agentStart');

        // And the channel is genuinely open again, which is the other half of
        // the same claim: a resume that stayed silent would pass every
        // assertion above.
        run(3_000);
        expect(fake.played.some((id) => id.startsWith('working'))).toBe(true);
        fake.played = [];
        reader.onMessages(session, [toolCall('t4')]);
        await settle();
        run(1_000);
        expect(fake.played).toContain('toolCall');
    });

    it('RESUMED: a gate raised during the pause pulses again once he is listening', () => {
        press('long-press');
        raiseGate('r1');
        run(10_000);
        expect(fake.played).toEqual([]);

        press('tap');
        run(3_000);
        expect(fake.played.some((id) => id.startsWith('waiting'))).toBe(true);
    });

    /**
     * THE ONE EXCEPTION, and it is structural rather than a list: a press
     * answer goes through `ack`, which has never touched the mixer. It is an
     * answer to something he just did with his hands, not news about the
     * agent, and a press with no sound is indistinguishable from a press that
     * did nothing (DROVE-225).
     */
    it('PAUSED: the press answers still play', () => {
        press('long-press');
        fake.played = [];
        audioCues.ack('micOpen');
        audioCues.ack('micClosed');
        audioCues.ack('sessionSkipped');
        audioCues.ack('skipRefused');
        expect(fake.played).toEqual(['micOpen', 'micClosed', 'sessionSkipped', 'skipRefused']);
    });
});
