import { isSessionArchived } from '@/sync/sessionArchive';
import { isDroverBridgeSession } from '@/sync/droverBridgeSession';
import { getSessionActivityAt } from '@/utils/sessionActivity';
import type { Session } from '@/sync/storageTypes';

/**
 * WHICH SESSIONS THE DOUBLE PRESS WALKS (DROVE-300).
 *
 * ## Membership is DROVE-297's, and this file does not second-guess it
 *
 * "Reading enabled" is per session since DROVE-297, and `armed` is that switch
 * asked one session at a time — `readAloud.isSessionEnabled`, which already
 * folds in the master default and a boss-mode suspension. Nothing here
 * re-derives it, which is what keeps the ear and the session list from coming
 * to different answers about who is armed.
 *
 * WHAT THIS FILE ADDS is the ORDER, and the three kinds of row that are not a
 * conversation he can listen to at all:
 *
 *   SIDE CHATS are hidden children of another session and never appear in any
 *   list; handing the voice to one would read a panel he cannot see.
 *   THE CATTLE DROVER BRIDGE is a mailbox for gate cards, not a conversation
 *   (DROVE-238). It is never active and its rows are read elsewhere.
 *   ARCHIVED SESSIONS are finished work. Cycling through a hundred of them to
 *   reach the two he is running would make the gesture useless, which is the
 *   one way a next-track button can be worse than no button.
 *
 * Those three are dropped BEFORE `armed` is consulted rather than after, so a
 * default-on phone does not walk its whole archive. They are a property of the
 * row, not of his switch, which is why they live here and not in DROVE-297.
 *
 * ORDER IS THE CHAT LIST'S OWN, so the ear and the screen agree about what
 * "next" means: active first, then by last meaningful activity, newest first.
 * That is `buildSessionListViewData`'s comparator with the project grouping
 * taken off — the grouping is a layout, not an order, and a press cannot walk
 * a header row.
 *
 * Pure, and takes `armed` as an argument rather than reaching for the reader,
 * so the whole cycle is testable with no reader, no store and no screen — the
 * same reason nextSession.ts is pure. The press arrives with the phone in his
 * pocket and nothing on this path may be able to tell.
 */
export function readingCycleFrom(
    sessions: Record<string, Session>,
    armed: (sessionId: string) => boolean,
): string[] {
    const live: Session[] = [];
    for (const session of Object.values(sessions)) {
        if (session.metadata?.isSideChat) continue;
        if (isDroverBridgeSession(session)) continue;
        if (isSessionArchived(session)) continue;
        if (!armed(session.id)) continue;
        live.push(session);
    }
    live.sort((a, b) => {
        const activeDelta = Number(b.active) - Number(a.active);
        return activeDelta !== 0 ? activeDelta : getSessionActivityAt(b) - getSessionActivityAt(a);
    });
    return live.map((session) => session.id);
}
