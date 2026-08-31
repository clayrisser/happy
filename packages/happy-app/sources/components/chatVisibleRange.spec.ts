import { describe, expect, it } from 'vitest';
import type { DisplayItem } from '@/hooks/useGroupedMessages';
import { visibleRangeOf } from './chatVisibleRange';

function message(id: string, createdAt: number): DisplayItem {
    return { type: 'message', id, message: { kind: 'agent-text', id, localId: null, createdAt, text: 'x' } } as DisplayItem;
}

function group(id: string, createdAts: number[]): DisplayItem {
    return {
        type: 'tool-group',
        id,
        messages: createdAts.map((createdAt, i) => ({ kind: 'tool-call', id: `${id}-${i}`, localId: null, createdAt })),
        hasRunning: false,
        hasError: false,
        hasPendingPermission: false,
    } as DisplayItem;
}

describe('what the chat list can see (DROVE-114)', () => {
    it('reads oldest and newest off the stamps, not off the order', () => {
        // The list is INVERTED, so viewable items arrive newest first. Taking
        // the min and the max means no call site has to remember that.
        const range = visibleRangeOf([message('c', 30), message('b', 20), message('a', 10)], false);
        expect(range).toEqual({ oldestCreatedAt: 10, newestCreatedAt: 30, atLiveEdge: false });
    });

    it('a folded group covers every message inside it', () => {
        const range = visibleRangeOf([group('g', [11, 12, 13]), message('a', 10)], false);
        expect(range).toEqual({ oldestCreatedAt: 10, newestCreatedAt: 13, atLiveEdge: false });
    });

    it('an empty viewport is nothing rather than a range of nothing', () => {
        expect(visibleRangeOf([], false)).toBeNull();
    });

    it('carries the live edge through untouched', () => {
        expect(visibleRangeOf([message('a', 10)], true)?.atLiveEdge).toBe(true);
    });
});
