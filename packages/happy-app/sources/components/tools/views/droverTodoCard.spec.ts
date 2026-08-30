import { describe, expect, it } from 'vitest';

import { droverTodoCard } from './droverTodoCard';

/**
 * DROVE-69. The card `drover needs` produces, read back.
 *
 * The view over this sends NOTHING until one of the option ids below is
 * pressed — there is no effect, no timer and no unmount handler in
 * DroverTodoView, and its only call to sessionAllow is inside `close`, which
 * takes the id as its argument. The other half of that guarantee is enforced
 * where it cannot be bypassed by any surface: happy-cli's busResolutionFor
 * returns null for a to-do answer that names neither button, so an approve
 * from the wrist, the voice tool or a generic Allow leaves it pending. That is
 * covered in packages/happy-cli/src/drover/droverBridge.test.ts.
 */
describe('droverTodoCard', () => {
    const input = {
        title: 'Archive TestFlight build 8',
        reason: 'The watch work is Swift and can never ship over the air',
        command: 'pnpm prebuild:ios && make ios/beta',
        options: [{ id: 'done', label: 'Done' }, { id: 'drop', label: 'Drop it' }],
    };

    it('reads what to do, why it blocks, and the command that was given', () => {
        expect(droverTodoCard(input)).toEqual({
            title: 'Archive TestFlight build 8',
            reason: 'The watch work is Swift and can never ship over the air',
            command: 'pnpm prebuild:ios && make ios/beta',
            options: [{ id: 'done', label: 'Done' }, { id: 'drop', label: 'Drop it' }],
        });
    });

    it('is fine with a to-do that has no command, because most have none', () => {
        // `drover needs "log in to the box"` is a job with nothing to run.
        expect(droverTodoCard({ title: 'log in to the box' })?.command).toBe('');
    });

    it('keeps the two buttons for a card written before options were carried', () => {
        // A dead card is worse than a card with the pair the bus injects at
        // create anyway — those ids are what every other surface answers with.
        expect(droverTodoCard({ title: 'push the release' })?.options)
            .toEqual([{ id: 'done', label: 'Done' }, { id: 'drop', label: 'Drop it' }]);
    });

    it('draws nothing at all for a card with no title', () => {
        // Two buttons over an empty card would close a record the screen could
        // not describe.
        expect(droverTodoCard({ reason: 'why' })).toBeNull();
        expect(droverTodoCard(undefined)).toBeNull();
    });

    it('drops an option with no id, which nothing could be answered with', () => {
        expect(droverTodoCard({ title: 'x', options: [{ label: 'Done' }, { id: 'drop' }] })?.options)
            .toEqual([{ id: 'drop', label: 'drop' }]);
    });
});
