import type { SpawnSessionResult } from '@/sync/ops';

/**
 * What to show when a fork, a clone or a resume did not produce a session.
 *
 * ONE rule, and it is the whole point of DROVE-337: if the daemon said why,
 * that sentence is what the person reads. The generic fallback is for the one
 * case where nothing came back to read, not for every case the caller's
 * `switch` did not happen to name.
 *
 * The shape that used to slip through was `requestToApproveDirectoryCreation`
 * — a real, tagged result the fork path never handled, so it fell to the
 * generic branch. It has its own sentence now, because "the folder is gone"
 * is actionable and "Failed to fork the session." is not.
 *
 * The copy is passed IN rather than looked up here, because `@/text` reaches
 * expo-localization and through it react-native, which vitest cannot parse.
 * Every pure module in this folder is testable for that reason and this one
 * stays that way; the caller does the `t()`.
 */
export interface SpawnFailureCopy {
    /** Shown only when nothing else was said. */
    generic: string;
    directoryMissing: (directory: string) => string;
}

export function spawnFailureMessage(result: SpawnSessionResult, copy: SpawnFailureCopy): string {
    if (result.type === 'error') {
        const message = result.errorMessage?.trim();
        return message || copy.generic;
    }
    if (result.type === 'requestToApproveDirectoryCreation') {
        return copy.directoryMissing(result.directory);
    }
    return copy.generic;
}
