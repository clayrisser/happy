import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";

const {
    state,
    dbMock,
    pushSendMock,
    resetState
} = vi.hoisted(() => {
    const state = {
        sessions: [] as Array<{ id: string; accountId: string }>,
        tokens: [] as Array<{ id: string; token: string }>,
        // Sockets the presence check sees, as socket.data shapes.
        sockets: [] as Array<{ data: Record<string, unknown> }>,
        sent: [] as Array<{
            to: string;
            title?: string;
            priority?: string;
            contentAvailable?: boolean;
            _contentAvailable?: boolean;
            interruptionLevel?: string;
        }>,
        ticketOverride: null as null | Array<{ status: 'ok' | 'error'; message?: string; details?: { error?: string } }>,
        presenceError: null as string | null,
    };

    const resetState = () => {
        state.sessions = [];
        state.tokens = [];
        state.sockets = [];
        state.sent = [];
        state.ticketOverride = null;
        state.presenceError = null;
    };

    const dbMock = {
        session: {
            findFirst: vi.fn(async ({ where }: any) =>
                state.sessions.find(s => s.id === where.id && s.accountId === where.accountId) ?? null)
        },
        accountPushToken: {
            findMany: vi.fn(async () => state.tokens),
            deleteMany: vi.fn(async () => ({ count: 0 }))
        }
    };

    const pushSendMock = vi.fn(async (messages: typeof state.sent) => {
        state.sent.push(...messages);
        return state.ticketOverride ?? messages.map(() => ({ status: 'ok' as const }));
    });

    return { state, dbMock, pushSendMock, resetState };
});

vi.mock("@/storage/db", () => ({ db: dbMock }));
vi.mock("@/app/push/pushSend", () => ({ sendPushNotifications: pushSendMock }));

// The real eventRouter is used so these tests exercise the production presence
// rule end to end — a regression in hasActiveUiClient fails them. Only the
// socket.io server is stubbed: `state.sockets` is what fetchSockets returns,
// and emit paths are swallowed.
import { ACTIVE_CLAIM_TTL_MS, eventRouter } from "@/app/events/eventRouter";
import { pushThrottleReset } from "@/app/push/pushThrottle";
import { pushRoutes } from "./pushRoutes";

function stubIo() {
    const room = {
        timeout: () => room,
        fetchSockets: async () => {
            if (state.presenceError) throw new Error(state.presenceError);
            return state.sockets;
        },
        emit: () => undefined
    };
    return { in: () => room, to: () => room, except: () => room } as any;
}

const USER = "user-1";
const SESSION = "session-1";

async function buildApp(): Promise<Fastify> {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any) => { request.userId = USER; });
    pushRoutes(typed);
    await typed.ready();
    return typed;
}

async function postPushEvent(app: Fastify, sessionId = SESSION) {
    return app.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/push-event`,
        headers: { authorization: 'Bearer t' },
        payload: { kind: 'done', title: 'It is ready!', body: 'session title' }
    });
}

/** What the drover bridge posts when it mirrors a gate onto the phone. */
async function postGate(app: Fastify, requestId: string, kind: 'permission' | 'question' = 'question') {
    return app.inject({
        method: 'POST',
        url: `/v1/sessions/${SESSION}/push-event`,
        headers: { authorization: 'Bearer t' },
        payload: {
            kind,
            title: 'Clarification needed',
            body: 'cattle-drover · which account?',
            data: { sessionId: SESSION, requestId, tool: 'AskUserQuestion' }
        }
    });
}

describe('POST /v1/sessions/:sessionId/push-event', () => {
    let app: Fastify;

    beforeEach(async () => {
        resetState();
        pushThrottleReset();
        state.sessions.push({ id: SESSION, accountId: USER });
        state.tokens.push({ id: 'tok-1', token: 'ExponentPushToken[aaa]' });
        eventRouter.init(stubIo());
        app = await buildApp();
    });

    afterEach(async () => {
        await app.close();
        vi.clearAllMocks();
    });

    it('sends and reports the outcome when nothing is connected', async () => {
        const res = await postPushEvent(app);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ success: true, result: 'sent', tokens: 1 });
        expect(state.sent).toHaveLength(1);
    });

    it('sends when the phone is backgrounded while a coding session is live', async () => {
        // The regression this whole change exists for: the session's own socket
        // must not be mistaken for the user watching.
        state.sockets.push(
            { data: { clientType: 'session-scoped' } },
            { data: { clientType: 'machine-scoped' } },
            { data: { clientType: 'user-scoped', appState: 'background' } }
        );
        const res = await postPushEvent(app);
        expect(res.json()).toMatchObject({ result: 'sent' });
        expect(state.sent).toHaveLength(1);
    });

    it('suppresses and says so when a UI client is in the foreground', async () => {
        state.sockets.push({ data: { clientType: 'user-scoped', appState: 'active' } });
        const res = await postPushEvent(app);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ success: true, result: 'suppressed', reason: 'active-ui-client' });
        expect(state.sent).toHaveLength(0);
    });

    it('sends once a foreground claim goes stale, because the app stopped saying so', async () => {
        // DROVE-52. appState was a latch: set once and believed for the life of
        // the socket. iOS suspends the app's JS the moment it backgrounds, so
        // the `background` transition often never left the phone and every push
        // after that was dropped — 40 of 40 on Clay's account on 2026-08-30,
        // including a question he was answering in tmux at the time.
        state.sockets.push({
            data: {
                clientType: 'user-scoped',
                appState: 'active',
                appStateAt: Date.now() - (ACTIVE_CLAIM_TTL_MS + 1_000),
            },
        });
        const res = await postPushEvent(app);
        expect(res.json()).toMatchObject({ result: 'sent' });
        expect(state.sent).toHaveLength(1);
    });

    it('still suppresses while the foreground claim is being re-asserted', async () => {
        state.sockets.push({
            data: {
                clientType: 'user-scoped',
                appState: 'active',
                appStateAt: Date.now() - 5_000,
            },
        });
        const res = await postPushEvent(app);
        expect(res.json()).toMatchObject({ result: 'suppressed', reason: 'active-ui-client' });
        expect(state.sent).toHaveLength(0);
    });

    it('reports no_tokens instead of claiming success', async () => {
        state.tokens.length = 0;
        const res = await postPushEvent(app);
        expect(res.json()).toMatchObject({ result: 'no_tokens' });
        expect(state.sent).toHaveLength(0);
    });

    it('reports partial delivery', async () => {
        state.tokens.push({ id: 'tok-2', token: 'ExponentPushToken[bbb]' });
        state.ticketOverride = [
            { status: 'ok' },
            { status: 'error', details: { error: 'DeviceNotRegistered' } }
        ];
        const res = await postPushEvent(app);
        expect(res.json()).toMatchObject({ result: 'partial', delivered: 1, tokens: 2 });
    });

    it('still sends when the presence check fails or times out', async () => {
        // Fail open: an infrastructure problem must not silence notifications.
        state.presenceError = 'operation has timed out';
        const res = await postPushEvent(app);
        expect(res.json()).toMatchObject({ result: 'sent' });
        expect(state.sent).toHaveLength(1);
    });

    it('reports failed, not partial, when nothing reaches Expo', async () => {
        state.ticketOverride = [{ status: 'error', message: 'Network error' }];
        const res = await postPushEvent(app);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ result: 'failed' });
    });

    it('404s for a session the caller does not own', async () => {
        const res = await postPushEvent(app, 'someone-elses-session');
        expect(res.statusCode).toBe(404);
        expect(state.sent).toHaveLength(0);
    });

    it('asks iOS to wake the app for a question, so the watch feed can republish', async () => {
        // Clay had to hold the phone app in the foreground for drover questions
        // to reach his watch: the feed only runs while the app's JS runtime is
        // alive, and iOS stops it on background. This flag is what asks iOS to
        // start it again.
        await postGate(app, 'req-1');
        expect(state.sent[0]).toMatchObject({
            // Both spellings: only `contentAvailable` is in Expo's live request
            // schema, `_contentAvailable` is the legacy alias. See pushSend.ts.
            contentAvailable: true,
            _contentAvailable: true,
            interruptionLevel: 'time-sensitive',
            priority: 'high'
        });
    });

    it('does not wake the app for a done event', async () => {
        await postPushEvent(app);
        expect(state.sent[0].contentAvailable).toBeUndefined();
        expect(state.sent[0]._contentAvailable).toBeUndefined();
        expect(state.sent[0].interruptionLevel).toBeUndefined();
    });

    it('pushes a request once, however often the bridge re-mirrors it', async () => {
        await postGate(app, 'req-1');
        const res = await postGate(app, 'req-1');
        expect(res.json()).toMatchObject({ result: 'duplicate' });
        expect(state.sent).toHaveLength(1);
    });

    it('still pushes a different request from the same session', async () => {
        await postGate(app, 'req-1');
        await postGate(app, 'req-2');
        expect(state.sent).toHaveLength(2);
    });

    it('keeps alerting past the hourly wake budget, without the wake flag', async () => {
        // Apple's ceiling for background pushes is two or three an hour. Past
        // it the alert must still go out — that is the half a locked phone
        // forwards to the watch.
        for (let i = 1; i <= 4; i++) {
            await postGate(app, `req-${i}`);
        }
        expect(state.sent).toHaveLength(4);
        expect(state.sent[2].contentAvailable).toBe(true);
        expect(state.sent[3].contentAvailable).toBeUndefined();
        expect(state.sent[3].interruptionLevel).toBe('time-sensitive');
    });

    it('lets a failed push retry instead of eating the request for an hour', async () => {
        state.ticketOverride = [{ status: 'error', message: 'Network error' }];
        expect((await postGate(app, 'req-1')).json()).toMatchObject({ result: 'failed' });
        state.ticketOverride = null;
        expect((await postGate(app, 'req-1')).json()).toMatchObject({ result: 'sent' });
        expect(state.sent).toHaveLength(2);
    });

    it('does not burn the request claim while a UI client is watching', async () => {
        state.sockets.push({ data: { clientType: 'user-scoped', appState: 'active' } });
        expect((await postGate(app, 'req-1')).json()).toMatchObject({ result: 'suppressed' });
        state.sockets.length = 0;
        expect((await postGate(app, 'req-1')).json()).toMatchObject({ result: 'sent' });
        expect(state.sent).toHaveLength(1);
    });
});
