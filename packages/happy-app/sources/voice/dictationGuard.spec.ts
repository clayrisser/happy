import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The JS half of DROVE-96: a second startDictation while one is in flight
 * must not reach native, and a stop that lands before the start has settled
 * must wait for it. The native half (session before format, tap tracking) is
 * Swift and is compile-checked, not unit-tested here.
 */

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

const native = vi.hoisted(() => ({
    startDictation: vi.fn<(locale: string | null) => Promise<boolean>>(),
    stopDictation: vi.fn<() => Promise<string>>(),
    cancelDictation: vi.fn<() => Promise<void>>(),
}));

vi.mock('expo-modules-core', () => ({
    requireOptionalNativeModule: () => native,
}));

async function settle(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('dictation reentrancy guard', () => {
    let speech: typeof import('drover-speech');

    beforeEach(async () => {
        vi.resetModules();
        native.startDictation.mockReset();
        native.stopDictation.mockReset();
        native.cancelDictation.mockReset();
        speech = await import('drover-speech');
    });

    it('a second start while the first is pending joins it and never reaches native', async () => {
        const first = deferred<boolean>();
        native.startDictation.mockReturnValueOnce(first.promise);

        const a = speech.startDictation('en-US');
        const b = speech.startDictation('en-US');
        expect(native.startDictation).toHaveBeenCalledTimes(1);

        first.resolve(true);
        await expect(a).resolves.toBe(true);
        await expect(b).resolves.toBe(true);
    });

    it('a start after a successful one still joins it until dictation is stopped', async () => {
        native.startDictation.mockResolvedValueOnce(true);
        native.stopDictation.mockResolvedValueOnce('howdy');
        native.startDictation.mockResolvedValueOnce(true);

        await speech.startDictation();
        await expect(speech.startDictation()).resolves.toBe(true);
        expect(native.startDictation).toHaveBeenCalledTimes(1);

        await expect(speech.stopDictation()).resolves.toBe('howdy');
        await speech.startDictation();
        expect(native.startDictation).toHaveBeenCalledTimes(2);
    });

    it('a stop that arrives before the start settled waits for it', async () => {
        const start = deferred<boolean>();
        native.startDictation.mockReturnValueOnce(start.promise);
        native.stopDictation.mockResolvedValueOnce('late');

        void speech.startDictation();
        const stopped = speech.stopDictation();
        await settle();
        expect(native.stopDictation).not.toHaveBeenCalled();

        start.resolve(true);
        await expect(stopped).resolves.toBe('late');
        expect(native.stopDictation).toHaveBeenCalledTimes(1);
    });

    it('a failed start clears the guard so the next press retries native', async () => {
        native.startDictation.mockRejectedValueOnce(new Error('microphone access was denied'));
        native.startDictation.mockResolvedValueOnce(true);

        await expect(speech.startDictation()).rejects.toThrow('microphone access was denied');
        await expect(speech.startDictation()).resolves.toBe(true);
        expect(native.startDictation).toHaveBeenCalledTimes(2);
    });

    it('cancel clears the guard and waits for a pending start like stop does', async () => {
        const start = deferred<boolean>();
        native.startDictation.mockReturnValueOnce(start.promise);
        native.cancelDictation.mockResolvedValueOnce(undefined);
        native.startDictation.mockResolvedValueOnce(true);

        void speech.startDictation();
        const cancelled = speech.cancelDictation();
        await settle();
        expect(native.cancelDictation).not.toHaveBeenCalled();

        start.resolve(true);
        await cancelled;
        expect(native.cancelDictation).toHaveBeenCalledTimes(1);

        await speech.startDictation();
        expect(native.startDictation).toHaveBeenCalledTimes(2);
    });
});
