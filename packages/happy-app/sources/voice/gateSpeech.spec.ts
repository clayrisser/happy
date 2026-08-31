import { beforeEach, describe, expect, it } from 'vitest';
import { GateSpeechTracker, gateReminderAfterMs, gateSpeechLine } from './gateSpeech';
import { ReadAloudReader, type SpeakOptions } from './readAloud';
import type { DroverGateEntry } from '@/sync/droverGates';
import type { Message } from '@/sync/typesMessage';

/**
 * A gate waiting on Clay is READ ALOUD (DROVE-188).
 *
 * His screenshot: a permission card sitting unanswered — "1 permission
 * waiting / Run Bash / cd .../wt-drove173 && git diff > ..." — with eight
 * agents running and nothing but a heartbeat pattern to say a decision was
 * due. A cue says something happened; only speech says WHAT.
 */

function gate(patch: Partial<DroverGateEntry['gate']> & { id: string }, origin?: unknown): DroverGateEntry {
    return {
        gate: {
            title: 'Run Bash',
            reason: '',
            preview: 'git diff',
            kind: 'permission',
            createdAt: new Date().toISOString(),
            ...patch,
        },
        sessionId: 's1',
        requestId: patch.id,
        tool: 'Bash',
        args: {},
        todo: false,
        ...(origin === undefined ? {} : { origin: origin as never }),
    } as unknown as DroverGateEntry;
}

describe('what a gate says', () => {
    it('names the kind, the substance and the session', () => {
        const line = gateSpeechLine(
            gate({ id: 'g1' }, { name: 'DROVE-173 lane' }),
            'DROVE-173 lane',
        );
        expect(line).toBe('Permission to Run Bash, git diff, in DROVE-173 lane.');
    });

    it('cuts a long path at a word rather than reading it out', () => {
        // The failure mode the ticket names: a 200-character path spoken in
        // full is unusable, and there is nothing intelligent to say about the
        // tail of a path, so it is truncated rather than invented.
        const long = gate({
            id: 'g2',
            preview: 'cd /Users/clayrisser/Projects/bitspur/happy-worktrees/wt-drove173 && git diff > /tmp/out.diff',
        });
        const line = gateSpeechLine(long, null);
        expect(line.length).toBeLessThan(100);
        expect(line).toContain('and more');
        expect(line).not.toContain('/tmp/out.diff');
    });

    it('reads a question as a question and a to-do as a job', () => {
        expect(gateSpeechLine(gate({ id: 'q', kind: 'question', preview: 'Ship it now?' }), null))
            .toBe('Question: Ship it now?.');
        expect(gateSpeechLine(gate({ id: 't', kind: 'todo', preview: 'log in to the box' }), null))
            .toBe('Needs you: log in to the box.');
    });

    it('mentions the options only when there is a real choice', () => {
        const two = gate({ id: 'a', kind: 'question', preview: 'Go?', options: [{ label: 'Yes' }, { label: 'No' }] });
        expect(gateSpeechLine(two, null)).not.toContain('options');
        const three = gate({
            id: 'b',
            kind: 'question',
            preview: 'Which lane?',
            options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
        });
        expect(gateSpeechLine(three, null)).toContain('3 options');
    });

    it('says nothing about a session it can only name by uuid', () => {
        const line = gateSpeechLine(gate({ id: 'g3' }), null);
        expect(line).toBe('Permission to Run Bash, git diff.');
    });
});

describe('GateSpeechTracker', () => {
    let tracker: GateSpeechTracker;
    let now = 0;

    beforeEach(() => {
        tracker = new GateSpeechTracker();
        now = 1_000_000;
    });

    it('says a gate once, not on a loop', () => {
        const one = [gate({ id: 'g1' })];
        expect(tracker.observe(one, now).say).toHaveLength(1);
        now += 5_000;
        expect(tracker.observe(one, now).say).toEqual([]);
        now += 5_000;
        expect(tracker.observe(one, now).say).toEqual([]);
    });

    it('gives one reminder after a minute, and then never again', () => {
        // Written down because the ticket asks for the reason: a gate going
        // unheard is the failure this exists to stop, and a loop is the
        // failure that makes him switch the voice off, which loses every gate
        // after it. One repeat covers a first line missed under a mic press.
        const one = [gate({ id: 'g1' })];
        tracker.observe(one, now);
        now += gateReminderAfterMs - 1;
        expect(tracker.observe(one, now).say).toEqual([]);
        now += 2;
        const reminder = tracker.observe(one, now).say;
        expect(reminder).toHaveLength(1);
        expect(reminder[0].text).toContain('Still waiting');
        now += gateReminderAfterMs * 10;
        expect(tracker.observe(one, now).say).toEqual([]);
    });

    it('reports a gate that has stopped being pending, so its speech can be cancelled', () => {
        tracker.observe([gate({ id: 'g1' })], now);
        const after = tracker.observe([], now + 100);
        expect(after.gone).toEqual(['g1']);
        expect(after.say).toEqual([]);
    });

    it('says both when two gates arrive together, in the order they came', () => {
        const both = tracker.observe([gate({ id: 'g1' }), gate({ id: 'g2', kind: 'question' })], now).say;
        expect(both.map((line) => line.key)).toEqual(['g1', 'g2']);
    });
});

describe('a gate in the reader', () => {
    let said: string[] = [];
    let reader: ReadAloudReader;
    let inFlight: (() => void)[] = [];

    function prose(id: string, text: string): Message {
        return { id, localId: null, createdAt: 1, kind: 'agent-text', text } as unknown as Message;
    }

    async function settle(): Promise<void> {
        for (let i = 0; i < 20; i++) await Promise.resolve();
    }

    beforeEach(() => {
        said = [];
        inFlight = [];
        reader = new ReadAloudReader({
            speak(text: string, _options?: SpeakOptions) {
                said.push(text);
                return new Promise<void>((resolve) => { inFlight.push(() => resolve()); });
            },
            stop() { },
        });
        reader.setEnabled(true);
        reader.focus('s1');
    });

    it('finishes the sentence in flight, then says the gate ahead of the rest', async () => {
        reader.onMessages('s1', [prose('m1', 'One. Two. Three.')]);
        await settle();
        expect(said).toEqual(['One.']);

        reader.sayUrgent('g1', 'Permission to run a git diff.');
        // Nothing is cut: the sentence at the synthesiser is untouched.
        expect(said).toEqual(['One.']);

        inFlight.shift()?.();
        await settle();
        expect(said).toEqual(['One.', 'Permission to run a git diff.']);

        inFlight.shift()?.();
        await settle();
        expect(said).toEqual(['One.', 'Permission to run a git diff.', 'Two.']);
    });

    it('un-says a gate answered before its line was reached', async () => {
        reader.onMessages('s1', [prose('m1', 'One. Two.')]);
        await settle();
        reader.sayUrgent('g1', 'Permission to run a git diff.');
        expect(reader.urgentPending).toBe(1);
        reader.cancelUrgent('g1');
        expect(reader.urgentPending).toBe(0);
        inFlight.shift()?.();
        await settle();
        expect(said).toEqual(['One.', 'Two.']);
    });

    it('waits while the mic holds the route, and says it when the mic lets go', async () => {
        reader.setMicHeld(true);
        reader.sayUrgent('g1', 'A question is waiting.');
        await settle();
        expect(said).toEqual([]);
        reader.setMicHeld(false);
        await settle();
        expect(said).toEqual(['A question is waiting.']);
    });

    it('says nothing with read-aloud off', async () => {
        reader.setEnabled(false);
        reader.sayUrgent('g1', 'A question is waiting.');
        await settle();
        expect(said).toEqual([]);
        expect(reader.urgentPending).toBe(0);
    });

    it('says two gates in turn, each once', async () => {
        reader.sayUrgent('g1', 'First.');
        reader.sayUrgent('g2', 'Second.');
        await settle();
        expect(said).toEqual(['First.']);
        inFlight.shift()?.();
        await settle();
        expect(said).toEqual(['First.', 'Second.']);
    });
});

/**
 * The prompt that used to make no sound at all (DROVE-198).
 *
 * Claude Code's own approval dialog reached the bus as `kind: "idle"` and
 * nothing else — no options, no command, and `speakable()` skips idle on
 * purpose, so the audio layer was as silent as the phone and the wrist. The
 * dialog is published as a real question now, and this is what Clay hears.
 */
describe('a terminal approval is announced, options and all', () => {
    /** The card the drover bridge builds from the four option Bash approval. */
    function terminalApproval(): DroverGateEntry {
        return {
            ...gate({
                id: 'ta',
                kind: 'question',
                title: 'Bash command',
                preview: 'tmux capture-pane -p -t %1 | grep -v "^$" | tail -10 This command requires approval Do you want to proceed?',
                options: [
                    { label: 'Yes' },
                    { label: "Yes, and don't ask again for tmux capture-pane commands in /Users/clayrisser/Projects/bitspur/cattle-drover" },
                    { label: 'Yes, and switch to auto mode · auto mode handles these prompts for you' },
                    { label: 'No' },
                ],
            }, { name: 'cattle-drover' }),
            tool: 'AskUserQuestion',
        } as unknown as DroverGateEntry;
    }

    it('is spoken at all, which the idle event it used to be never was', () => {
        const tracker = new GateSpeechTracker();
        const { say } = tracker.observe([terminalApproval()], 0);
        expect(say).toHaveLength(1);
        expect(say[0].text).toContain('tmux capture-pane');
    });

    it('says how many choices there are, because four is not allow and deny', () => {
        // The whole of the ticket in one assertion: a Yes/No card would have
        // discarded "don't ask again" and "switch to auto mode", and a voice
        // line that said nothing about them would hide the same loss.
        expect(gateSpeechLine(terminalApproval(), 'cattle-drover')).toContain('4 options');
    });

    it('names the session, because several are blocked at once', () => {
        expect(gateSpeechLine(terminalApproval(), 'cattle-drover')).toContain('in cattle-drover');
    });
});
