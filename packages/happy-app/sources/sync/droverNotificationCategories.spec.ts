import { describe, expect, it } from 'vitest';

import {
    actionIdentifierForSlot,
    gateActionTitles,
    gateCategoryIds,
    gateNotificationCategories,
    moreActionIdentifier,
    slotForActionIdentifier,
} from './droverNotificationCategories';

describe('the category bank', () => {
    /**
     * Pinned as a literal list, and the SAME literal list lives in happy-cli's
     * src/drover/gateActions.test.ts. A push naming a category this app never
     * registered draws no buttons at all, silently, so the two halves drifting
     * apart is a feature that quietly stops existing rather than an error
     * anybody sees.
     */
    it('is the closed set the CLI names', () => {
        expect(gateCategoryIds()).toEqual([
            'drover.allowdeny',
            'drover.allowdeny.risky',
            'drover.allowalwaysdeny',
            'drover.allowalwaysdeny.risky',
            'drover.allowalwaysautodeny',
            'drover.allowalwaysautodeny.risky',
            'drover.todo',
            'drover.keys',
            'drover.keys.risky',
            'drover.pick2',
            'drover.pick2.risky',
            'drover.pick3',
            'drover.pick3.risky',
            'drover.pick4',
            'drover.pick4.risky',
            'drover.pickmore',
            'drover.pickmore.risky',
        ]);
    });

    it('never offers more buttons than iOS will draw', () => {
        for (const category of gateNotificationCategories()) {
            expect(category.actions.length).toBeGreaterThanOrEqual(2);
            expect(category.actions.length).toBeLessThanOrEqual(4);
        }
    });

    it('numbers every answering slot positionally, and never by label', () => {
        const four = gateNotificationCategories().find((c) => c.identifier === 'drover.pick4')!;
        expect(four.actions.map((a) => a.identifier)).toEqual([
            'drover.act.0',
            'drover.act.1',
            'drover.act.2',
            'drover.act.3',
        ]);
        expect(four.actions.map((a) => a.buttonTitle)).toEqual(['1', '2', '3', '4']);
    });
});

describe('which buttons are marked how', () => {
    const byId = (id: string) => gateNotificationCategories().find((c) => c.identifier === id)!;

    it('shows the four options of the terminal approval by their meaning', () => {
        expect(byId('drover.allowalwaysautodeny').actions.map((a) => a.buttonTitle)).toEqual([
            'Allow',
            "Allow, don't ask again",
            'Allow, auto mode',
            'Deny',
        ]);
    });

    // Red on the SAFE choice teaches the wrong reflex on a lock screen. Only
    // the two that DISCARD something are destructive.
    it('marks only the discarding buttons destructive', () => {
        const destructive = gateNotificationCategories()
            .flatMap((c) => c.actions)
            .filter((a) => a.options.isDestructive)
            .map((a) => a.buttonTitle);
        expect(new Set(destructive)).toEqual(new Set(['Drop it', 'Press Esc']));
    });

    // Both are DURABLE grants: they change what happens to every future gate,
    // not just this one. A pocket tap must not be able to do that.
    it('always puts an unlock in front of the two durable grants', () => {
        const auth = byId('drover.allowalwaysautodeny').actions.map(
            (a) => a.options.isAuthenticationRequired
        );
        expect(auth).toEqual([false, true, true, false]);
    });

    it('puts an unlock in front of every allow on a risky gate, and none in front of a refusal', () => {
        const risky = byId('drover.allowdeny.risky').actions;
        expect(risky.map((a) => a.buttonTitle)).toEqual(['Allow', 'Deny']);
        expect(risky.map((a) => a.options.isAuthenticationRequired)).toEqual([true, false]);
        const picks = byId('drover.pick3.risky').actions;
        expect(picks.every((a) => a.options.isAuthenticationRequired)).toBe(true);
    });

    it('answers in the background, and opens the app only for the overflow', () => {
        for (const category of gateNotificationCategories()) {
            for (const action of category.actions) {
                expect(action.options.opensAppToForeground).toBe(
                    action.identifier === moreActionIdentifier
                );
            }
        }
        const more = byId('drover.pickmore').actions.at(-1)!;
        expect(more.identifier).toBe(moreActionIdentifier);
        expect(more.buttonTitle).toBe(gateActionTitles.more);
        expect(more.options.isAuthenticationRequired).toBe(false);
    });

    it('gives a to-do no risky twin, because its buttons run nothing', () => {
        expect(gateCategoryIds()).not.toContain('drover.todo.risky');
    });
});

describe('slotForActionIdentifier', () => {
    it('reads our own slots and nothing else', () => {
        expect(slotForActionIdentifier(actionIdentifierForSlot(0))).toBe(0);
        expect(slotForActionIdentifier(actionIdentifierForSlot(3))).toBe(3);
        expect(slotForActionIdentifier(moreActionIdentifier)).toBeNull();
        // The system's default open and dismiss, which _layout.tsx owns.
        expect(slotForActionIdentifier('expo.modules.notifications.actions.DEFAULT')).toBeNull();
        expect(slotForActionIdentifier('com.apple.UNNotificationDismissActionIdentifier')).toBeNull();
        expect(slotForActionIdentifier(undefined)).toBeNull();
    });
});
