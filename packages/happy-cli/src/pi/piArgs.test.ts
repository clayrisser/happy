/**
 * The flag that must never appear (DROVE-316).
 *
 * `--no-extensions` is not a preference. The lmstudio and glm PROVIDERS are pi
 * extensions, so passing it makes pi answer `Unknown provider "lmstudio"` and
 * refuse to start — which turns the local-model harness into no harness at all.
 * DROVE-295 measured that on pi 0.80.3 and paid for it in a lost session, so
 * this file is the assertion that keeps it paid for once.
 */

import { describe, it, expect } from 'vitest';

import {
    buildPiRpcArgs,
    assertNoExtensionKill,
    PiBannedFlagError,
    PI_EXTENSION_KILLING_FLAGS,
} from './piArgs';

describe('buildPiRpcArgs', () => {
    it('never emits --no-extensions, in any spelling', () => {
        const argv = buildPiRpcArgs({
            gateExtension: '/repo/adapters/pi-gate.mjs',
            model: 'lmstudio/openai/gpt-oss-120b',
            thinking: 'medium',
            resumeSessionId: '01a05e34',
        });
        for (const banned of PI_EXTENSION_KILLING_FLAGS) {
            expect(argv).not.toContain(banned);
        }
    });

    it('is rpc mode, because that IS the channel', () => {
        expect(buildPiRpcArgs()).toEqual(['--mode', 'rpc']);
    });

    it('loads the gate with --extension, which ADDS to discovery', () => {
        // The distinction is the whole trap: `-e` adds an extension on top of
        // normal discovery, `-ne` replaces discovery with nothing and takes the
        // providers down with it.
        const argv = buildPiRpcArgs({ gateExtension: '/repo/adapters/pi-gate.mjs' });
        expect(argv).toEqual(['--mode', 'rpc', '--extension', '/repo/adapters/pi-gate.mjs']);
    });

    it('keeps a model id with a space as ONE argument', () => {
        // pi ids contain slashes and could contain worse. The shell half of
        // drover learned this by having a path split into two arguments and
        // being refused with a message about neither of them.
        const argv = buildPiRpcArgs({ model: 'lmstudio/some model' });
        expect(argv).toEqual(['--mode', 'rpc', '--model', 'lmstudio/some model']);
    });

    it('REFUSES a banned flag in passthrough rather than filtering it out', () => {
        // Silently dropping a flag somebody typed produces a session that is
        // not the one they asked for. Refusing names the reason.
        expect(() => buildPiRpcArgs({ passthrough: ['--no-extensions'] }))
            .toThrow(PiBannedFlagError);
        expect(() => buildPiRpcArgs({ passthrough: ['-ne'] }))
            .toThrow(PiBannedFlagError);
    });

    it('says WHY, so nobody has to rediscover it', () => {
        let message = '';
        try {
            buildPiRpcArgs({ passthrough: ['-ne'] });
        } catch (err) {
            message = err instanceof Error ? err.message : String(err);
        }
        expect(message).toContain('LOCAL MODELS');
        expect(message).toContain('lmstudio');
    });

    it('passes every other pi flag through untouched', () => {
        const argv = buildPiRpcArgs({ passthrough: ['--no-tools', '--name', 'a session'] });
        expect(argv).toEqual(['--mode', 'rpc', '--no-tools', '--name', 'a session']);
    });
});

describe('assertNoExtensionKill', () => {
    it('accepts an argv without the flag', () => {
        expect(() => assertNoExtensionKill(['--mode', 'rpc', '--extension', '/x.mjs'])).not.toThrow();
    });

    it('names the flag it found', () => {
        try {
            assertNoExtensionKill(['--mode', 'rpc', '-ne']);
            expect.unreachable('should have thrown');
        } catch (err) {
            expect((err as PiBannedFlagError).flag).toBe('-ne');
        }
    });
});
