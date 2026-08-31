import { afterEach, describe, expect, it, vi } from 'vitest';

// droverGates reads the store only for a default argument; this module never
// passes one, so the whole demo loads with the one mock.
vi.mock('./storage', () => ({
    storage: { getState: () => ({ sessions: {} }) },
}));

import {
    DEMO_ID_PREFIX,
    DEMO_SESSION_ID,
    demoInboxEntries,
    demoSampleReply,
    demoTranscriptCards,
    describeDemoInput,
    isDroverDemoId,
    recordDemoAnswer,
    setDemoAnswerSink,
    spokenQuestion,
} from './droverDemo';
import { splitInbox } from './droverGates';
import { splitIntoSentences, stripToSpeakableProse } from '@/voice/speakable';

afterEach(() => {
    setDemoAnswerSink(null);
    vi.restoreAllMocks();
});

describe('the demo namespace', () => {
    it('is one prefix, and the demo session is in it', () => {
        expect(isDroverDemoId(DEMO_SESSION_ID)).toBe(true);
        expect(DEMO_SESSION_ID.startsWith(DEMO_ID_PREFIX)).toBe(true);
    });

    it('does not claim a real id that merely contains the word', () => {
        // A session id is a uuid and a request id is a bus id or a tool_use
        // id; none of them start with the prefix, and "demo" inside one must
        // not be enough to turn a real answer aside.
        expect(isDroverDemoId('7f0c3a2e-demo-4b1d')).toBe(false);
        expect(isDroverDemoId('toolu_01demo')).toBe(false);
        expect(isDroverDemoId(null)).toBe(false);
        expect(isDroverDemoId(undefined)).toBe(false);
        expect(isDroverDemoId('')).toBe(false);
    });

    it('covers every fixture id, transcript and inbox alike', () => {
        // The wall in ops.ts keys on this. A fixture outside the namespace is
        // a card whose button would reach a real RPC.
        for (const card of demoTranscriptCards()) {
            expect(isDroverDemoId(card.id)).toBe(true);
            expect(card.tool.permission?.id).toBe(card.id);
            expect(card.tool.permission?.status).toBe('pending');
        }
        for (const entry of demoInboxEntries()) {
            expect(isDroverDemoId(entry.sessionId)).toBe(true);
            expect(isDroverDemoId(entry.requestId)).toBe(true);
            expect(isDroverDemoId(entry.gate.id)).toBe(true);
        }
    });
});

describe('the sink', () => {
    it('logs every answer as a demo, whether or not anyone is listening', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        recordDemoAnswer({ sessionId: DEMO_SESSION_ID, requestId: 'demo:permission', verdict: 'allow' });
        expect(log).toHaveBeenCalledTimes(1);
        const line = String(log.mock.calls[0][0]);
        expect(line.startsWith('[drover-demo] ')).toBe(true);
        expect(line).toContain('demo:permission');
        expect(line).toContain('nothing sent');
    });

    it('hands the answer to the registered sink and stops when it is cleared', () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const seen: string[] = [];
        setDemoAnswerSink((answer) => seen.push(`${answer.requestId}:${answer.verdict}:${answer.detail ?? ''}`));
        recordDemoAnswer({ sessionId: DEMO_SESSION_ID, requestId: 'demo:question', verdict: 'answer', detail: 'main' });
        setDemoAnswerSink(null);
        recordDemoAnswer({ sessionId: DEMO_SESSION_ID, requestId: 'demo:todo', verdict: 'allow' });
        expect(seen).toEqual(['demo:question:answer:main']);
    });

    it('describes an input the way the bridge would read it', () => {
        // The same keys happy-cli's answerCandidates reads, in the same order
        // of preference, so the log says what the bridge would have seen.
        expect(describeDemoInput({ code: 'abc#state' })).toBe('code 9 chars');
        expect(describeDemoInput({ optionIds: ['a', 'c'], optionId: 'a' })).toBe('a, c');
        expect(describeDemoInput({ optionId: 'done' })).toBe('done');
        expect(describeDemoInput({ answers: { 'Which?': 'main' } })).toBe('main');
        expect(describeDemoInput({ answers: { 'Which?': ['a', 'b'] } })).toBe('a, b');
        expect(describeDemoInput(undefined)).toBeUndefined();
        expect(describeDemoInput({})).toBeUndefined();
    });
});

describe('the fixtures', () => {
    it('carry one transcript card per shape the ticket names', () => {
        const cards = demoTranscriptCards();
        expect(cards.map((c) => c.tool.name)).toEqual([
            'Bash',
            'AskUserQuestion',
            'AskUserQuestion',
            'AskUserQuestion',
            'DroverTodo',
            'DroverAccountLogin',
        ]);
        const questions = cards
            .filter((c) => c.tool.name === 'AskUserQuestion')
            .map((c) => c.tool.input.questions[0]);
        // Options, freeform, multi: the three ways a question renders.
        expect(questions[0].options.length).toBeGreaterThan(1);
        expect(questions[0].multiSelect).toBe(false);
        expect(questions[1].options).toEqual([]);
        expect(questions[2].multiSelect).toBe(true);
    });

    it('stamps the cards at call time, so a card is not born hours old', () => {
        const now = 1_700_000_000_000;
        for (const card of demoTranscriptCards(now)) {
            expect(card.tool.createdAt).toBe(now);
            expect(card.tool.permission?.date).toBe(now);
        }
    });

    it('gives the login card an https url the account-login reader accepts', () => {
        const login = demoTranscriptCards().find((c) => c.tool.name === 'DroverAccountLogin');
        expect(String(login?.tool.input.url).startsWith('https://')).toBe(true);
    });

    it('builds inbox entries the inbox splits the way it splits real ones', () => {
        const { prompts, todos } = splitInbox(demoInboxEntries());
        expect(prompts.map((e) => e.gate.kind)).toEqual(['question', 'permission']);
        expect(todos.map((e) => e.gate.kind)).toEqual(['todo']);
        // Oldest first within each half, which is how the real list orders.
        expect(Date.parse(prompts[0].gate.createdAt)).toBeLessThan(Date.parse(prompts[1].gate.createdAt));
    });

    it('reads inbox titles and previews through the same helpers the feed uses', () => {
        const byId = Object.fromEntries(demoInboxEntries().map((e) => [e.requestId, e]));
        expect(byId['demo:inbox-question'].gate.title).toBe('Branch');
        expect(byId['demo:inbox-question'].gate.preview).toBe('Which branch should this land on?');
        expect(byId['demo:inbox-question'].gate.options?.map((o) => o.label)).toEqual(['main', 'develop', 'lane/BASED-113']);
        expect(byId['demo:inbox-todo'].gate.title).toBe('Push the release');
        expect(byId['demo:inbox-todo'].gate.options?.map((o) => o.id)).toEqual(['done', 'drop']);
        expect(byId['demo:inbox-permission'].gate.title).toBe('Run Bash');
        expect(byId['demo:inbox-permission'].gate.preview).toBe('rm -rf build && git clean -fdx');
    });
});

describe('the spoken question', () => {
    it('numbers the options so a click or a word can name one', () => {
        const text = spokenQuestion({
            header: 'Branch',
            question: 'Which branch?',
            options: [{ label: 'main', description: 'the default' }, { label: 'develop' }],
        });
        expect(text).toBe('Question, Branch. Which branch? 2 options. 1. main, the default. 2. develop.');
    });

    it('says so when there is nothing to pick from', () => {
        expect(spokenQuestion({ question: 'What is it called?', options: [] }))
            .toBe('Question. What is it called? No options. Say your answer.');
    });
});

describe('the sample reply', () => {
    it('loses its code block and keeps its bullets through the DROVE-30 stripper', () => {
        const spoken = splitIntoSentences(stripToSpeakableProse(demoSampleReply));
        expect(spoken.join(' ')).not.toContain('git push origin');
        expect(spoken.join(' ')).toContain('212 tests');
        expect(spoken.length).toBeGreaterThan(2);
    });
});
