import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockLocalLauncher, mockRemoteLauncher } = vi.hoisted(() => ({
    mockLocalLauncher: vi.fn(),
    mockRemoteLauncher: vi.fn(),
}));

vi.mock('./claudeLocalLauncher', () => ({
    claudeLocalLauncher: mockLocalLauncher,
}));

vi.mock('./claudeRemoteLauncher', () => ({
    claudeRemoteLauncher: mockRemoteLauncher,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        logFilePath: '/tmp/happy-loop-test.log',
    },
}));

import { MessageQueue2 } from '@/utils/MessageQueue2';
import { loop } from './loop';
import type { Session } from './session';

/**
 * The heartbeat, as the server would see it. `session-alive` is volatile and
 * the mode key is the whole point of DROVE-8, so the harness records every
 * keepAlive in order instead of just the last one.
 */
function harness(startingMode?: 'local' | 'remote') {
    const keepAlive = vi.fn<(thinking: boolean, mode: 'local' | 'remote') => void>();
    const onModeChange = vi.fn<(mode: 'local' | 'remote') => void>();
    let session: Session | null = null;
    const run = loop({
        path: '/tmp/project',
        startingMode,
        onModeChange,
        mcpServers: {},
        session: { keepAlive, updateMetadata: vi.fn() } as any,
        api: {} as any,
        messageQueue: new MessageQueue2<any>(() => 'x'),
        onSessionReady: (s) => { session = s; },
        hookSettingsPath: '/tmp/happy-hook-settings.json',
    });
    return {
        run,
        keepAlive,
        onModeChange,
        session: () => session!,
        modes: () => keepAlive.mock.calls.map(([, mode]) => mode),
    };
}

describe('loop keeps Session.mode and the session-alive heartbeat in step with the launcher it is running (DROVE-8)', () => {
    let cleanup: (() => void) | null = null;

    afterEach(() => {
        cleanup?.();
        cleanup = null;
        mockLocalLauncher.mockReset();
        mockRemoteLauncher.mockReset();
    });

    it('after a local-to-remote switch the very next heartbeat carries remote, and back again', async () => {
        // local -> switch -> remote -> switch -> local -> exit. Each launcher
        // reads the field the moment it is handed the session, which is the
        // earliest anything downstream of loop could observe it.
        const seen: Array<'local' | 'remote'> = [];
        mockLocalLauncher
            .mockImplementationOnce(async (s: Session) => { seen.push(s.mode); return { type: 'switch' }; })
            .mockImplementationOnce(async (s: Session) => { seen.push(s.mode); return { type: 'exit', code: 0 }; });
        mockRemoteLauncher.mockImplementationOnce(async (s: Session) => { seen.push(s.mode); return 'switch'; });

        const h = harness();
        cleanup = () => h.session().cleanup();
        const code = await h.run;

        expect(code).toBe(0);
        expect(seen).toEqual(['local', 'remote', 'local']);
        expect(h.session().mode).toBe('local');
        // Constructor heartbeat, then one per switch, no polling in between
        // (the 2s interval never fires inside this test).
        expect(h.modes()).toEqual(['local', 'remote', 'local']);
    });

    it('still tells runClaude about each switch exactly once, so controlledByUser is untouched', async () => {
        // The app's local/remote indicator rides agentState.controlledByUser,
        // set from this callback in runClaude. Routing through
        // Session.onModeChange must not double it or drop it.
        mockLocalLauncher
            .mockResolvedValueOnce({ type: 'switch' })
            .mockResolvedValueOnce({ type: 'exit', code: 3 });
        mockRemoteLauncher.mockResolvedValueOnce('switch');

        const h = harness();
        cleanup = () => h.session().cleanup();
        const code = await h.run;

        expect(code).toBe(3);
        expect(h.onModeChange.mock.calls).toEqual([['remote'], ['local']]);
    });

    it('a session that starts remote says so from its first heartbeat', async () => {
        // No daemon path starts a session remote any more: spawn (DROVE-2)
        // and resume (DROVE-76) both open a tmux window in local mode. A
        // remote start is still reachable by hand, `--happy-starting-mode
        // remote` typed into a terminal, and such a session never passes
        // through a switch, so the initial value is the only value it will
        // ever report.
        mockRemoteLauncher.mockResolvedValueOnce('exit');

        const h = harness('remote');
        cleanup = () => h.session().cleanup();
        await h.run;

        expect(h.session().mode).toBe('remote');
        expect(h.modes()).toEqual(['remote']);
        expect(h.onModeChange).not.toHaveBeenCalled();
    });

    it('a pane session that never switches reports local for its whole life', async () => {
        // The DROVE-1 case: the terminal is the session. No switch, no
        // callback, and 'local' is the true answer, not a stale default.
        mockLocalLauncher.mockResolvedValueOnce({ type: 'exit', code: 0 });

        const h = harness('local');
        cleanup = () => h.session().cleanup();
        await h.run;

        expect(h.session().mode).toBe('local');
        expect(h.modes()).toEqual(['local']);
        expect(h.onModeChange).not.toHaveBeenCalled();
    });
});
