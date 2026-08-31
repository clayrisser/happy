import { beforeEach, describe, expect, it, vi } from 'vitest';

// react-native-mmkv needs a native/web backend; back it with a plain map.
const store = new Map<string, string>();
vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        getString(key: string) { return store.get(key); }
        set(key: string, value: string) { store.set(key, value); }
        delete(key: string) { store.delete(key); }
        clearAll() { store.clear(); }
    },
}));

const {
    actionsFromData,
    clearGateAnswers,
    enqueueGateAnswer,
    forgetGateAnswer,
    gateAnswerCall,
    parseGateNotificationAction,
    pendingGateAnswers,
} = await import('./droverNotificationAnswer');

function response(over: {
    actionIdentifier?: string;
    data?: unknown;
} = {}) {
    return {
        actionIdentifier: over.actionIdentifier ?? 'drover.act.0',
        notification: {
            date: 1_700_000_000,
            request: {
                identifier: 'req-1',
                content: {
                    data:
                        over.data === undefined
                            ? {
                                  gateId: 'gate-1',
                                  answerSessionId: 'bridge-session',
                                  sessionId: 'raising-session',
                                  kind: 'permission',
                                  actions: JSON.stringify(['allow', 'deny']),
                              }
                            : over.data,
                },
            },
        },
    };
}

describe('parseGateNotificationAction', () => {
    it('reads the option a slot answers with', () => {
        expect(parseGateNotificationAction(response(), 42)).toEqual({
            gateId: 'gate-1',
            sessionId: 'bridge-session',
            optionId: 'allow',
            kind: 'permission',
            at: 42,
        });
        expect(parseGateNotificationAction(response({ actionIdentifier: 'drover.act.1' }))?.optionId)
            .toBe('deny');
    });

    // The session that RAISED the gate and the session HOLDING the card are
    // different for every drover gate. A tap navigates to the first; a button
    // answers the second, and answering the first addresses the RPC to an
    // agent with no such request.
    it('answers the holding session, never the raising one', () => {
        expect(parseGateNotificationAction(response())?.sessionId).toBe('bridge-session');
    });

    it('says nothing for a tap, a dismiss or the overflow button', () => {
        expect(parseGateNotificationAction(response({ actionIdentifier: 'expo.modules.notifications.actions.DEFAULT' }))).toBeNull();
        expect(parseGateNotificationAction(response({ actionIdentifier: 'drover.act.more' }))).toBeNull();
    });

    it('says nothing for a slot the payload has no option for', () => {
        // The overflow slot answers nothing on purpose: the CLI packs '' there.
        expect(
            parseGateNotificationAction(
                response({
                    actionIdentifier: 'drover.act.3',
                    data: {
                        gateId: 'g',
                        answerSessionId: 's',
                        kind: 'question',
                        actions: JSON.stringify(['a', 'b', 'c', '']),
                    },
                })
            )
        ).toBeNull();
    });

    it('says nothing for a push from before this feature', () => {
        expect(
            parseGateNotificationAction(
                response({ data: { gateId: 'g', answerSessionId: 's', kind: 'permission' } })
            )
        ).toBeNull();
    });

    it('takes the payload as a JSON string too, the way a tap route does', () => {
        const answer = parseGateNotificationAction(
            response({
                data: JSON.stringify({
                    gateId: 'gate-2',
                    answerSessionId: 'bridge',
                    kind: 'question',
                    actions: ['1', '2', '3', '4'],
                }),
            })
        );
        expect(answer?.gateId).toBe('gate-2');
        expect(answer?.optionId).toBe('1');
        expect(answer?.kind).toBe('question');
    });

    it('reads actions whether they arrive as JSON or as an array', () => {
        expect(actionsFromData({ actions: '["a","b"]' })).toEqual(['a', 'b']);
        expect(actionsFromData({ actions: ['a', 'b'] })).toEqual(['a', 'b']);
        expect(actionsFromData({ actions: 'not json' })).toEqual([]);
        expect(actionsFromData({})).toEqual([]);
    });
});

describe('the durable queue', () => {
    beforeEach(() => {
        store.clear();
        clearGateAnswers();
    });

    // The write happens BEFORE the send, which is what makes an answer survive
    // iOS killing the background launch a second after the tap.
    it('keeps an answer until it is acknowledged', () => {
        const answer = parseGateNotificationAction(response(), 1000)!;
        expect(enqueueGateAnswer(answer, 1000)).toBe(true);
        expect(pendingGateAnswers(1000)).toHaveLength(1);
        forgetGateAnswer('gate-1');
        expect(pendingGateAnswers(1000)).toHaveLength(0);
    });

    // The LOCAL half of single resolution. The bus is the arbiter across
    // surfaces (first resolve wins, the loser gets 409); this is what stops one
    // surface from sending twice.
    it('queues a gate at most once, so a double tap is one send', () => {
        const answer = parseGateNotificationAction(response(), 1000)!;
        expect(enqueueGateAnswer(answer, 1000)).toBe(true);
        expect(enqueueGateAnswer({ ...answer, optionId: 'deny' }, 1500)).toBe(false);
        expect(pendingGateAnswers(1500)).toEqual([answer]);
    });

    it('drops an answer too old to be worth sending', () => {
        const answer = parseGateNotificationAction(response(), 0)!;
        enqueueGateAnswer(answer, 0);
        expect(pendingGateAnswers(7 * 60 * 60 * 1000)).toHaveLength(0);
    });
});

describe('gateAnswerCall', () => {
    // busResolutionFor reads `approved` for a permission and ignores optionId
    // there, because the bridge's Bash card carries no options at all.
    it('allows and denies a permission, rather than naming an option', () => {
        expect(
            gateAnswerCall({ gateId: 'g', sessionId: 's', optionId: 'allow', kind: 'permission', at: 0 })
        ).toEqual({
            call: 'allow',
            sessionId: 's',
            requestId: 'g',
            updatedInput: { via: 'push', channel: 'visual' },
        });
        expect(
            gateAnswerCall({ gateId: 'g', sessionId: 's', optionId: 'deny', kind: 'permission', at: 0 })
        ).toEqual({ call: 'deny', sessionId: 's', requestId: 'g' });
    });

    // A question resolves with action=option or not at all, and a to-do that a
    // generic approve could close is what DROVE-69 fixed.
    it('names the option for a question and a to-do', () => {
        expect(
            gateAnswerCall({ gateId: 'g', sessionId: 's', optionId: '3', kind: 'question', at: 0 })
        ).toEqual({
            call: 'answer',
            sessionId: 's',
            requestId: 'g',
            updatedInput: { optionId: '3', via: 'push', channel: 'visual' },
        });
        expect(
            gateAnswerCall({ gateId: 'g', sessionId: 's', optionId: 'drop', kind: 'todo', at: 0 })
                .call
        ).toBe('answer');
    });

    // The bus ledger has to be able to say WHICH surface won the race, and a
    // banner is neither the app nor the wrist.
    it('stamps the banner as its own surface', () => {
        const call = gateAnswerCall({
            gateId: 'g',
            sessionId: 's',
            optionId: '1',
            kind: 'question',
            at: 0,
        });
        expect(call.call === 'answer' && call.updatedInput.via).toBe('push');
    });
});
