import { describe, expect, it } from 'vitest';
import { readingCycleFrom } from './readingCycle';
import type { Session } from '@/sync/storageTypes';

function session(id: string, over: Record<string, unknown> = {}): Session {
    return {
        id,
        active: true,
        createdAt: 0,
        lastMessageSentAt: 0,
        metadata: null,
        ...over,
    } as unknown as Session;
}

function cycle(...sessions: Session[]): string[] {
    const map: Record<string, Session> = {};
    for (const s of sessions) map[s.id] = s;
    return readingCycleFrom(map);
}

describe('which sessions the double press walks, until DROVE-297 says', () => {
    it('puts the live sessions in the chat list order, newest activity first', () => {
        // The ear and the screen have to agree about what "next" means, or the
        // gesture is a lottery.
        expect(cycle(
            session('old', { lastMessageSentAt: 10 }),
            session('new', { lastMessageSentAt: 30 }),
            session('mid', { lastMessageSentAt: 20 }),
        )).toEqual(['new', 'mid', 'old']);
    });

    it('puts active sessions ahead of quiet ones however recently they spoke', () => {
        // Same comparator buildSessionListViewData uses. A session still doing
        // work is the one worth skipping to.
        expect(cycle(
            // A rig session that merely lost its connection is still live
            // work, which is why isSessionArchived's second clause is not
            // just `!active`.
            session('quiet', { active: false, lastMessageSentAt: 99, metadata: { client: { id: 'rig' } } }),
            session('busy', { active: true, lastMessageSentAt: 1 }),
        )).toEqual(['busy', 'quiet']);
    });

    it('leaves out side chats', () => {
        // Hidden children of another session. Handing the voice to one would
        // read a panel he cannot see.
        expect(cycle(
            session('main'),
            session('side', { metadata: { isSideChat: true } }),
        )).toEqual(['main']);
    });

    it('leaves out the Cattle Drover bridge', () => {
        // A mailbox for gate cards, not a conversation (DROVE-238).
        expect(cycle(
            session('main'),
            session('bridge', { metadata: { droverBridge: true } }),
        )).toEqual(['main']);
    });

    it('leaves out archived sessions', () => {
        // Finished work. Cycling a hundred of them to reach the two he is
        // running is the one way a next-track button is worse than none.
        expect(cycle(
            session('live'),
            session('done', { metadata: { lifecycleState: 'archived' } }),
        )).toEqual(['live']);
    });

    it('is empty when there is nothing to listen to', () => {
        // nextSessionMove turns this into a refusal, never a stop.
        expect(cycle()).toEqual([]);
        expect(cycle(session('side', { metadata: { isSideChat: true } }))).toEqual([]);
    });

    it('reads nothing but the sessions it is handed', () => {
        // Foreground/background parity: no store, no navigation, no mounted
        // screen. The same map gives the same cycle wherever it is called.
        const sessions = { a: session('a'), b: session('b', { lastMessageSentAt: 5 }) };
        expect(readingCycleFrom(sessions)).toEqual(readingCycleFrom(sessions));
    });
});
