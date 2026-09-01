import { isSessionArchived } from '@/sync/sessionArchive';
import { isDroverBridgeSession } from '@/sync/droverBridgeSession';
import { getSessionActivityAt } from '@/utils/sessionActivity';
import type { Session } from '@/sync/storageTypes';

/**
 * WHICH SESSIONS THE DOUBLE PRESS WALKS, until DROVE-297 says (DROVE-300).
 *
 * ## This file is a placeholder, and it says so at the top on purpose
 *
 * "The next session that has reading enabled" is DROVE-297's rule. That
 * ticket is building per-session enablement and exporting the policy, and
 * nextSession.ts consumes it through one port (`cycle()`) precisely so there
 * is never a second copy of the semantics. DROVE-297 had not landed when this
 * shipped, so this is what fills that port in the meantime.
 *
 * WHEN DROVE-297 LANDS: point `cycle` in readAloudService.ts at its export and
 * DELETE THIS FILE. Nothing in nextSession.ts changes and neither do its
 * tests, which is the whole reason the port is shaped the way it is.
 *
 * ## Why this is the honest fallback rather than an invented one
 *
 * Today there is exactly one read-aloud switch and it is GLOBAL:
 * `readAloudEnabled` in localSettings, driven into the reader by
 * `readAloud.setEnabled` from whichever composer has focus. There is no
 * per-session flag anywhere — I grepped for one. So under today's model the
 * true answer to "which sessions have reading enabled" is: with the switch
 * on, every session he could focus, because focusing one is what makes it
 * read.
 *
 * That is what this returns, minus the three kinds of row that are not a
 * conversation he can listen to:
 *
 *   SIDE CHATS are hidden children of another session and never appear in any
 *   list; handing the voice to one would read a panel he cannot see.
 *   THE CATTLE DROVER BRIDGE is a mailbox for gate cards, not a conversation
 *   (DROVE-238). It is never active and its rows are read elsewhere.
 *   ARCHIVED SESSIONS are finished work. Cycling through a hundred of them to
 *   reach the two he is running would make the gesture useless, which is the
 *   one way a next-track button can be worse than no button.
 *
 * ORDER IS THE CHAT LIST'S OWN, so the ear and the screen agree about what
 * "next" means: active first, then by last meaningful activity, newest first.
 * That is `buildSessionListViewData`'s comparator with the project grouping
 * taken off — the grouping is a layout, not an order, and a press cannot walk
 * a header row.
 */
export function readingCycleFrom(sessions: Record<string, Session>): string[] {
    const live: Session[] = [];
    for (const session of Object.values(sessions)) {
        if (session.metadata?.isSideChat) continue;
        if (isDroverBridgeSession(session)) continue;
        if (isSessionArchived(session)) continue;
        live.push(session);
    }
    live.sort((a, b) => {
        const activeDelta = Number(b.active) - Number(a.active);
        return activeDelta !== 0 ? activeDelta : getSessionActivityAt(b) - getSessionActivityAt(a);
    });
    return live.map((session) => session.id);
}
