/**
 * The wire between a terminal and this phone's voice (DROVE-298).
 *
 * readingControl.spec.ts pins what the phone DECIDES. This pins the delivery:
 * where the command is found, that it is answered exactly once, and that one
 * which arrived after its life was over is never applied — the last being the
 * whole reason the command carries a life at all.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    bridgeSessionIdOf,
    forgetAnsweredReadingCommands,
    handleReadingCommands,
    pendingReadingCommand,
} from './droverReading';
import type { ReadingReporter } from './droverReading';
import type { ReadingCommand, ReadingPolicy } from '@/voice/readingControl';

const bridge = (command: Partial<ReadingCommand> | null) => ({
    'bridge-1': {
        metadata: { droverBridge: true },
        agentState: { droverReading: command ? { command: { id: 'rd-1', verb: 'pause', at: 1_000, ttlMs: 8_000, ...command } } : null },
    },
    'session-1': { metadata: { summary: { text: 'a real conversation' } }, agentState: { requests: {} } },
});

const policy: ReadingPolicy = {
    report: () => ({ session: 'A', state: 'reading', sentence: 'The lane is green.', defaultEnabled: true }),
    knows: () => true,
    isEnabled: () => true,
    setEnabled: vi.fn(),
    setPaused: vi.fn(),
    rows: () => [],
    titleOf: () => 'A',
};

beforeEach(() => {
    forgetAnsweredReadingCommands();
    vi.clearAllMocks();
});

describe('finding the command', () => {
    it('reads it off the BRIDGE session and not a conversation', () => {
        const found = pendingReadingCommand(bridge({}) as never);
        expect(found?.sessionId).toBe('bridge-1');
        expect(found?.command.verb).toBe('pause');
        expect(bridgeSessionIdOf(bridge(null) as never)).toBe('bridge-1');
    });

    it('finds nothing when the bridge is holding nothing', () => {
        expect(pendingReadingCommand(bridge(null) as never)).toBeNull();
        expect(pendingReadingCommand({} as never)).toBeNull();
    });
});

describe('answering it', () => {
    it('applies it once and reports the verdict back to the bridge', async () => {
        const report: ReadingReporter = vi.fn(async () => undefined);
        const out = await handleReadingCommands(bridge({}) as never, policy, report, 2_000);
        expect(out).toBe('answered');
        expect(policy.setPaused).toHaveBeenCalledWith(true);
        expect(report).toHaveBeenCalledTimes(1);
        expect(report).toHaveBeenCalledWith('bridge-1', expect.objectContaining({ id: 'rd-1', applied: true }));
    });

    it('never applies the same command twice, however often the store publishes', async () => {
        // The store publishes on every change anywhere, and the bridge rewrites
        // the same agent state on reconnect. Without this a single `drover read
        // pause` would land as a dozen.
        const report = vi.fn(async () => undefined);
        const sessions = bridge({}) as never;
        expect(await handleReadingCommands(sessions, policy, report, 2_000)).toBe('answered');
        expect(await handleReadingCommands(sessions, policy, report, 2_000)).toBe('none');
        expect(await handleReadingCommands(sessions, policy, report, 2_000)).toBe('none');
        expect(policy.setPaused).toHaveBeenCalledTimes(1);
    });

    it('an EXPIRED command is neither applied nor acked', async () => {
        // The app was closed when the ask went out; the bus has already told
        // the terminal nothing happened. Applying it now is the phone talking
        // in a pocket, and acking it only earns a 409.
        const report = vi.fn(async () => undefined);
        const out = await handleReadingCommands(bridge({}) as never, policy, report, 9_001);
        expect(out).toBe('expired');
        expect(policy.setPaused).not.toHaveBeenCalled();
        expect(report).not.toHaveBeenCalled();
    });

    it('a bridge it cannot reach never throws into the store subscription', async () => {
        const report = vi.fn(async () => {
            throw new Error('socket is gone');
        });
        await expect(handleReadingCommands(bridge({}) as never, policy, report, 2_000)).resolves.toBe('answered');
    });
});
