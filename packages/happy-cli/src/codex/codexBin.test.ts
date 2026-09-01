/**
 * DROVE-273. The bug being pinned: a Codex install that a login shell finds and
 * a launchd daemon does not. Every case here is a real install layout, and the
 * PATH is passed in rather than mutated so nothing depends on this machine.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';

import { findCodexBin, resolveCodexBin, CODEX_BIN } from './codexBin';

let root: string;

/** A real file at <dir>/codex, since the finder stats rather than trusts. */
function installAt(dir: string): string {
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, CODEX_BIN);
    writeFileSync(bin, '#!/bin/sh\necho codex-cli 0.140.0\n', { mode: 0o755 });
    return bin;
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codexbin-'));
});

describe('findCodexBin', () => {
    it('is undefined when Codex is genuinely not installed', () => {
        expect(findCodexBin({ PATH: join(root, 'empty'), HOME: root }, join(root, 'node'))).toBeUndefined();
    });

    it('finds Codex on PATH and returns an absolute path', () => {
        const bin = installAt(join(root, 'bin'));
        expect(findCodexBin({ PATH: join(root, 'bin'), HOME: root }, join(root, 'node'))).toBe(bin);
    });

    it('takes the first PATH hit, so PATH ordering still decides', () => {
        const first = installAt(join(root, 'a'));
        installAt(join(root, 'b'));
        const path = [join(root, 'a'), join(root, 'b')].join(':');
        expect(findCodexBin({ PATH: path, HOME: root }, join(root, 'node'))).toBe(first);
    });

    // The whole point of the file: PATH says no, the binary is there anyway.
    it('finds an npm -g install beside the running node when PATH misses it', () => {
        const bin = installAt(join(root, 'nodebin'));
        const execPath = join(root, 'nodebin', 'node');
        expect(findCodexBin({ PATH: join(root, 'empty'), HOME: root }, execPath)).toBe(bin);
    });

    it('finds a ~/.local/bin install when PATH misses it', () => {
        const bin = installAt(join(root, '.local', 'bin'));
        expect(findCodexBin({ PATH: join(root, 'empty'), HOME: root }, join(root, 'node'))).toBe(bin);
    });

    it('prefers PATH over the fallback locations', () => {
        const onPath = installAt(join(root, 'bin'));
        installAt(join(root, '.local', 'bin'));
        expect(findCodexBin({ PATH: join(root, 'bin'), HOME: root }, join(root, 'node'))).toBe(onPath);
    });

    it('honours HAPPY_CODEX_PATH above everything else', () => {
        installAt(join(root, 'bin'));
        const override = installAt(join(root, 'elsewhere'));
        const env = { PATH: join(root, 'bin'), HOME: root, HAPPY_CODEX_PATH: override };
        expect(findCodexBin(env, join(root, 'node'))).toBe(override);
    });

    it('ignores an HAPPY_CODEX_PATH that points at nothing, rather than spawning it', () => {
        const onPath = installAt(join(root, 'bin'));
        const env = { PATH: join(root, 'bin'), HOME: root, HAPPY_CODEX_PATH: join(root, 'gone') };
        expect(findCodexBin(env, join(root, 'node'))).toBe(onPath);
    });

    // A directory named `codex` on PATH is not an install, and spawning it
    // would fail with EACCES rather than the clear "not installed" message.
    it('does not mistake a directory named codex for an installation', () => {
        mkdirSync(join(root, 'bin', CODEX_BIN), { recursive: true });
        expect(findCodexBin({ PATH: join(root, 'bin'), HOME: root }, join(root, 'node'))).toBeUndefined();
    });

    it('tolerates an unset PATH instead of throwing', () => {
        expect(findCodexBin({ HOME: root }, join(root, 'node'))).toBeUndefined();
    });
});

describe('resolveCodexBin', () => {
    it('falls back to the bare name so the spawn error still names codex', () => {
        expect(resolveCodexBin({ PATH: join(root, 'empty'), HOME: root }, join(root, 'node'))).toBe(CODEX_BIN);
    });

    it('returns the resolved path when there is one', () => {
        const bin = installAt(join(root, 'bin'));
        expect(resolveCodexBin({ PATH: join(root, 'bin'), HOME: root }, join(root, 'node'))).toBe(bin);
    });
});
