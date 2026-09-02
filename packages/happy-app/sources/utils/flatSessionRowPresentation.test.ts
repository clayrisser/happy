import { describe, expect, it } from 'vitest';

import {
    resolveFlatSessionRowPresentation,
    SESSION_BLOCKED_ACCENT,
    SESSION_UNREAD_ACCENT,
} from './flatSessionRowPresentation';

describe('resolveFlatSessionRowPresentation', () => {
    it('shimmers active work and keeps its timestamp plain', () => {
        expect(resolveFlatSessionRowPresentation({
            state: 'thinking',
            hasUnread: false,
            faded: false,
        })).toEqual({
            shimmerTitle: true,
            time: { type: 'plain' },
        });
    });

    it('tints the time blue once an unread result is ready', () => {
        expect(resolveFlatSessionRowPresentation({
            state: 'waiting',
            hasUnread: true,
            faded: false,
        })).toEqual({
            shimmerTitle: false,
            time: { type: 'accented', color: SESSION_UNREAD_ACCENT },
        });
    });

    it.each(['permission_required', 'input_required'] as const)(
        'tints the same stamp orange for %s',
        (state) => {
            expect(resolveFlatSessionRowPresentation({
                state,
                hasUnread: true,
                faded: false,
            })).toEqual({
                shimmerTitle: false,
                time: { type: 'accented', color: SESSION_BLOCKED_ACCENT },
            });
        },
    );

    it('leaves the timestamp plain for ordinary and faded rows', () => {
        expect(resolveFlatSessionRowPresentation({
            state: 'waiting',
            hasUnread: false,
            faded: false,
        }).time).toEqual({ type: 'plain' });

        expect(resolveFlatSessionRowPresentation({
            state: 'permission_required',
            hasUnread: true,
            faded: true,
        })).toEqual({
            shimmerTitle: false,
            time: { type: 'plain' },
        });
    });

    // DROVE-398: the 20pt badge that replaced the time is gone. Whatever the
    // row has to say, it says on the stamp; there is no shape for "draw a
    // mark instead of the time" any more.
    it('never asks for anything in the time slot but the time', () => {
        const states = ['disconnected', 'thinking', 'waiting', 'permission_required', 'input_required'] as const;
        for (const state of states) {
            for (const hasUnread of [false, true]) {
                for (const faded of [false, true]) {
                    const { time } = resolveFlatSessionRowPresentation({ state, hasUnread, faded });
                    expect(['accented', 'plain'], `${state} unread=${hasUnread} faded=${faded}`).toContain(time.type);
                }
            }
        }
    });
});
