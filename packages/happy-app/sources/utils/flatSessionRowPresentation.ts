import type { SessionState } from '@/sync/sessionState';
import { statusDotColors } from '@/components/statusDotState';

/**
 * THE FLAT ROW'S SIGNAL RIDES ON THE TIME, NOT ON A DOT (DROVE-243, DROVE-398).
 *
 * Worth stating, because it is the one place a session row colours something
 * that is not the dot and deliberately does NOT speak DROVE-231's vocabulary
 * through a disc. This used to be a 20pt badge that REPLACED the time, the
 * unread mark from any chat list. Then DROVE-393 put the row's real status
 * dot on the same row, and a row with unread wore both: a 6pt dot saying
 * `connected` beside a 20pt disc saying `unread`. Clay: "why the fuck did the
 * dot get so big." So the badge is gone, the dot is drawn once (in the
 * trailing slot, sessionRowTrailingLayout.ts), and what the badge used to say
 * is said by the TIME'S COLOUR instead, the way a chat list tints the stamp
 * on a row you have not read. A row with no stamp has nowhere to say it and
 * says nothing: the edge stays empty rather than growing a mark.
 *
 * The blocked hue is `statusDotColors.waiting` all the same. That state means
 * the identical thing here and on the strip — the session is holding a
 * permission or a question for Clay — so the amber has one definition even
 * though the stamp around it plays a different role. It is louder than the
 * dot on purpose: with the badge gone, the tinted stamp is the row's one
 * attention signal, and a gate outranks unread the way it always did.
 */
export const SESSION_UNREAD_ACCENT = '#007AFF';
export const SESSION_BLOCKED_ACCENT = statusDotColors.waiting;

export type FlatSessionRowTime =
    | { type: 'accented'; color: string }
    | { type: 'plain' };

/**
 * Keeps the flat row's two progress signals mutually exclusive: active work is
 * carried by the title shimmer, while only something the user should notice
 * tints the ordinary timestamp.
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
    time: FlatSessionRowTime;
} {
    if (faded) {
        return { shimmerTitle: false, time: { type: 'plain' } };
    }

    if (state === 'permission_required' || state === 'input_required') {
        return {
            shimmerTitle: false,
            time: { type: 'accented', color: SESSION_BLOCKED_ACCENT },
        };
    }

    if (state === 'thinking') {
        return { shimmerTitle: true, time: { type: 'plain' } };
    }

    if (hasUnread) {
        return {
            shimmerTitle: false,
            time: { type: 'accented', color: SESSION_UNREAD_ACCENT },
        };
    }

    return { shimmerTitle: false, time: { type: 'plain' } };
}
