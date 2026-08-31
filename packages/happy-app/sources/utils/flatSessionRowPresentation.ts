import type { SessionState } from '@/sync/sessionState';
import { statusDotColors } from '@/components/statusDotState';

/**
 * THE FLAT ROW'S MARK IS A BADGE, NOT THE SESSION'S DOT (DROVE-243).
 *
 * Worth stating, because it is the one place a session row draws something
 * round and deliberately does NOT speak DROVE-231's vocabulary. This mark sits
 * in the TIMESTAMP slot and replaces it, so it can only ever appear on the few
 * rows that have something to say; a dot that means "connected" would take
 * every row's timestamp away to tell Clay what he can already see. It is the
 * unread badge from any chat list, and the row's status lives elsewhere: the
 * title shimmers while the session works, and it fades when the session is
 * gone.
 *
 * The blocked hue is `statusDotColors.waiting` all the same. That state means
 * the identical thing here and on the strip — the session is holding a
 * permission or a question for Clay — so the amber has one definition even
 * though the mark around it plays a different role.
 */
export const SESSION_READY_DOT_COLOR = '#007AFF';
export const SESSION_BLOCKED_DOT_COLOR = statusDotColors.waiting;

export type FlatSessionRowTopRight =
    | { type: 'dot'; color: string }
    | { type: 'timestamp' };

/**
 * Keeps the flat row's two progress signals mutually exclusive: active work is
 * carried by the title shimmer, while only something the user should notice
 * replaces the ordinary timestamp with a Telegram-sized dot.
 */
export function resolveFlatSessionRowPresentation({
    state,
    hasUnread,
    faded,
}: {
    state: SessionState;
    hasUnread: boolean;
    faded: boolean;
}): {
    shimmerTitle: boolean;
    topRight: FlatSessionRowTopRight;
} {
    if (faded) {
        return { shimmerTitle: false, topRight: { type: 'timestamp' } };
    }

    if (state === 'permission_required' || state === 'input_required') {
        return {
            shimmerTitle: false,
            topRight: { type: 'dot', color: SESSION_BLOCKED_DOT_COLOR },
        };
    }

    if (state === 'thinking') {
        return { shimmerTitle: true, topRight: { type: 'timestamp' } };
    }

    if (hasUnread) {
        return {
            shimmerTitle: false,
            topRight: { type: 'dot', color: SESSION_READY_DOT_COLOR },
        };
    }

    return { shimmerTitle: false, topRight: { type: 'timestamp' } };
}