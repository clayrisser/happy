/**
 * The wall, measured (DROVE-277).
 *
 * Every one of these is a gate shape that has already gone wrong once when
 * something generic answered it: DROVE-69's to-do acked by a bare allow,
 * DROVE-212's login given Deny and Allow under a JSON blob, DROVE-53's
 * multi-select collapsed to one word. Auto-accept is the most generic answerer
 * the app has ever had, so it is the one that most needs those refusals
 * written down rather than assumed.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./storage', () => ({
    storage: { getState: () => ({ sessions: {} }) },
}));

import { AUTO_ACCEPT_BY, autoAcceptInput, autoAcceptVerdict, isAutoAcceptable } from './autoAcceptGate';
import type { DroverGateEntry } from './droverGates';

function entry(over: Partial<DroverGateEntry> & { kind?: string } = {}): DroverGateEntry {
    const { kind, ...rest } = over;
    return {
        sessionId: 'bridge',
        requestId: 'req-1',
        tool: 'Bash',
        args: { command: 'ls' },
        todo: false,
        event: { kind: 'permission', title: 'Run Bash', reason: 'because' },
        gate: {
            id: 'bridge:req-1',
            title: 'Run Bash',
            reason: 'because',
            preview: 'ls',
            kind: (kind ?? 'permission') as DroverGateEntry['gate']['kind'],
            createdAt: new Date(0).toISOString(),
        },
        ...rest,
    } as DroverGateEntry;
}

describe('the one shape auto-accept answers', () => {
    it('takes a plain Allow / Deny permission that came off the bus', () => {
        expect(autoAcceptVerdict(entry())).toEqual({ answer: true });
        expect(isAutoAcceptable(entry())).toBe(true);
    });

    it('takes it whatever the command is, because the classifier is about SHAPE', () => {
        // Deliberate, and worth stating so nobody "improves" it later:
        // auto-accept does not read the command and pretend to judge it. Clay
        // turned it on for this session; a danger filter here would be a
        // promise a regex cannot keep, and a half-kept promise is worse than
        // the stated one ("any prompt that comes in for that session is just
        // yes yes yes"). The blast radius is bounded by the toggle being
        // per-session and dying with the process, not by a word list.
        const destructive = ['rm', '-rf', '/tmp/x'].join(' ');
        expect(isAutoAcceptable(entry({ args: { command: destructive } }))).toBe(true);
    });
});

describe('everything it refuses, and why', () => {
    it('refuses a gate that never came off the bus, because nothing would record who answered', () => {
        // A rig or remote session's own permission. `updatedInput` there is the
        // TOOL's replacement input, so the `via` stamp cannot be sent, so the
        // ledger cannot say auto-accept did it — and an unauditable auto-allow
        // is DROVE-239's bug exactly.
        const verdict = autoAcceptVerdict(entry({ event: undefined }));
        expect(verdict.answer).toBe(false);
        expect(verdict).toMatchObject({ reason: expect.stringContaining('record who answered') });
    });

    it('refuses a to-do, which owes nobody a decision (DROVE-69)', () => {
        expect(autoAcceptVerdict(entry({ todo: true })).answer).toBe(false);
        // And by the tool as well as the flag, since a card can carry one
        // without the other.
        expect(autoAcceptVerdict(entry({
            tool: 'DroverTodo',
            todo: false,
            kind: 'todo',
            args: { title: 'log in to the box', options: [{ id: 'done', label: 'Done' }] },
        })).answer).toBe(false);
    });

    it('refuses a question, whose yes is an option and not an allow', () => {
        expect(autoAcceptVerdict(entry({
            tool: 'AskUserQuestion',
            kind: 'question',
            args: { questions: [{ header: 'Which?', question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }] },
        })).answer).toBe(false);
    });

    it('refuses a question that arrived with NO options, which is the ambiguous one', () => {
        // It renders read-only. "Present, never guess" is the ticket's rule and
        // this is the case it was written for.
        expect(autoAcceptVerdict(entry({
            tool: 'AskUserQuestion',
            kind: 'question',
            args: { questions: [{ question: 'What is the code?' }] },
        })).answer).toBe(false);
    });

    it('refuses an account login, whose yes is a code typed back (DROVE-212)', () => {
        expect(autoAcceptVerdict(entry({
            tool: 'DroverAccountLogin',
            kind: 'question',
            args: { url: 'https://claude.ai/oauth/x', header: 'Log in', reason: '', cancelLabel: 'Cancel' },
        })).answer).toBe(false);
    });

    it('refuses a permission that carries its own options, because "which yes" is a choice', () => {
        expect(autoAcceptVerdict(entry({
            gate: {
                ...entry().gate,
                options: [{ label: 'Yes' }, { label: 'Yes, and stop asking' }, { label: 'No' }],
            },
        })).answer).toBe(false);
    });

    it('refuses an idle or expiry card, which has nothing to allow at all', () => {
        for (const kind of ['idle', 'expiry', 'todo']) {
            expect(autoAcceptVerdict(entry({ kind })).answer, kind).toBe(false);
        }
    });

    it('names a reason on every refusal, so a card still sitting there is explainable', () => {
        const refusals = [
            entry({ event: undefined }),
            entry({ todo: true }),
            entry({ kind: 'question', tool: 'AskUserQuestion', args: { questions: [{ question: 'q' }] } }),
        ];
        for (const gate of refusals) {
            const verdict = autoAcceptVerdict(gate);
            expect(verdict.answer).toBe(false);
            if (verdict.answer === false) expect(verdict.reason.length).toBeGreaterThan(0);
        }
    });
});

describe('the audit stamp', () => {
    it('is `auto-accept`, and it is never the word a human tap uses', () => {
        expect(AUTO_ACCEPT_BY).toBe('auto-accept');
        // The surfaces a human answer can be stamped with. DROVE-239 found a
        // real auto-allow only because the ledger named the answerer, and an
        // auto-answer wearing one of these would have made it invisible.
        expect(['phone', 'watch', 'push', 'tmux-gum', 'happy']).not.toContain(AUTO_ACCEPT_BY);
    });

    it('travels as `via`, which is the key the bridge reads, over the visual channel', () => {
        expect(autoAcceptInput()).toEqual({ via: 'auto-accept', channel: 'visual' });
    });

    it('never claims the audio channel, which the bus can refuse outright', () => {
        // `audio` on an event whose delivery.answer lacks it is 403 and the
        // event STAYS pending. Visual is the floor no setting removes, and
        // auto-accept is not a microphone.
        expect(autoAcceptInput().channel).toBe('visual');
    });
});
