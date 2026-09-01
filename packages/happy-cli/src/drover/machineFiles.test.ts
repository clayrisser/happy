/**
 * The relay's job is to hand over exactly what the bus said, and to refuse or
 * re-mask what the bus should not have said. Tested against a fake bus —
 * nothing here touches the live one, which is the rule the drover's own
 * suite enforces at :7970.
 */

import { describe, expect, it } from 'vitest';

import { readMachineFile, readMachineFilesList, readMachinePane, type BusAnswer } from './machineFiles';

// FIXTURESECRET is the suite's planted marker, shared with the drover's
// tests/files.bats so one grep covers every value hidden on either side of
// the wire. Nothing real is in this file.
const planted = 'sk-ant-FIXTURESECRET330';

const listing = () => ({
    root: '/Users/clay/Projects/bitspur/happy',
    path: '',
    entries: [
        { name: 'packages', type: 'directory', size: null, modified: 1, refused: false },
        { name: '.env', type: 'file', size: 12, modified: 1, refused: true },
        { name: 'README.md', type: 'file', size: 300, modified: 1, refused: false },
    ],
    readAt: 1_700_000_000_000,
});

const file = (content: string | null) => ({
    root: '/Users/clay/Projects/bitspur/happy',
    path: 'README.md',
    content,
    size: 300,
    truncated: false,
    binary: content === null,
    redacted: 0,
    readAt: 1_700_000_000_000,
});

const pane = (lines: string[]) => ({
    sessionId: '11111111-3300-4000-8000-000000000001',
    pane: '%7',
    lines,
    redacted: 0,
    capturedAt: 1_700_000_000_000,
});

/** What the fake bus was asked, so a test can pin the query it composed. */
const calls: string[] = [];

const bus = (status: number, body: unknown) => ({
    fetchBus: async (pathAndQuery: string): Promise<BusAnswer> => {
        calls.push(pathAndQuery);
        return { status, body };
    },
});

describe('listing a worktree', () => {
    it('hands the bus answer over whole, and asks with the root and path encoded', async () => {
        calls.length = 0;
        const b = bus(200, listing());
        const result = await readMachineFilesList({ root: '/Users/clay/Projects/bitspur/happy', path: 'packages/happy app' }, b);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.listing.entries.map((e) => [e.name, e.refused])).toEqual([['packages', false], ['.env', true], ['README.md', false]]);
        expect(calls).toEqual(['/v1/files?root=%2FUsers%2Fclay%2FProjects%2Fbitspur%2Fhappy&path=packages%2Fhappy%20app']);
    });

    it('REFUSES a listing whose entry carries an extra field, rather than stripping it', async () => {
        const leaky = listing();
        (leaky.entries[0] as Record<string, unknown>).absolutePath = `/Users/clay/${planted}`;
        const result = await readMachineFilesList({ root: '/x', path: '' }, bus(200, leaky));
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).not.toContain('FIXTURESECRET');
            expect(result.error).toContain('absolutePath');
            expect(result.error).toContain('Update cattle-drover');
        }
    });

    it('relays a refusal by its kind, never by a value', async () => {
        const result = await readMachineFilesList({ root: '/x', path: '.git' }, bus(403, { error: 'refused', reason: '.git/ is a credential store' }));
        expect(result).toEqual({ ok: false, error: 'refused: .git/ is a credential store' });
    });

    it('says the bus is older than the tab when the route is missing', async () => {
        const result = await readMachineFilesList({ root: '/x', path: '' }, bus(404, { error: 'not found' }));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain('kickstart com.bitspur.cattle-drover.bus');
    });

    it('names a bus that is not running as not running, not as not found', async () => {
        const result = await readMachineFilesList({ root: '/x', path: '' }, {
            fetchBus: async () => {
                throw new Error('connect ECONNREFUSED 127.0.0.1:7970');
            },
        });
        expect(result).toEqual({ ok: false, error: 'The drover bus is not running on this machine (drover bus).' });
    });
});

describe('reading a file', () => {
    it('passes clean text through with the drover\'s own count', async () => {
        const result = await readMachineFile({ root: '/x', path: 'README.md' }, bus(200, { ...file('# Hello\n'), redacted: 2 }));
        expect(result.ok).toBe(true);
        if (result.ok) expect([result.file.content, result.file.redacted]).toEqual(['# Hello\n', 2]);
    });

    it('masks what the drover let through, and adds it to the count', async () => {
        const result = await readMachineFile({ root: '/x', path: 'a.ts' }, bus(200, { ...file(`const k = "${planted}";\n`), redacted: 1 }));
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.file.content).not.toContain('FIXTURESECRET');
            expect(result.file.content).toContain('[redacted]');
            expect(result.file.redacted).toBe(2);
        }
    });

    it('passes a binary answer through untouched', async () => {
        const result = await readMachineFile({ root: '/x', path: 'logo.png' }, bus(200, file(null)));
        expect(result.ok).toBe(true);
        if (result.ok) expect([result.file.content, result.file.binary]).toEqual([null, true]);
    });

    it('refuses a read that grew a field', async () => {
        const leaky = { ...file('x'), realPath: '/Users/clay/x' };
        const result = await readMachineFile({ root: '/x', path: 'x' }, bus(200, leaky));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain('realPath');
    });
});

describe('capturing a pane', () => {
    it('asks by session or by cwd, with the line count when given', async () => {
        calls.length = 0;
        const b = bus(200, pane(['$ ls']));
        await readMachinePane({ sessionId: 'abc', lines: 50 }, b);
        await readMachinePane({ cwd: '/Users/clay/wt/x' }, b);
        expect(calls).toEqual(['/v1/pane?session=abc&lines=50', '/v1/pane?cwd=%2FUsers%2Fclay%2Fwt%2Fx']);
    });

    it('masks a line the drover let through and counts it', async () => {
        const result = await readMachinePane({ sessionId: 'abc' }, bus(200, pane(['$ echo hi', `export ANTHROPIC_API_KEY=${planted}`])));
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.pane.lines.join('\n')).not.toContain('FIXTURESECRET');
            expect(result.pane.lines[0]).toBe('$ echo hi');
            expect(result.pane.redacted).toBe(1);
        }
    });

    it('relays no pane as the sentence the bus gave', async () => {
        const result = await readMachinePane({ sessionId: 'abc' }, bus(409, { error: 'no pane', sessionId: 'abc', paneSource: 'conflict' }));
        expect(result).toEqual({ ok: false, error: 'no pane' });
    });

    it('refuses a pane whose lines are not text', async () => {
        const result = await readMachinePane({ sessionId: 'abc' }, bus(200, { ...pane([]), lines: [{ text: planted }] }));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).not.toContain('FIXTURESECRET');
    });
});
