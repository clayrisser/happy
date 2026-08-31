import { beforeEach, describe, expect, it } from 'vitest';
import { AudioCueMixer, cueStaleMs } from './audioCueMixer';
import { cueDurationMs, cueSpec } from './audioCues';
import { SpokenTitleTracker } from './spokenTitles';
import { audioCuesDefaults, type AudioCues } from '@/sync/settings';
import type { Message } from '@/sync/typesMessage';

/**
 * Every tool call and every reply has a sound (DROVE-174).
 *
 * Clay: "when in reading mode, every response and tool call should have a
 * sound". DROVE-112 folded the tool earcon to one per RUN and capped it at six
 * a minute with the excess dropped in silence, so a burst of twenty greps made
 * one tick and nineteen silences.
 *
 * What a burst has to sound like, and what it must not: twenty ticks, close
 * enough together to rattle, and NOT twenty ticks trickling out over the ten
 * seconds after the burst is over. The 4-second staleness rule is what holds
 * the second half, and it is the same rule DROVE-112 got right.
 */

function toolCall(id: string, name = 'Bash'): Message {
    return {
        id,
        localId: null,
        createdAt: 1,
        kind: 'tool-call',
        tool: { name, state: 'running', input: {} },
    } as unknown as Message;
}

function agentText(id: string): Message {
    return { id, localId: null, createdAt: 1, kind: 'agent-text', text: 'Done.' } as unknown as Message;
}

describe('a burst of tool calls', () => {
    let now = 0;
    let played: string[] = [];
    let config: Required<AudioCues>;
    let mixer: AudioCueMixer;
    /** The reader has nothing to say, which is the case a burst has to work in. */
    let pending = false;

    beforeEach(() => {
        now = 1_000_000;
        played = [];
        pending = false;
        config = { ...audioCuesDefaults };
        mixer = new AudioCueMixer({
            now: () => now,
            play: (id) => { played.push(id); },
            settings: () => config,
            speechPending: () => pending,
        });
        mixer.setState({ reading: true, working: true, pendingKinds: [], agents: 0 });
    });

    /** The service's fast clock while cues are queued. */
    function drain(ms: number): void {
        for (let elapsed = 0; elapsed < ms; elapsed += 50) {
            now += 50;
            mixer.tick();
        }
    }

    it('sounds every call in a burst of twenty, not one for the run', () => {
        const tracker = new SpokenTitleTracker();
        for (let i = 0; i < 20; i++) {
            expect(tracker.observe(toolCall(`t${i}`), config).events).toEqual(['toolCall']);
        }
    });

    it('rattles the whole burst out inside a second and a half', () => {
        for (let i = 0; i < 20; i++) mixer.event('toolCall');
        // At the burst clock (50ms) and a 28ms tick, twenty land almost
        // back to back. What matters is that they are all out well before the
        // staleness rule would start eating them.
        //
        // The heartbeat is filtered out rather than asserted about: it is the
        // other kind of sound and it keeps its own cadence right through a
        // burst (DROVE-197). This test is about the earcons.
        drain(1_500);
        expect(played.filter((id) => id === 'toolCall'))
            .toEqual(Array.from({ length: 20 }, () => 'toolCall'));
        expect(mixer.dropped).toBe(0);
        expect(cueDurationMs(cueSpec('toolCall'))).toBeLessThan(50);
    });

    it('drops the tail of a burst rather than ticking on after it is over', () => {
        // The failure this rule exists to stop: the burst ends, the phone
        // carries on ticking about calls that finished ten seconds ago.
        pending = true;
        for (let i = 0; i < 20; i++) mixer.event('toolCall');
        drain(cueStaleMs + 500);
        expect(played.filter((id) => id === 'toolCall')).toEqual([]);
        expect(mixer.pending).toBe(0);
        expect(mixer.dropped).toBe(20);
    });

    it('does not cap either lane unless he asks it to', () => {
        // DROVE-112 shipped 6 and 12. Both default to off now, because a cap
        // that silently eats what he asked to hear is the bug (DROVE-174).
        expect(audioCuesDefaults.toolCuesPerMinute).toBe(0);
        expect(audioCuesDefaults.agentCuesPerMinute).toBe(0);
        for (let i = 0; i < 40; i++) mixer.event('toolCall');
        expect(mixer.dropped).toBe(0);
    });

    it('still honours a cap he sets', () => {
        config = { ...config, toolCuesPerMinute: 5 };
        for (let i = 0; i < 20; i++) mixer.event('toolCall');
        expect(mixer.pending).toBe(5);
        expect(mixer.dropped).toBe(15);
    });

    it('gives a reply its own sound, distinct from the agent and tool earcons', () => {
        const tracker = new SpokenTitleTracker();
        expect(tracker.observe(agentText('m1'), config).events).toEqual(['reply']);
        const reply = cueSpec('reply');
        const agent = cueSpec('agentStart');
        const tool = cueSpec('toolCall');
        // Three sounds, three registers: the reply is low, the agent spawn
        // rises bright, the tool tick is high and tiny.
        expect(reply.beats[0].hz).toBeLessThan(agent.beats[0].hz);
        expect(tool.beats[0].hz).toBeGreaterThan(agent.beats[0].hz);
        expect(cueDurationMs(tool)).toBeLessThan(cueDurationMs(reply));
    });

    it('plays the reply cue BEFORE the first sentence, by ordering', () => {
        // The reply cue is decided from inside the reader's message walk,
        // before that message's prose has been enqueued, so nothing has to be
        // held for it. Here that is: the cue is out and the reader still has
        // nothing pending.
        const tracker = new SpokenTitleTracker();
        for (const event of tracker.observe(agentText('m1'), config).events) mixer.event(event);
        mixer.tick();
        expect(played).toEqual(['reply']);
        expect(pending).toBe(false);
    });

    it('is silent with read-aloud off', () => {
        config = { ...config, on: false };
        for (let i = 0; i < 20; i++) mixer.event('toolCall');
        mixer.event('reply');
        drain(2_000);
        expect(played).toEqual([]);
    });
});
