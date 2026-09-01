/**
 * DROVE-273 slice 3. The contract under test is the one DROVE-203 wrote after
 * four Destructive-Bash gates resolved `allow` with nobody at the terminal:
 *
 *   before the publish  -> null, meaning "not asked". The bus accelerates, it
 *                          never gates, and a drover that is down must not
 *                          brick a Codex session.
 *   after the publish   -> silence is `denied`, never `approved`.
 *
 * Every failure shape gets its own case, because the bug was never in the happy
 * path — it was in a path nobody had written a test for.
 */

import { describe, expect, it, vi } from 'vitest';

import { codexGateEnabled, openCodexGate, type CodexGateRequest } from './droverGate';

vi.mock('@/ui/logger', () => ({
    logger: { debug: () => { /* quiet */ }, info: () => { }, warn: () => { } },
}));

const req: CodexGateRequest = {
    type: 'exec',
    toolName: 'CodexBash',
    preview: 'rm -rf /tmp/scratch',
    sessionId: 'sess-1',
    cwd: '/tmp/proj',
};

const opts = (fetchImpl: any) => ({
    bus: 'http://bus.test',
    fetchImpl: fetchImpl as typeof fetch,
    env: {} as NodeJS.ProcessEnv,
    timeoutMs: 1000,
});

/** A fetch that publishes fine, then answers the wait with `waitBody`. */
function busThatAnswers(waitBody: unknown, waitOk = true) {
    const calls: string[] = [];
    const impl = vi.fn(async (url: string, init?: any) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        if (url.endsWith('/v1/events')) {
            return { ok: true, status: 201, json: async () => ({ id: 'ev-1' }) } as any;
        }
        if (url.includes('/wait')) {
            return { ok: waitOk, status: waitOk ? 200 : 500, json: async () => waitBody } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
    });
    return { impl, calls };
}

describe('openCodexGate — before the publish, the bus never gates', () => {
    it('returns null when the POST is refused', async () => {
        const impl = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as any);
        const gate = openCodexGate(req, opts(impl));
        await expect(gate.decision).resolves.toBeNull();
    });

    it('returns null when the bus is unreachable', async () => {
        const impl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
        const gate = openCodexGate(req, opts(impl));
        await expect(gate.decision).resolves.toBeNull();
    });

    it('returns null when the bus accepts but hands back no event id', async () => {
        const impl = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({}) }) as any);
        const gate = openCodexGate(req, opts(impl));
        await expect(gate.decision).resolves.toBeNull();
    });
});

describe('openCodexGate — after the publish, silence denies', () => {
    it('approves only on an explicit allow', async () => {
        const { impl } = busThatAnswers({ state: 'resolved', resolution: { action: 'allow', by: 'watch' } });
        await expect(openCodexGate(req, opts(impl)).decision).resolves.toBe('approved');
    });

    it('denies on an explicit deny', async () => {
        const { impl } = busThatAnswers({ state: 'resolved', resolution: { action: 'deny', by: 'watch' } });
        await expect(openCodexGate(req, opts(impl)).decision).resolves.toBe('denied');
    });

    it('denies when the gate expires unanswered', async () => {
        const { impl } = busThatAnswers({ state: 'expired' });
        await expect(openCodexGate(req, opts(impl)).decision).resolves.toBe('denied');
    });

    it('denies when the gate is still pending at the budget', async () => {
        const { impl } = busThatAnswers({ state: 'pending' });
        await expect(openCodexGate(req, opts(impl)).decision).resolves.toBe('denied');
    });

    it('denies when the gate was canceled elsewhere', async () => {
        const { impl } = busThatAnswers({ state: 'canceled' });
        await expect(openCodexGate(req, opts(impl)).decision).resolves.toBe('denied');
    });

    it('denies when the wait itself errors out', async () => {
        const { impl } = busThatAnswers({}, false);
        await expect(openCodexGate(req, opts(impl)).decision).resolves.toBe('denied');
    });

    it('denies when the bus drops mid-wait', async () => {
        const impl = vi.fn(async (url: string) => {
            if (url.endsWith('/v1/events')) {
                return { ok: true, status: 201, json: async () => ({ id: 'ev-1' }) } as any;
            }
            throw new Error('socket hang up');
        });
        await expect(openCodexGate(req, opts(impl)).decision).resolves.toBe('denied');
    });

    // The one that would be easiest to get wrong: resolved, but with nothing
    // readable in it. That is not an approval.
    it('denies when it resolves carrying no usable action', async () => {
        const { impl } = busThatAnswers({ state: 'resolved', resolution: {} });
        await expect(openCodexGate(req, opts(impl)).decision).resolves.toBe('denied');
    });

    it('denies on an action it does not recognise', async () => {
        const { impl } = busThatAnswers({ state: 'resolved', resolution: { action: 'maybe' } });
        await expect(openCodexGate(req, opts(impl)).decision).resolves.toBe('denied');
    });
});

describe('openCodexGate — withdrawal is not a deny', () => {
    it('resolves null when we cancel because another surface answered', async () => {
        let releaseWait: (v: any) => void = () => { };
        const impl = vi.fn(async (url: string) => {
            if (url.endsWith('/v1/events')) {
                return { ok: true, status: 201, json: async () => ({ id: 'ev-1' }) } as any;
            }
            if (url.includes('/wait')) {
                return new Promise((r) => { releaseWait = r; });
            }
            return { ok: true, status: 200, json: async () => ({}) } as any;
        });
        const gate = openCodexGate(req, opts(impl));
        // Let the publish settle so there is an id to cancel.
        await new Promise((r) => setTimeout(r, 5));
        gate.cancel();
        releaseWait({ ok: true, status: 200, json: async () => ({ state: 'canceled' }) });
        await expect(gate.decision).resolves.toBeNull();
    });

    // The deferred case: cancel() fires while the POST is still in flight, so
    // there is no event id yet. The withdrawal must still reach the bus once
    // the id arrives, or the card sits pending on the watch forever.
    it('still withdraws when cancelled before the publish came back', async () => {
        const calls: string[] = [];
        let releasePublish: (v: any) => void = () => { };
        const impl = vi.fn(async (url: string, init?: any) => {
            calls.push(`${init?.method ?? 'GET'} ${url}`);
            if (url.endsWith('/v1/events')) {
                return new Promise((r) => { releasePublish = r; });
            }
            return { ok: true, status: 200, json: async () => ({}) } as any;
        });
        const gate = openCodexGate(req, opts(impl));
        gate.cancel();
        releasePublish({ ok: true, status: 201, json: async () => ({ id: 'ev-9' }) });
        await expect(gate.decision).resolves.toBeNull();
        await new Promise((r) => setTimeout(r, 5));
        expect(calls).toContain('POST http://bus.test/v1/events/ev-9/cancel');
    });

    it('withdraws the card on the bus when it cancels', async () => {
        const { impl, calls } = busThatAnswers({ state: 'resolved', resolution: { action: 'allow' } });
        const gate = openCodexGate(req, opts(impl));
        await new Promise((r) => setTimeout(r, 5));
        gate.cancel();
        await new Promise((r) => setTimeout(r, 5));
        expect(calls.some((c) => c === 'POST http://bus.test/v1/events/ev-1/cancel')).toBe(true);
    });
});

describe('openCodexGate — what it puts on the bus', () => {
    it('publishes a codex-origin permission card the surfaces can render', async () => {
        let body: any = null;
        const impl = vi.fn(async (url: string, init?: any) => {
            if (url.endsWith('/v1/events')) {
                body = JSON.parse(init.body);
                return { ok: true, status: 201, json: async () => ({ id: 'ev-1' }) } as any;
            }
            return { ok: true, status: 200, json: async () => ({ state: 'resolved', resolution: { action: 'allow' } }) } as any;
        });
        await openCodexGate(req, opts(impl)).decision;

        expect(body.kind).toBe('permission');
        // The one field a create is refused without.
        expect(body.origin.harness).toBe('codex');
        expect(body.channel).toBe('hook-wait');
        expect(body.preview).toBe('rm -rf /tmp/scratch');
        expect(body.origin.sessionId).toBe('sess-1');
        expect(body.origin.cwd).toBe('/tmp/proj');
        // PRESENT beats truthy (DROVE-31): the key must be there, saying "no
        // drover-managed account", rather than absent.
        expect('account' in body.origin).toBe(true);
        expect(body.origin.account).toBeNull();
    });

    it('caps a huge preview instead of POSTing the whole patch', async () => {
        let body: any = null;
        const impl = vi.fn(async (url: string, init?: any) => {
            if (url.endsWith('/v1/events')) {
                body = JSON.parse(init.body);
                return { ok: true, status: 201, json: async () => ({ id: 'ev-1' }) } as any;
            }
            return { ok: true, status: 200, json: async () => ({ state: 'resolved', resolution: { action: 'allow' } }) } as any;
        });
        await openCodexGate({ ...req, preview: 'x'.repeat(50_000) }, opts(impl)).decision;
        expect(body.preview.length).toBe(2000);
    });

    it('names the patch and mcp shapes differently from a command', async () => {
        const titles: string[] = [];
        const impl = vi.fn(async (url: string, init?: any) => {
            if (url.endsWith('/v1/events')) {
                titles.push(JSON.parse(init.body).title);
                return { ok: true, status: 201, json: async () => ({ id: 'ev-1' }) } as any;
            }
            return { ok: true, status: 200, json: async () => ({ state: 'resolved', resolution: { action: 'allow' } }) } as any;
        });
        await openCodexGate({ ...req, type: 'patch' }, opts(impl)).decision;
        await openCodexGate({ ...req, type: 'mcp', toolName: 'search' }, opts(impl)).decision;
        expect(titles[0]).toBe('Codex wants to edit files');
        expect(titles[1]).toBe('Codex wants to call search');
    });
});

describe('codexGateEnabled', () => {
    it('is off unless it is explicitly turned on', () => {
        expect(codexGateEnabled({})).toBe(false);
        expect(codexGateEnabled({ DROVER_CODEX_GATE: '0' })).toBe(false);
        expect(codexGateEnabled({ DROVER_CODEX_GATE: 'true' })).toBe(false);
        expect(codexGateEnabled({ DROVER_CODEX_GATE: '1' })).toBe(true);
    });
});
