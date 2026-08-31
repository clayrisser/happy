import { describe, expect, it, vi } from 'vitest';

// The fallback is a translated string and nothing else here reads the locale.
vi.mock('@/text', () => ({ t: (key: string) => key }));

import { sessionDisplayTitle, sessionPathBasename } from './sessionTitle';
import { getSessionName } from './sessionUtils';
import type { Session } from '@/sync/storageTypes';

/** Enough of a session to be named. Cast at the call, never in the helper. */
function session(metadata: Record<string, unknown> | null) {
    return { metadata } as unknown as Session;
}

describe('the session title, once', () => {
    it('is the name the session was given', () => {
        expect(sessionDisplayTitle(session({
            summary: { text: 'DROVER', updatedAt: 1 },
            name: 'DROVER',
            path: '/Users/clay/Projects/bitspur/cattle-drover',
        }))).toBe('DROVER');
    });

    /**
     * DROVE-127, exactly. The wrist read the path and the phone read the name,
     * and Clay was looking at two photos of the same session under two names.
     */
    it('is never the directory when there is a name', () => {
        const named = session({
            summary: { text: 'DROVER', updatedAt: 1 },
            path: '/Users/clay/Projects/bitspur/cattle-drover',
        });
        expect(sessionDisplayTitle(named)).toBe('DROVER');
        expect(sessionDisplayTitle(named)).not.toBe('cattle-drover');
    });

    it('falls back to metadata.name when only the CLI stamped one', () => {
        expect(sessionDisplayTitle(session({ name: 'zap', path: '/tmp/anything' }))).toBe('zap');
    });

    it('falls back to the directory basename when there is no name at all', () => {
        expect(sessionDisplayTitle(session({
            path: '/Users/clay/Projects/bitspur/cattle-drover',
        }))).toBe('cattle-drover');
    });

    it('falls back to New chat when there is neither a name nor a path', () => {
        expect(sessionDisplayTitle(session({}))).toBe('session.newChat');
        expect(sessionDisplayTitle(session(null))).toBe('session.newChat');
    });

    it('treats a whitespace-only name as no name', () => {
        expect(sessionDisplayTitle(session({
            summary: { text: '   ', updatedAt: 1 },
            path: '/srv/lookout',
        }))).toBe('lookout');
    });

    /**
     * The phone is not a second implementation. If this ever fails it is
     * because someone gave getSessionName a rule of its own again, which is
     * how the wrist and the phone drifted in the first place (DROVE-129).
     */
    it('is what the phone shows, because the phone calls it', () => {
        for (const metadata of [
            { summary: { text: 'DROVER', updatedAt: 1 }, path: '/x/cattle-drover' },
            { name: 'zap', path: '/x/cattle-drover' },
            { path: '/x/cattle-drover' },
            {},
        ]) {
            const s = session(metadata);
            expect(getSessionName(s)).toBe(sessionDisplayTitle(s));
        }
    });
});

describe('the working directory basename', () => {
    it('is the last segment', () => {
        expect(sessionPathBasename('/Users/clay/Projects/bitspur/cattle-drover')).toBe('cattle-drover');
    });

    it('ignores a trailing separator', () => {
        expect(sessionPathBasename('/srv/lookout/')).toBe('lookout');
    });

    /** A session can run on Windows; the phone reading it does not. */
    it('splits on a backslash too', () => {
        expect(sessionPathBasename('C:\\work\\lookout')).toBe('lookout');
    });

    it('is empty for a path with no segments', () => {
        expect(sessionPathBasename('/')).toBe('');
        expect(sessionPathBasename('')).toBe('');
        expect(sessionPathBasename(undefined)).toBe('');
    });
});
