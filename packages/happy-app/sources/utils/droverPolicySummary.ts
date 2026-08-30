/**
 * One line saying what this session will do when it runs out (DROVE-3).
 *
 * The session info screen has room for a sentence, not a screen, and that
 * sentence has to answer the question Clay actually asks when a session goes
 * quiet: will it move on its own, and will it swap models. Both policies in one
 * line, in the words the policy engine uses.
 *
 * WHERE the value came from is deliberately not in this line. It belongs on the
 * policy screen, where there is room to say "you set this" versus "this is what
 * every session gets"; crammed into a subtitle it turns into noise on a row
 * whose job is to say what will happen.
 */

import type { DroverPolicy } from '@/sync/storageTypes';

export function droverPolicySummary(policy: DroverPolicy | undefined): string {
    if (!policy) return 'Not reported';
    if (policy.unavailable) return 'The drover bus is not answering';

    const onLimit = policy.effective?.onLimit ?? null;
    const onFamilyExhausted = policy.effective?.onFamilyExhausted ?? null;

    const limit =
        onLimit === 'auto' ? 'Flips on its own'
        : onLimit === 'prompt' ? 'Asks which account'
        : 'Flip behaviour unknown';
    const family =
        onFamilyExhausted === 'fallback' ? 'falls back to another model'
        : onFamilyExhausted === 'stop' ? 'stops when your model is out'
        : 'model fallback unknown';

    return `${limit}, ${family}`;
}
