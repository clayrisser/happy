import { describe, expect, it } from 'vitest';

import { en } from '@/text/_default';
import { spawnFailureMessage } from './spawnFailure';

/**
 * The one rule (DROVE-337): the generic sentence appears only when nothing
 * else was said. Every other branch prints what the daemon actually reported.
 *
 * The copy comes from `en` rather than from `t()`, because `@/text` reaches
 * react-native through expo-localization and vitest cannot parse it. Reading
 * the real strings still means a reworded `forkErrorGeneric` cannot quietly
 * pass these tests.
 */
const forkCopy = {
    generic: en.session.forkErrorGeneric,
    directoryMissing: (directory: string) => en.session.forkErrorDirectoryMissing({ directory }),
};

const cloneCopy = {
    generic: en.session.cloneErrorGeneric,
    directoryMissing: forkCopy.directoryMissing,
};

describe('what the phone shows when a fork or clone did not start', () => {
    const tmuxFailure = 'Could not open a tmux window for this session: Failed to extract PID from tmux output: .';

    it('shows the daemon reason rather than "Failed to fork the session."', () => {
        const message = spawnFailureMessage({ type: 'error', errorMessage: tmuxFailure }, forkCopy);

        expect(message).toBe(tmuxFailure);
        expect(message).not.toBe(en.session.forkErrorGeneric);
    });

    // This is the shape that used to reach the generic branch even though it
    // is a real, tagged result: the fork spawns with
    // `approvedNewDirectoryCreation: false`, so a worktree that has been
    // cleaned up comes back as an approval request, not an error.
    it('says the folder is gone instead of saying nothing useful', () => {
        const message = spawnFailureMessage({
            type: 'requestToApproveDirectoryCreation',
            directory: '/Users/clay/.cache/drover-worktrees/DROVE-1-gone',
        }, forkCopy);

        expect(message).toContain('/Users/clay/.cache/drover-worktrees/DROVE-1-gone');
        expect(message).not.toBe(en.session.forkErrorGeneric);
    });

    it('falls back only when the error carried no message', () => {
        expect(spawnFailureMessage({ type: 'error', errorMessage: '' }, forkCopy))
            .toBe(en.session.forkErrorGeneric);
        expect(spawnFailureMessage({ type: 'error', errorMessage: '   ' }, forkCopy))
            .toBe(en.session.forkErrorGeneric);
    });

    it('trims the daemon reason so an alert does not open on a blank line', () => {
        expect(spawnFailureMessage({ type: 'error', errorMessage: `\n${tmuxFailure}\n` }, forkCopy))
            .toBe(tmuxFailure);
    });

    it('gives a clone its own fallback, because a clone is not a fork', () => {
        expect(spawnFailureMessage({ type: 'error', errorMessage: '' }, cloneCopy))
            .toBe(en.session.cloneErrorGeneric);
        expect(spawnFailureMessage({ type: 'error', errorMessage: 'the cursor harness has no lane yet' }, cloneCopy))
            .toBe('the cursor harness has no lane yet');
    });
});
