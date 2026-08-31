import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sessionRPC, getState } = vi.hoisted(() => ({
    sessionRPC: vi.fn(),
    getState: vi.fn(),
}));

vi.mock('./apiSocket', () => ({ apiSocket: { sessionRPC } }));
vi.mock('./sync', () => ({ sync: {} }));
vi.mock('./storage', () => ({ storage: { getState } }));

/**
 * The demo wall (DROVE-75): a `demo:` id reaching sessionAllow / sessionDeny
 * must be turned aside into the sink and never become an RPC. This is the
 * whole of "enforced in code rather than by convention", so it is pinned
 * here against the real ops.ts with only the socket stubbed.
 */
describe('the demo wall in ops', () => {
    beforeEach(() => {
        sessionRPC.mockReset();
        sessionRPC.mockResolvedValue(undefined);
        getState.mockReturnValue({ sessions: {} });
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(async () => {
        const { setDemoAnswerSink } = await import('./droverDemo');
        setDemoAnswerSink(null);
        vi.restoreAllMocks();
    });

    it('turns a demo allow into the sink and never calls the socket', async () => {
        const { sessionAllow } = await import('./ops');
        const { setDemoAnswerSink } = await import('./droverDemo');
        const seen: unknown[] = [];
        setDemoAnswerSink((answer) => seen.push(answer));

        await sessionAllow('demo:cattle-drover', 'demo:permission');

        expect(sessionRPC).not.toHaveBeenCalled();
        expect(seen).toEqual([
            { sessionId: 'demo:cattle-drover', requestId: 'demo:permission', verdict: 'allow', detail: undefined },
        ]);
    });

    it('turns a demo answer with an input into the sink with what was picked', async () => {
        const { sessionAllow } = await import('./ops');
        const { setDemoAnswerSink } = await import('./droverDemo');
        const seen: Array<{ verdict: string; detail?: string }> = [];
        setDemoAnswerSink((answer) => seen.push({ verdict: answer.verdict, detail: answer.detail }));

        await sessionAllow('demo:cattle-drover', 'demo:question', undefined, undefined, 'approved', {
            answers: { 'Which branch should this land on?': 'main' },
        });
        await sessionAllow('demo:cattle-drover', 'demo:todo', undefined, undefined, 'approved', { optionId: 'done' });

        expect(sessionRPC).not.toHaveBeenCalled();
        expect(seen).toEqual([
            { verdict: 'answer', detail: 'main' },
            { verdict: 'answer', detail: 'done' },
        ]);
    });

    it('turns a demo deny aside too', async () => {
        const { sessionDeny } = await import('./ops');
        const { setDemoAnswerSink } = await import('./droverDemo');
        const seen: string[] = [];
        setDemoAnswerSink((answer) => seen.push(answer.verdict));

        await sessionDeny('demo:cattle-drover', 'demo:permission');

        expect(sessionRPC).not.toHaveBeenCalled();
        expect(seen).toEqual(['deny']);
    });

    it('refuses on the REQUEST id alone, so a demo card on a real session id is still a demo', async () => {
        const { sessionAllow } = await import('./ops');
        await sessionAllow('7f0c3a2e-1111-4b1d-9c1e-000000000000', 'demo:permission');
        expect(sessionRPC).not.toHaveBeenCalled();
    });

    it('covers the communication channel as well', async () => {
        const { sessionAnswerQuestion, sessionCancelCommunication } = await import('./ops');
        await sessionAnswerQuestion('demo:cattle-drover', 'demo:form', {});
        await sessionCancelCommunication('demo:cattle-drover', 'demo:form');
        expect(sessionRPC).not.toHaveBeenCalled();
    });

    it('leaves a real answer exactly as it was', async () => {
        const { sessionAllow, sessionDeny } = await import('./ops');
        await sessionAllow('real-session', 'toolu_01', undefined, undefined, 'approved', { optionId: 'done' });
        await sessionDeny('real-session', 'toolu_02');
        expect(sessionRPC).toHaveBeenCalledTimes(2);
        expect(sessionRPC).toHaveBeenNthCalledWith(1, 'real-session', 'permission', {
            id: 'toolu_01', approved: true, mode: undefined, allowTools: undefined, decision: 'approved', updatedInput: { optionId: 'done' },
        });
        expect(sessionRPC).toHaveBeenNthCalledWith(2, 'real-session', 'permission', {
            id: 'toolu_02', approved: false, mode: undefined, allowTools: undefined, decision: undefined,
        });
    });

    it('logs the refusal as a demo', async () => {
        const { sessionAllow } = await import('./ops');
        await sessionAllow('demo:cattle-drover', 'demo:permission');
        const lines = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
        expect(lines.some((l) => l.startsWith('[drover-demo] ') && l.includes('nothing sent'))).toBe(true);
    });
});
