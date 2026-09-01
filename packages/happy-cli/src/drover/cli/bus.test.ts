/**
 * The vitest twin of cattle-drover/tests/bus.bats' point (DROVE-315,
 * BASED-110): a refused connection, a timeout against a healthy daemon, and a
 * DNS miss are three different events with three different fixes, and the CLI
 * must not collapse them into "bus unreachable" — that sentence once nearly
 * made Clay start a second copy of a bus that was already up.
 *
 * bus.bats proves the shell's three sentences off curl's exit code; this proves
 * the node twin's off `cause.code`. The two error-sentence sets are asserted
 * word for word against lib/drover-bus.sh's bus_explain.
 */

import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';

import { BusError, busGet } from './bus';

/** A loopback port that was just bound and freed — connecting to it refuses. */
function closedPort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            srv.close(() => resolve(port));
        });
    });
}

const URL = 'http://127.0.0.1:7970';

describe('BusError.explain — the same words lib/drover-bus.sh prints', () => {
    it('refused names the down bus and how to start it, never "unreachable"', () => {
        const e = new BusError('refused', URL, 10_000, 'ECONNREFUSED');
        expect(e.explain('the inbox')).toEqual([
            'drover: bus not running at http://127.0.0.1:7970 — start it with: drover bus',
            '  (or run the supervised stack: make -C "$DROVER_DIR" launchd)',
        ]);
    });

    it('timeout refuses to call a listening bus down, and says so', () => {
        const e = new BusError('timeout', URL, 10_000, 'timed out');
        expect(e.explain('the inbox')).toEqual([
            'drover: the bus is up but slow answering the inbox (>10s).',
            '  It is listening and healthy enough to accept the connection, so this is',
            '  NOT a down bus — do not start a second one. Check: drover status',
        ]);
    });

    it('resolve blames DROVER_URL, not the bus', () => {
        const e = new BusError('resolve', URL, 10_000, 'ENOTFOUND');
        expect(e.explain()).toEqual([
            'drover: cannot resolve the host in DROVER_URL (http://127.0.0.1:7970)',
        ]);
    });

    it('an unclassified failure still names the endpoint and the detail', () => {
        const e = new BusError('other', URL, 10_000, 'ECONNRESET');
        expect(e.explain()).toEqual([
            'drover: bus request failed (ECONNRESET) at http://127.0.0.1:7970',
        ]);
    });
});

describe('the wire classifies its own failures (real sockets, no server)', () => {
    it('a closed port is `refused`, the one case that means "not running"', async () => {
        const port = await closedPort();
        await expect(busGet('/v1/inbox', 2_000, `http://127.0.0.1:${port}`)).rejects.toMatchObject({
            name: 'BusError',
            kind: 'refused',
        });
    });

    it('a name that cannot resolve is `resolve`, not a down bus', async () => {
        // The reserved .invalid TLD never resolves anywhere: ENOTFOUND.
        await expect(busGet('/v1/inbox', 2_000, 'http://drover-bus.invalid')).rejects.toMatchObject({
            name: 'BusError',
            kind: 'resolve',
        });
    });
});
