/**
 * The agent screen surviving a CLI restart and a dead phone network
 * (DROVE-132). The loop is dependency-injected precisely so the whole story —
 * disconnect, retry, reconnect, repaint — is a unit test rather than a device
 * and a stopwatch.
 */
import { describe, expect, it } from 'vitest';

import type { SubagentTranscriptResponse } from './subagentTranscript';
import {
    applyPollFailure,
    applyPollResponse,
    classifySubagentFailure,
    createSubagentPollSnapshot,
    errorDetail,
    pollDelayMs,
    runSubagentTranscriptPoll,
    shouldPollAgain,
    SUBAGENT_POLL_MS,
    SUBAGENT_RETRY_MAX_MS,
    SUBAGENT_RETRY_MIN_MS,
    type SubagentPollSnapshot,
} from './subagentTranscriptPoll';

const iso = (ms: number) => new Date(ms).toISOString();

const promptRow = {
    type: 'user',
    uuid: 'u1',
    parentUuid: null,
    isSidechain: false,
    agentId: 'a1',
    timestamp: iso(1_000),
    message: { role: 'user', content: 'Implement DROVE-132 in the happy fork' },
};

const replyRow = {
    type: 'assistant',
    uuid: 'r1',
    parentUuid: 'u1',
    isSidechain: false,
    agentId: 'a1',
    timestamp: iso(2_000),
    message: {
        role: 'assistant',
        model: 'claude-fable-5',
        content: [{ type: 'text', text: 'Reading the ticket first.' }],
        usage: { input_tokens: 2, output_tokens: 5, cache_creation_input_tokens: 100 },
    },
};

const running = { id: 'a1', label: 'agent', state: 'running' as const, updatedAt: 2_000 };
const done = { id: 'a1', label: 'agent', state: 'done' as const, updatedAt: 2_000, endedAt: 3_000 };

/** What the server hands back when the daemon's socket left mid-call. */
const targetDisconnected = () => new Error('RPC target disconnected');

interface Run {
    snapshots: SubagentPollSnapshot[];
    waits: number[];
    fetches: number[];
    final: SubagentPollSnapshot;
}

/**
 * Drive the loop over a scripted list of answers. `wait` records the delay
 * and returns at once, so a test runs in microseconds and still asserts the
 * ladder the real screen sleeps through.
 */
async function drive(
    answers: (SubagentTranscriptResponse | Error)[],
    options: { online?: boolean | undefined; stopAfter?: number } = {},
): Promise<Run> {
    const snapshots: SubagentPollSnapshot[] = [];
    const waits: number[] = [];
    const fetches: number[] = [];
    let calls = 0;
    let stopped = false;
    const limit = options.stopAfter ?? answers.length;
    const final = await runSubagentTranscriptPoll({
        fetch: async (since) => {
            fetches.push(since);
            const answer = answers[Math.min(calls, answers.length - 1)];
            calls += 1;
            if (answer instanceof Error) throw answer;
            return answer;
        },
        // Every answer is folded in before the driver gives up, so a test
        // that allows one poll asserts on that poll's result.
        wait: async (ms) => {
            waits.push(ms);
            if (calls >= limit) stopped = true;
        },
        isOnline: () => options.online,
        isCancelled: () => stopped,
        onSnapshot: (snapshot) => snapshots.push(snapshot),
    });
    return { snapshots, waits, fetches, final };
}

describe('the retry ladder', () => {
    it('polls at the plain cadence while everything answers', () => {
        expect(pollDelayMs(createSubagentPollSnapshot())).toBe(SUBAGENT_POLL_MS);
    });

    it('doubles up to a ceiling and no further', () => {
        const at = (failures: number) => pollDelayMs({ ...createSubagentPollSnapshot(), failures });
        expect([at(1), at(2), at(3), at(4)]).toEqual([2_000, 4_000, 8_000, 16_000]);
        expect(at(5)).toBe(SUBAGENT_RETRY_MAX_MS);
        expect(at(40)).toBe(SUBAGENT_RETRY_MAX_MS);
        expect(at(1)).toBe(SUBAGENT_RETRY_MIN_MS);
    });

    it('never treats being unreachable as an ending', () => {
        const snapshot = applyPollFailure(createSubagentPollSnapshot(), 'RPC target disconnected', true);
        expect(shouldPollAgain(snapshot)).toBe(true);
    });

    it('stops only because the CLI said the agent settled', () => {
        const ok: SubagentTranscriptResponse = { ok: true, rows: [], cursor: 0, agent: done };
        expect(shouldPollAgain(applyPollResponse(createSubagentPollSnapshot(), ok))).toBe(false);
    });

    it('keeps asking while the agent is still running', () => {
        const ok: SubagentTranscriptResponse = { ok: true, rows: [], cursor: 0, agent: running };
        expect(shouldPollAgain(applyPollResponse(createSubagentPollSnapshot(), ok))).toBe(true);
    });
});

describe('naming what went wrong', () => {
    it('blames the phone when the socket is down', () => {
        expect(classifySubagentFailure(false)).toBe('offline');
    });

    it('blames the computer when the socket is up and the call still failed', () => {
        expect(classifySubagentFailure(true)).toBe('computer');
    });

    it('blames neither end when the socket state is not known', () => {
        expect(classifySubagentFailure(undefined)).toBe('unknown');
    });

    it('keeps the transport sentence out of the way, as detail', () => {
        const snapshot = applyPollFailure(createSubagentPollSnapshot(), 'RPC target disconnected', true);
        expect(snapshot.trouble).toEqual({ cause: 'computer', detail: 'RPC target disconnected' });
    });

    it('always has something to put in detail', () => {
        expect(errorDetail(new Error(''))).toBe('unknown error');
        expect(errorDetail(undefined)).toBe('unknown error');
        expect(errorDetail('boom')).toBe('boom');
    });
});

describe('a CLI restart under an open screen', () => {
    const first: SubagentTranscriptResponse = { ok: true, rows: [promptRow], cursor: 120, agent: running };
    const back: SubagentTranscriptResponse = { ok: true, rows: [replyRow], cursor: 260, agent: done };

    it('retries through the outage and repaints when the CLI is back', async () => {
        const run = await drive([first, targetDisconnected(), targetDisconnected(), back]);
        expect(run.waits).toEqual([SUBAGENT_POLL_MS, 2_000, 4_000]);
        expect(run.final.trouble).toBeNull();
        expect(run.final.agent?.state).toBe('done');
        // Repainted: the row that arrived after the CLI came back is in the
        // list, next to the one read before it went away.
        expect(run.final.transcript.messages).toHaveLength(2);
        expect(run.final.failures).toBe(0);
    });

    it('resumes from the cursor rather than re-reading the file', async () => {
        const run = await drive([first, targetDisconnected(), back]);
        expect(run.fetches).toEqual([0, 120, 120]);
        expect(run.final.transcript.cursor).toBe(260);
    });

    it('holds on to the rows it already drew while the CLI is away', async () => {
        const run = await drive([first, targetDisconnected()], { stopAfter: 2 });
        expect(run.final.transcript.messages).toHaveLength(1);
        expect(run.final.trouble?.cause).toBe('unknown');
    });

    it('keeps the last state the CLI gave it rather than forgetting the agent', async () => {
        const run = await drive([first, targetDisconnected()], { stopAfter: 2, online: true });
        expect(run.final.agent?.state).toBe('running');
    });
});

describe('a phone that loses the network', () => {
    it('recovers through the same loop, and says it is the phone', async () => {
        const ok: SubagentTranscriptResponse = { ok: true, rows: [promptRow], cursor: 120, agent: done };
        const offline = await drive([new Error('Not connected to the server')], { stopAfter: 1, online: false });
        expect(offline.final.trouble?.cause).toBe('offline');
        expect(shouldPollAgain(offline.final)).toBe(true);

        const run = await drive([new Error('Not connected to the server'), ok], { online: false });
        expect(run.final.trouble).toBeNull();
        expect(run.final.transcript.messages).toHaveLength(1);
    });
});

describe('an answer that is a refusal', () => {
    it('stays at the plain cadence while the CLI can still name the agent', async () => {
        const notYet: SubagentTranscriptResponse = { ok: false, reason: 'no transcript yet', cursor: 0, agent: running };
        const ok: SubagentTranscriptResponse = { ok: true, rows: [promptRow], cursor: 120, agent: running };
        const run = await drive([notYet, ok], { stopAfter: 2 });
        expect(run.waits).toEqual([SUBAGENT_POLL_MS, SUBAGENT_POLL_MS]);
        expect(run.final.refusal).toBeNull();
    });

    it('backs off when the CLI cannot name the agent at all, and keeps trying', async () => {
        const unknown: SubagentTranscriptResponse = { ok: false, reason: 'unknown agent', cursor: 0 };
        const run = await drive([unknown], { stopAfter: 3 });
        expect(run.waits.slice(0, 2)).toEqual([2_000, 4_000]);
        expect(run.final.refusal).toBe('unknown agent');
        expect(run.final.trouble).toBeNull();
    });

    it('stops when the refusal carries a settled agent', async () => {
        const gone: SubagentTranscriptResponse = { ok: false, reason: 'transcript deleted', cursor: 0, agent: done };
        const run = await drive([gone], { stopAfter: 5 });
        expect(run.fetches).toHaveLength(1);
        expect(run.final.agent?.state).toBe('done');
    });
});

describe('the loop itself', () => {
    it('reports every snapshot, so the screen repaints as answers land', async () => {
        const first: SubagentTranscriptResponse = { ok: true, rows: [promptRow], cursor: 120, agent: running };
        const second: SubagentTranscriptResponse = { ok: true, rows: [replyRow], cursor: 260, agent: done };
        const run = await drive([first, second]);
        expect(run.snapshots).toHaveLength(2);
        expect(run.snapshots[0].transcript.messages).toHaveLength(1);
        expect(run.snapshots[1].transcript.messages).toHaveLength(2);
    });

    it('marks itself loaded even when the first answer never came', async () => {
        const run = await drive([targetDisconnected()], { stopAfter: 1 });
        expect(run.final.loaded).toBe(true);
    });
});
