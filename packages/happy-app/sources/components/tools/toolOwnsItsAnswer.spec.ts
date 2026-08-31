/**
 * One question, one set of buttons (DROVE-238).
 *
 * Clay's login card had a link, a code field, "Cancel the login" and "Send
 * code" — and then, in the same box, "Yes", "Yes, don't ask again for this
 * tool" and "No, and provide feedback". Two unrelated answer widgets stacked in
 * one card, with the wrong ones the easier to hit, and the generic Yes sends an
 * approval carrying no code at all.
 *
 * It is not two pending events. It is `ToolView` drawing `PermissionFooter`
 * under a card that already answers for itself, because the exemption list had
 * exactly one name on it.
 */

import { describe, expect, it } from 'vitest';

import { toolOwnsItsAnswer } from './toolOwnsItsAnswer';

describe('toolOwnsItsAnswer', () => {
    it('exempts the drover login card, which is the one Clay saw doubled', () => {
        expect(toolOwnsItsAnswer('DroverAccountLogin')).toBe(true);
    });

    it('exempts the to-do card, which is answered by Done or Drop it', () => {
        // Same shape, same bug, never reported: any generic approve used to
        // close it, which is why DROVE-69 gave it its own view in the first
        // place.
        expect(toolOwnsItsAnswer('DroverTodo')).toBe(true);
    });

    it('keeps the exemption AskUserQuestion already had', () => {
        expect(toolOwnsItsAnswer('AskUserQuestion')).toBe(true);
    });

    it('leaves a real permission alone', () => {
        // A Bash approval IS the permission footer's question. Exempting these
        // would leave a card with nothing to press.
        expect(toolOwnsItsAnswer('Bash')).toBe(false);
        expect(toolOwnsItsAnswer('Edit')).toBe(false);
        expect(toolOwnsItsAnswer('ExitPlanMode')).toBe(false);
    });

    it('says no to a tool with no name rather than throwing', () => {
        expect(toolOwnsItsAnswer(null)).toBe(false);
        expect(toolOwnsItsAnswer(undefined)).toBe(false);
        expect(toolOwnsItsAnswer('')).toBe(false);
    });
});
