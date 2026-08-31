/**
 * The bridge is not a session, and every surface has to agree (DROVE-238).
 *
 * Clay's list carried a row headed "Cattle Drover — pending…" with `happy-cli`
 * under it. It is the mailbox happy-cli keeps for mirrored bus gates, it is
 * never active, and opening it answers "This session is inactive." He was sent
 * into it from the Accounts screen to type a login code.
 *
 * The wrist had already learned to skip it, on the summary string, in a private
 * line of droverWatchFeed. The phone's own list had never been told. So what is
 * pinned here is one reader for both, and the fallback that keeps working on a
 * machine whose CLI has not been rebuilt yet.
 */

import { describe, expect, it } from 'vitest';

import { isDroverBridgeMetadata, isDroverBridgeSession } from './droverBridgeSession';

describe('isDroverBridgeSession', () => {
    it('knows the bridge by the flag the CLI stamps', () => {
        expect(isDroverBridgeSession({ metadata: { droverBridge: true } })).toBe(true);
    });

    it('still knows it by its summary, for a CLI that has not been rebuilt', () => {
        // The whole point of keeping the fallback. The flag only reaches a
        // machine once happy-cli is rebuilt and its daemon restarted; the row
        // is in Clay's list now.
        expect(isDroverBridgeSession({
            metadata: { summary: { text: 'Cattle Drover — pending gates from every local agent' } },
        })).toBe(true);
    });

    it('is not fooled by a session that merely mentions the drover', () => {
        expect(isDroverBridgeSession({
            metadata: { summary: { text: 'Fixing the Cattle Drover login flow' } },
        })).toBe(false);
    });

    it('leaves an ordinary session alone', () => {
        expect(isDroverBridgeSession({
            metadata: { summary: { text: 'cattle-drover · DROVE-238' } },
        })).toBe(false);
        expect(isDroverBridgeSession({ metadata: {} })).toBe(false);
        expect(isDroverBridgeSession({ metadata: null })).toBe(false);
        expect(isDroverBridgeSession(null)).toBe(false);
        expect(isDroverBridgeSession(undefined)).toBe(false);
    });

    it('reads a bare metadata object too, for callers that hold one', () => {
        expect(isDroverBridgeMetadata({ droverBridge: true })).toBe(true);
        expect(isDroverBridgeMetadata(undefined)).toBe(false);
    });

    it('does not treat droverBridge: false as the bridge', () => {
        // An explicit false is a session saying it is NOT the mailbox. Reading
        // it as truthy-ish would hide a real session from the list, which is
        // the one failure worse than showing the mailbox.
        expect(isDroverBridgeSession({ metadata: { droverBridge: false } })).toBe(false);
    });
});
