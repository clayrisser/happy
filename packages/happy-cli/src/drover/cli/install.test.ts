/**
 * `drover install` — the shim half (DROVE-307), in node (DROVE-315).
 *
 * The engine is engine/install.js and it stays there: one reader of the
 * manifests, so the terminal cannot disagree with anything else that reads
 * them. cattle-drover/tests/install.bats owns the engine's 42 cases — the
 * closed verb set, the refusals, the dependsOn topology, "never a credential"
 * — and none of that moves here. What moves is the wrapper, and these are its
 * three jobs.
 *
 * NOTHING HERE INSTALLS ANYTHING. Only the two paths that answer before the
 * engine is loaded are driven.
 */

import { describe, expect, it } from 'vitest';

import { droverVerbs } from './index';
import { NO_NODE, hasNode, run } from './install';

const lines: string[] = [];
const io = { out: (s: string) => void lines.push(s), err: (s: string) => void lines.push(s) };
const output = () => lines.join('');

describe('--help costs nothing', () => {
    it('answers before the engine is loaded, and names the exit codes', async () => {
        // The load-time gate treats a subprocess on --help as a load-time side
        // effect, and it is right: help must be free. `run` never reaches
        // loadEngine on this path, so a machine with no cattle-drover checkout
        // still gets the text.
        lines.length = 0;
        expect(await run(['--help'], io, { PATH: '' })).toBe(0);
        expect(output()).toContain('drover install --base');
        expect(output()).toContain('4  a unit asked for is not supported on this machine');
        expect(output()).toContain('Installs binaries. Never logs anything in, never writes a credential.');
    });
});

describe('the one manual step on a truly bare machine', () => {
    it('gives one instruction rather than a stack trace when there is no node', async () => {
        // Drover IS a node program — the bus, the bridges and the install
        // engine — so node is a prerequisite of drover rather than merely of
        // the installer, and pretending otherwise would mean a second manifest
        // reader written in shell just to bootstrap the first.
        lines.length = 0;
        expect(await run(['--base'], io, { PATH: '/nowhere:/also-nowhere' })).toBe(1);
        expect(output()).toBe(NO_NODE);
        expect(output()).toContain('brew install node');
        expect(output()).toContain('sudo apt-get install -y nodejs npm');
    });

    it('finds node on a PATH that has one', () => {
        expect(hasNode({ PATH: '/nowhere' })).toBe(false);
        expect(hasNode({ PATH: process.env.PATH })).toBe(true);
    });
});

describe('the verb', () => {
    it('is in the verb table, so `drover install` reaches node', () => {
        expect(droverVerbs.map((v) => v.name)).toContain('install');
    });
});
