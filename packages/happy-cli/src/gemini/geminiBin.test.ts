/**
 * DROVE-381. The bug being pinned: a gemini install that a login shell finds and
 * a launchd daemon does not. Every case here is a real install layout, and the
 * PATH is passed in rather than mutated so nothing depends on this machine.
 *
 * gemini is the purest instance of it in the tree: it has no installer of its
 * own and no cask, so `npm install -g @google/gemini-cli` is the only way it
 * arrives, and the npm global prefix is per node version. Under asdf that is a
 * directory nobody's PATH names in full, which is why the beside-node fallback
 * is the case that actually matters here.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';

import { findGeminiBin, resolveGeminiBin, GEMINI_BIN } from './geminiBin';

/**
 * NO SYSTEM DIRS. /opt/homebrew/bin/gemini is real on any machine whose node
 * came from brew, so leaving the default in would make every "not installed"
 * case find that install and pass while asserting the opposite. The
 * npm-beside-node and ~/.local/bin fallbacks are still exercised below; they are
 * derived from the env, which IS passed in.
 */
const NO_SYSTEM: readonly string[] = [];

const findGeminiBin_ = (env: NodeJS.ProcessEnv, execPath?: string) => findGeminiBin(env, execPath, NO_SYSTEM);
const resolveGeminiBin_ = (env: NodeJS.ProcessEnv, execPath?: string) => resolveGeminiBin(env, execPath, NO_SYSTEM);

let root: string;

/** A real file at <dir>/gemini, since the finder stats rather than trusts. */
function installAt(dir: string): string {
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, GEMINI_BIN);
    writeFileSync(bin, '#!/bin/sh\necho 0.58.0\n', { mode: 0o755 });
    return bin;
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'geminibin-'));
});

describe('findGeminiBin', () => {
    it('is undefined when gemini is genuinely not installed', () => {
        expect(findGeminiBin_({ PATH: join(root, 'empty'), HOME: root }, join(root, 'node'))).toBeUndefined();
    });

    it('finds gemini on PATH and returns an absolute path', () => {
        const bin = installAt(join(root, 'bin'));
        expect(findGeminiBin_({ PATH: join(root, 'bin'), HOME: root }, join(root, 'node'))).toBe(bin);
    });

    it('takes the first PATH hit, so PATH ordering still decides', () => {
        const first = installAt(join(root, 'a'));
        installAt(join(root, 'b'));
        const path = [join(root, 'a'), join(root, 'b')].join(':');
        expect(findGeminiBin_({ PATH: path, HOME: root }, join(root, 'node'))).toBe(first);
    });

    // The whole point of the file: PATH says no, the binary is there anyway.
    it('finds an npm -g install beside the running node when PATH misses it', () => {
        const bin = installAt(join(root, 'nodebin'));
        const execPath = join(root, 'nodebin', 'node');
        expect(findGeminiBin_({ PATH: join(root, 'empty'), HOME: root }, execPath)).toBe(bin);
    });

    it('finds a ~/.local/bin install when PATH misses it', () => {
        const bin = installAt(join(root, '.local', 'bin'));
        expect(findGeminiBin_({ PATH: join(root, 'empty'), HOME: root }, join(root, 'node'))).toBe(bin);
    });

    it('prefers PATH over the fallback locations', () => {
        const onPath = installAt(join(root, 'bin'));
        installAt(join(root, '.local', 'bin'));
        expect(findGeminiBin_({ PATH: join(root, 'bin'), HOME: root }, join(root, 'node'))).toBe(onPath);
    });

    it('honours HAPPY_GEMINI_PATH above everything else', () => {
        installAt(join(root, 'bin'));
        const override = installAt(join(root, 'elsewhere'));
        const env = { PATH: join(root, 'bin'), HOME: root, HAPPY_GEMINI_PATH: override };
        expect(findGeminiBin(env, join(root, 'node'))).toBe(override);
    });

    it('ignores an HAPPY_GEMINI_PATH that points at nothing, rather than spawning it', () => {
        const onPath = installAt(join(root, 'bin'));
        const env = { PATH: join(root, 'bin'), HOME: root, HAPPY_GEMINI_PATH: join(root, 'gone') };
        expect(findGeminiBin(env, join(root, 'node'))).toBe(onPath);
    });

    // A directory named `gemini` on PATH is not an install, and spawning it
    // would fail with EACCES rather than the clear "not installed" message.
    it('does not mistake a directory named gemini for an installation', () => {
        mkdirSync(join(root, 'bin', GEMINI_BIN), { recursive: true });
        expect(findGeminiBin_({ PATH: join(root, 'bin'), HOME: root }, join(root, 'node'))).toBeUndefined();
    });

    // A node_modules/.bin entry belongs to whichever tree you are standing in,
    // not to an installation. Test runners put that directory on PATH; a daemon
    // does not.
    it('ignores a node_modules/.bin shim, which is a build artifact not an install', () => {
        const shim = join(root, 'node_modules', '.bin');
        installAt(shim);
        expect(findGeminiBin_({ PATH: shim, HOME: root }, join(root, 'node'))).toBeUndefined();
    });

    it('takes a real install over a node_modules/.bin shim earlier on PATH', () => {
        const shim = join(root, 'node_modules', '.bin');
        installAt(shim);
        const real = installAt(join(root, 'bin'));
        const path = [shim, join(root, 'bin')].join(':');
        expect(findGeminiBin_({ PATH: path, HOME: root }, join(root, 'node'))).toBe(real);
    });

    it('tolerates an unset PATH instead of throwing', () => {
        expect(findGeminiBin_({ HOME: root }, join(root, 'node'))).toBeUndefined();
    });
});

describe('resolveGeminiBin', () => {
    it('falls back to the bare name so the spawn error still names gemini', () => {
        expect(resolveGeminiBin_({ PATH: join(root, 'empty'), HOME: root }, join(root, 'node'))).toBe(GEMINI_BIN);
    });

    it('returns the resolved path when there is one', () => {
        const bin = installAt(join(root, 'bin'));
        expect(resolveGeminiBin_({ PATH: join(root, 'bin'), HOME: root }, join(root, 'node'))).toBe(bin);
    });
});
