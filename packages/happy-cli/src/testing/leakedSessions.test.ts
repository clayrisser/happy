/**
 * DROVE-336: the global-setup leak detector counts the sessions that belong to
 * a checkout, in the shape the daemon really writes.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sessionsUnder } from './leakedSessions';

let dir: string;
let file: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'drover-leaked-sessions-'));
    file = join(dir, 'sessions.json');
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

/** The daemon's shape: a `sessions` object keyed by id, metadata inside. */
function store(entries: Record<string, { path?: string; happyLibDir?: string } | null>): void {
    const sessions: Record<string, unknown> = {};
    for (const [id, md] of Object.entries(entries)) {
        sessions[id] = { seq: 0, metadata: md, savedAt: 1 };
    }
    writeFileSync(file, JSON.stringify({ sessions }));
}

describe('sessionsUnder', () => {
    it('is the sessions whose cwd or happyLibDir is the checkout or under it, and nothing else', () => {
        store({
            leakedFromPackage: { path: '/wt/x/packages/happy-cli', happyLibDir: '/wt/x/packages/happy-cli' },
            leakedFromRoot: { path: '/wt/x', happyLibDir: '/wt/x/packages/happy-cli' },
            ranThisDistElsewhere: { path: '/somewhere/else', happyLibDir: '/wt/x/packages/happy-cli' },
            sibling: { path: '/wt/xy/packages/happy-cli', happyLibDir: '/wt/xy/packages/happy-cli' },
            real: { path: '/Users/clay/Projects/bitspur/cattle-drover', happyLibDir: '/Users/clay/Projects/bitspur/happy/packages/happy-cli' },
            noMetadata: null,
        });
        expect(sessionsUnder('/wt/x', file).sort()).toEqual(['leakedFromPackage', 'leakedFromRoot', 'ranThisDistElsewhere']);
        expect(sessionsUnder('/wt/x/', file).sort()).toEqual(['leakedFromPackage', 'leakedFromRoot', 'ranThisDistElsewhere']);
    });

    it('reads an array store too, by id', () => {
        writeFileSync(file, JSON.stringify({
            sessions: [
                { id: 'a', metadata: { path: '/wt/x' } },
                { id: 'b', metadata: { path: '/elsewhere' } },
            ],
        }));
        expect(sessionsUnder('/wt/x', file)).toEqual(['a']);
    });

    it('an absent, empty or unparseable store is no sessions, never a failed run', () => {
        expect(sessionsUnder('/wt/x', join(dir, 'nope.json'))).toEqual([]);
        writeFileSync(file, '');
        expect(sessionsUnder('/wt/x', file)).toEqual([]);
        writeFileSync(file, '{"sessions": 42}');
        expect(sessionsUnder('/wt/x', file)).toEqual([]);
    });
});
