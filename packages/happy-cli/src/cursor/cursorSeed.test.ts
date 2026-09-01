import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readCursorSeed } from './cursorSeed';

const scratch = () => mkdtempSync(join(tmpdir(), 'cursor-seed-'));

describe('the seed a cloned Cursor session starts from', () => {
    it('reads the file whole, so the retold conversation arrives intact', () => {
        const dir = scratch();
        const path = join(dir, 'seed.md');
        const text = '# Cloned from db93e97b\n\nYou are continuing nothing.\n\n> user: hello\n';
        writeFileSync(path, text, 'utf8');

        expect(readCursorSeed(path)).toBe(text);
    });

    // A window that opens, starts cursor-agent and begins with no context
    // while reporting success is the failure this lane exists to avoid. So it
    // throws BEFORE a session is registered, and it names the file.
    it('refuses a seed it cannot read, naming the file', () => {
        const path = join(scratch(), 'missing.md');

        expect(() => readCursorSeed(path)).toThrow(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });

    it('refuses an empty seed rather than starting with nothing', () => {
        const dir = scratch();
        const path = join(dir, 'empty.md');
        writeFileSync(path, '   \n\n', 'utf8');

        expect(() => readCursorSeed(path)).toThrow(/empty/);
    });
});
