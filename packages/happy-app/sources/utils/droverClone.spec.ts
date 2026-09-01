import { describe, expect, it } from 'vitest';

import { cloneLineageRows, cloneLineageSummary } from './droverClone';

const src = 'aaaaaaaa-0000-0000-0000-000000000000';
const dst = 'bbbbbbbb-0000-0000-0000-000000000000';

describe('clone lineage rows', () => {
    it('says nothing for a session that was never cloned', () => {
        expect(cloneLineageRows(undefined)).toEqual([]);
        expect(cloneLineageSummary(null)).toBeNull();
    });

    it('tells the clone where it came from', () => {
        const rows = cloneLineageRows({ from: { session: src, harness: 'claude' } });
        expect(rows).toHaveLength(1);
        expect(rows[0].direction).toBe('from');
        expect(rows[0].subtitle).toBe('aaaaaaaa in Claude Code');
        expect(rows[0].claudeSessionId).toBe(src);
    });

    it('tells the source where it went, harness named', () => {
        const rows = cloneLineageRows({ to: [{ session: dst, harness: 'opencode' }] });
        expect(rows[0].direction).toBe('to');
        expect(rows[0].subtitle).toBe('bbbbbbbb in OpenCode');
    });

    it('names a pi clone Pi, not the lowercase slug', () => {
        // DROVE-295. `drover clone <session> --to pi` is a real lane, so this
        // row is one a human will see; "pi" beside "Claude Code" reads as a
        // typo rather than as a product.
        const rows = cloneLineageRows({ to: [{ session: dst, harness: 'pi' }] });
        expect(rows[0].subtitle).toBe('bbbbbbbb in Pi');
    });

    it('keeps a clone that has not started yet instead of dropping it', () => {
        // The ledger row exists before the window opens. Dropping this entry
        // would make a session that was just cloned read as un-cloned.
        const rows = cloneLineageRows({ to: [{ session: null, harness: 'cursor' }] });
        expect(rows).toHaveLength(1);
        expect(rows[0].subtitle).toBe('Cursor — starting');
        expect(rows[0].claudeSessionId).toBeNull();
    });

    it('lists every clone of one conversation, both directions at once', () => {
        const rows = cloneLineageRows({
            from: { session: src, harness: 'claude' },
            to: [
                { session: dst, harness: 'claude' },
                { session: null, harness: 'opencode' },
            ],
        });
        expect(rows.map((r) => r.direction)).toEqual(['from', 'to', 'to']);
    });

    it('names a harness nobody has taught it rather than saying nothing', () => {
        const rows = cloneLineageRows({ to: [{ session: dst, harness: 'aider' }] });
        expect(rows[0].subtitle).toBe('bbbbbbbb in aider');
    });

    it('folds several clones into one line when there is room for one', () => {
        expect(cloneLineageSummary({ from: { session: src, harness: 'claude' } }))
            .toBe('cloned from aaaaaaaa in Claude Code');
        expect(cloneLineageSummary({
            to: [{ session: dst, harness: 'claude' }, { session: null, harness: 'cursor' }],
        })).toBe('cloned into 2 sessions');
    });
});
