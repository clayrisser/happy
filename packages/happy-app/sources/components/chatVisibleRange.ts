import type { DisplayItem } from '@/hooks/useGroupedMessages';
import type { VisibleRange } from '@/voice/readAloudSeek';

/**
 * What the chat list can see, as the two createdAt stamps the read-aloud
 * playhead is steered by (DROVE-114).
 *
 * The list is INVERTED, so index 0 is the newest message and "first viewable
 * item" means the one at the visual BOTTOM. Rather than remember that at every
 * call site, this takes the min and the max over everything visible: oldest is
 * the visual top and newest is the visual bottom whichever way the indices run,
 * and a folded tool group contributes all of its messages, so a group standing
 * where a reply used to be still covers that reply's stamps.
 */
export function displayItemCreatedAts(item: DisplayItem): number[] {
    if (item.type === 'message') return [item.message.createdAt];
    return item.messages.map((message) => message.createdAt);
}

export function visibleRangeOf(items: readonly DisplayItem[], atLiveEdge: boolean): VisibleRange | null {
    let oldest = Number.POSITIVE_INFINITY;
    let newest = Number.NEGATIVE_INFINITY;
    for (const item of items) {
        for (const createdAt of displayItemCreatedAts(item)) {
            if (!Number.isFinite(createdAt)) continue;
            if (createdAt < oldest) oldest = createdAt;
            if (createdAt > newest) newest = createdAt;
        }
    }
    if (oldest === Number.POSITIVE_INFINITY) return null;
    return { oldestCreatedAt: oldest, newestCreatedAt: newest, atLiveEdge };
}
