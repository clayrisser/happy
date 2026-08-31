import { describe, expect, it, vi } from 'vitest';

// storage.ts pulls in React Native, and droverGates only touches it for the
// default argument. Every test below passes sessions explicitly.
vi.mock('@/sync/storage', () => ({
    storage: { getState: () => ({ sessions: {} }) },
}));

import { gatesForSession, inboxCounts, type GateSession } from '@/sync/droverGates';
import { describePendingGates } from './pendingGatesSummary';
import {
    clampIndex,
    createGateOverlayDismissals,
    createGateOverlayFocus,
    focusIndex,
    overlayCounter,
    overlayDeck,
    pageForOffset,
    stepIndex,
    swipeDismisses,
} from './sessionGateDeck';

/**
 * DROVE-88. The gate overlay's decisions, made without a screen: which cards
 * are in the stack, which one is in view, and what a dismissal does and does
 * not touch.
 *
 * The requests are the shapes happy-cli's requestForEvent writes for a to-do,
 * a question and a permission, fed through the same gatesForSession the
 * overlay's hook reads, so the deck below is the deck the phone would draw.
 */

const claudeSessionId = '3e9d3a1c-6d7e-4a2f-9e44-0f9a2f9c1d11';
const bridge = 'bridge-session';
const pane = 'pane-session';

const todoRequest = {
    tool: 'DroverTodo',
    arguments: {
        title: 'Archive TestFlight build 8',
        reason: 'The watch work is Swift and can never ship over the air',
        options: [{ id: 'done', label: 'Done' }, { id: 'drop', label: 'Drop it' }],
    },
    createdAt: 1000,
    droverOrigin: { sessionId: claudeSessionId, cwd: '/w/happy' },
    droverEvent: { kind: 'todo' as const, title: 'Archive TestFlight build 8', createdAt: 1000 },
};

const questionRequest = {
    tool: 'AskUserQuestion',
    arguments: {
        questions: [{
            header: 'Flip?',
            question: 'Move this session to work-2?',
            options: [{ label: 'Yes, flip it' }, { label: 'Stay' }],
            multiSelect: false,
        }],
    },
    createdAt: 2000,
    droverOrigin: { sessionId: claudeSessionId, cwd: '/w/happy' },
    droverEvent: { kind: 'question' as const, title: 'Flip?', createdAt: 2000 },
};

const permissionRequest = {
    tool: 'Bash',
    arguments: { command: 'rm -rf dist', description: 'Clean the build' },
    createdAt: 3000,
    droverOrigin: { sessionId: claudeSessionId, cwd: '/w/happy' },
    droverEvent: { kind: 'permission' as const, title: 'Run Bash', createdAt: 3000 },
};

function sessionsWith(requests: Record<string, unknown>): Record<string, GateSession> {
    return {
        [bridge]: { agentState: { requests }, metadata: { path: '/w/happy' } },
        [pane]: { agentState: { requests: {} }, metadata: { path: '/w/happy', claudeSessionId } },
    };
}

const threeGates = gatesForSession(
    sessionsWith({ t1: todoRequest, q1: questionRequest, p1: permissionRequest }),
    pane,
);

describe('SessionGateOverlay stack', () => {
    it('stacks every pending gate into one deck, oldest first, and counts it in the title', () => {
        const deck = overlayDeck(threeGates, new Set(), 0);
        expect(deck.count).toBe(3);
        expect(deck.cards.map((card) => card.tool)).toEqual(['DroverTodo', 'AskUserQuestion', 'Bash']);
        expect(describePendingGates(deck.cards.map((card) => card.gate))?.title)
            .toBe('3 waiting: 1 to-do, 1 question, 1 permission');
    });

    it('shows a position counter only when there is a stack', () => {
        expect(overlayCounter(0, 1)).toBeNull();
        expect(overlayCounter(0, 3)).toBe('1 of 3');
        expect(overlayCounter(2, 3)).toBe('3 of 3');
        // A stale index past the end reads as the last card, never "4 of 3".
        expect(overlayCounter(7, 3)).toBe('3 of 3');
    });

    it('swipes between cards without wrapping', () => {
        expect(stepIndex(0, 3, 1)).toBe(1);
        expect(stepIndex(1, 3, 1)).toBe(2);
        expect(stepIndex(2, 3, 1)).toBe(2);
        expect(stepIndex(0, 3, -1)).toBe(0);
        expect(stepIndex(0, 0, 1)).toBe(0);
    });

    it('lands a paging scroll on the nearest card', () => {
        expect(pageForOffset(0, 360, 3)).toBe(0);
        expect(pageForOffset(359, 360, 3)).toBe(1);
        expect(pageForOffset(722, 360, 3)).toBe(2);
        expect(pageForOffset(2000, 360, 3)).toBe(2);
        expect(pageForOffset(100, 0, 3)).toBe(0);
    });

    it('keeps the index inside the deck', () => {
        expect(clampIndex(-1, 3)).toBe(0);
        expect(clampIndex(1.7, 3)).toBe(1);
        expect(clampIndex(5, 3)).toBe(2);
        expect(clampIndex(0, 0)).toBe(0);
        expect(clampIndex(Number.NaN, 3)).toBe(0);
    });

    it('slides the next card into view when the one in view is answered', () => {
        // The question at index 1 is answered: the bus drops it, the deck is
        // rebuilt from what is left, and index 1 is now the permission.
        const afterAnswer = threeGates.filter((entry) => entry.tool !== 'AskUserQuestion');
        const deck = overlayDeck(afterAnswer, new Set(), 1);
        expect(deck.index).toBe(1);
        expect(deck.cards[deck.index].tool).toBe('Bash');

        // Answering the LAST card pulls the index back onto the new last card.
        const afterLast = threeGates.filter((entry) => entry.tool !== 'Bash');
        expect(overlayDeck(afterLast, new Set(), 2).index).toBe(1);
    });
});

describe('SessionGateOverlay dismiss to inbox', () => {
    it('takes a dismissed gate out of the deck and leaves the rest', () => {
        const dismissals = createGateOverlayDismissals();
        dismissals.dismiss([threeGates[1].gate.id]);
        const deck = overlayDeck(threeGates, dismissals.get(), 1);
        expect(deck.count).toBe(2);
        expect(deck.cards.map((card) => card.tool)).toEqual(['DroverTodo', 'Bash']);
        expect(deck.cards[deck.index].tool).toBe('Bash');
    });

    it('empties the overlay when the last card is dismissed, without touching the gate', () => {
        const dismissals = createGateOverlayDismissals();
        const one = gatesForSession(sessionsWith({ p1: permissionRequest }), pane);
        dismissals.dismiss([one[0].gate.id]);
        expect(overlayDeck(one, dismissals.get(), 0).count).toBe(0);
        // Still pending as far as the hook that reads the bus is concerned.
        expect(one).toHaveLength(1);
    });

    it('keeps counting a dismissed gate on the longhorn', () => {
        // The badge reads the pending entries, not the overlay's set, so
        // putting a card away changes nothing it shows. That is the whole
        // point of dismissing to the inbox rather than answering.
        const dismissals = createGateOverlayDismissals();
        const before = inboxCounts(threeGates);
        dismissals.dismiss(threeGates.map((entry) => entry.gate.id));
        expect(overlayDeck(threeGates, dismissals.get(), 0).count).toBe(0);
        expect(inboxCounts(threeGates)).toEqual(before);
        expect(before.prompts).toBe(2);
        expect(before.todos).toBe(1);
    });

    it('publishes a snapshot per real change and nothing for a repeat', () => {
        const dismissals = createGateOverlayDismissals();
        const seen: number[] = [];
        const stop = dismissals.subscribe(() => seen.push(dismissals.get().size));
        const first = dismissals.get();
        dismissals.dismiss(['a']);
        const second = dismissals.get();
        dismissals.dismiss(['a']);
        expect(dismissals.get()).toBe(second);
        expect(first).not.toBe(second);
        dismissals.dismiss(['a', 'b']);
        expect(seen).toEqual([1, 2]);
        stop();
        dismissals.dismiss(['c']);
        expect(seen).toEqual([1, 2]);
        expect([...dismissals.get()].sort()).toEqual(['a', 'b', 'c']);
    });

    it('is shared across sessions but forgotten on relaunch', () => {
        const dismissals = createGateOverlayDismissals();
        dismissals.dismiss([threeGates[0].gate.id]);
        // Another screen reading the same store sees the same dismissal.
        expect(overlayDeck(threeGates, dismissals.get(), 0).count).toBe(2);
        dismissals.reset();
        expect(overlayDeck(threeGates, dismissals.get(), 0).count).toBe(3);
    });
});

describe('SessionGateOverlay swipe-down', () => {
    it('dismisses on a long drag or a fast flick, never on a drag upward', () => {
        expect(swipeDismisses(80, 0)).toBe(true);
        expect(swipeDismisses(20, 900)).toBe(true);
        expect(swipeDismisses(20, 100)).toBe(false);
        expect(swipeDismisses(-80, 900)).toBe(false);
        expect(swipeDismisses(0, 0)).toBe(false);
    });
});

describe('SessionGateOverlay focus from a push tap', () => {
    // DROVE-94. A tap on a gate push opens the raising session with `?gate=`,
    // and the overlay has to page to that card, whatever was swiped away.
    it('finds the card by its bus event id, which is what the push carries', () => {
        // The store keys the card `${session}:${event}`; the push carries the
        // event id alone.
        expect(focusIndex(threeGates, new Set(), 'q1')).toBe(1);
        expect(focusIndex(threeGates, new Set(), `${bridge}:p1`)).toBe(2);
    });

    it('counts the index against the deck the overlay will draw, dismissed cards gone', () => {
        const dismissed = new Set([threeGates[0].gate.id]);
        expect(focusIndex(threeGates, dismissed, 'p1')).toBe(1);
    });

    it('brings a dismissed gate back for the tap that asked for it', () => {
        const dismissed = new Set([threeGates[1].gate.id]);
        expect(focusIndex(threeGates, dismissed, 'q1')).toBe(1);
    });

    it('answers -1 for a gate this session does not list, so the request waits', () => {
        expect(focusIndex(threeGates, new Set(), 'nope')).toBe(-1);
        expect(focusIndex([], new Set(), 'q1')).toBe(-1);
    });

    it('restores a dismissed card and publishes once, nothing for a card that was not dismissed', () => {
        const dismissals = createGateOverlayDismissals();
        let published = 0;
        dismissals.subscribe(() => { published += 1; });
        dismissals.dismiss([threeGates[1].gate.id, threeGates[2].gate.id]);
        dismissals.restore([threeGates[1].gate.id]);
        expect(dismissals.get().has(threeGates[1].gate.id)).toBe(false);
        expect(dismissals.get().has(threeGates[2].gate.id)).toBe(true);
        expect(published).toBe(2);
        dismissals.restore(['never-dismissed']);
        expect(published).toBe(2);
    });

    it('holds one request until the overlay it is for consumes it', () => {
        const focus = createGateOverlayFocus();
        let published = 0;
        focus.subscribe(() => { published += 1; });
        focus.request({ sessionId: pane, gateId: 'q1' });
        const held = focus.get();
        expect(held).toEqual({ sessionId: pane, gateId: 'q1' });
        // The same ask twice is one request, so a re-render of the route
        // cannot re-page a card the reader has moved off.
        focus.request({ sessionId: pane, gateId: 'q1' });
        expect(published).toBe(1);
        // A newer tap replaces an older one that never landed.
        focus.request({ sessionId: pane, gateId: 'p1' });
        const newer = focus.get();
        expect(newer?.gateId).toBe('p1');
        // Clearing the OLD request does nothing to the new one.
        focus.clear(held!);
        expect(focus.get()).toBe(newer);
        focus.clear(newer!);
        expect(focus.get()).toBeNull();
    });
});
