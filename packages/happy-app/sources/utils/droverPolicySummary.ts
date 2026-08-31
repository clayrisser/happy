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
        onLimit === 'auto' ? 'Switches on its own'
        : onLimit === 'prompt' ? 'Asks which account'
        : 'Switching behaviour unknown';
    // DROVE-187 gave this key four values. The two older ones still turn up in
    // a settings file written before that ticket, so they are read here rather
    // than shown as "unknown".
    const family =
        onFamilyExhausted === 'flip-then-downgrade' || onFamilyExhausted === 'fallback'
            ? 'then drops a model rung if it has to'
        : onFamilyExhausted === 'flip-only' || onFamilyExhausted === 'stop'
            ? 'and leaves the model alone'
        : onFamilyExhausted === 'downgrade-only' ? 'drops a model rung instead of moving account'
        : onFamilyExhausted === 'nothing' ? 'and changes nothing when it runs out'
        : 'model fallback unknown';

    return `${limit}, ${family}`;
}
