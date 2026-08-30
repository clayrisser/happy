import { describe, expect, it } from 'vitest';

import { isSessionArchived, type ArchivableSession } from './sessionArchive';

function session(options: { active?: boolean; lifecycleState?: string; client?: string }): ArchivableSession {
    return {
        active: options.active ?? true,
        metadata: {
            ...(options.lifecycleState ? { lifecycleState: options.lifecycleState } : {}),
            ...(options.client ? { client: { id: options.client } } : {}),
        } as ArchivableSession['metadata'],
    };
}

describe('isSessionArchived', () => {
    it('archives what the agent retired, whatever its socket is doing', () => {
        expect(isSessionArchived(session({ lifecycleState: 'archived' }))).toBe(true);
        expect(isSessionArchived(session({ lifecycleState: 'archived', active: false }))).toBe(true);
    });

    it('archives a Happy CLI session once its socket is gone, which is how one ends', () => {
        expect(isSessionArchived(session({ active: false }))).toBe(true);
    });

    // The reason the rule is not just `!active`: a rig session out of contact
    // is work still running somewhere, not work that finished.
    it('leaves a rig session that merely lost its connection', () => {
        expect(isSessionArchived(session({ active: false, client: 'rig' }))).toBe(false);
    });

    it('leaves a running session alone', () => {
        expect(isSessionArchived(session({ lifecycleState: 'running' }))).toBe(false);
        expect(isSessionArchived({ active: true, metadata: null })).toBe(false);
    });

    // A session with no metadata and no socket is gone too — nothing about it
    // says otherwise, and the phone's list drops it for the same reason.
    it('archives a socketless session that never sent metadata', () => {
        expect(isSessionArchived({ active: false, metadata: null })).toBe(true);
    });
});
