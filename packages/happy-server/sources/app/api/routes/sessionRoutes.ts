import { eventRouter, buildNewSessionUpdate, buildUpdateSessionUpdate, buildSessionActivityEphemeral, buildDeleteSessionUpdate, sessionGrantRoom } from "@/app/events/eventRouter";
import { type Fastify } from "../types";
import { db } from "@/storage/db";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { allocateUserSeq } from "@/storage/seq";
import { sessionDelete } from "@/app/session/sessionDelete";
import { activityCache } from "@/app/presence/sessionCache";
import { callerAccess, callerFor, grantsForCaller, requireSessionRole, sessionsVisibleTo, type Caller } from "@/app/session/sessionAccess";
import { acceptEscrowKey, canManage } from "@/app/relay/relayConfig";

// What every list endpoint selects. `accountId` and the caller's own grant
// are what callerAccess needs to hand a grantee the re-wrapped key in place
// of the owner's (DROVE-388); the rest is the row as it always was.
function listSelect(userId: string) {
    return {
        id: true,
        seq: true,
        createdAt: true,
        updatedAt: true,
        metadata: true,
        metadataVersion: true,
        agentState: true,
        agentStateVersion: true,
        dataEncryptionKey: true,
        escrowKey: true,
        wasManagedAt: true,
        projectId: true,
        active: true,
        lastActiveAt: true,
        accountId: true,
        grants: grantsForCaller(userId)
    } as const;
}

type ListRow = Prisma.SessionGetPayload<{ select: ReturnType<typeof listSelect> }>;

// A session row on the wire, for the caller: an owner sees its own wrapped
// key, a grantee sees the grant's, and both learn the role and the owner.
function listRow(v: ListRow, caller: Caller) {
    const access = callerAccess(v, caller);
    if (!access) {
        return null;
    }
    return {
        id: v.id,
        seq: v.seq,
        createdAt: v.createdAt.getTime(),
        updatedAt: v.updatedAt.getTime(),
        active: v.active,
        activeAt: v.lastActiveAt.getTime(),
        metadata: v.metadata,
        metadataVersion: v.metadataVersion,
        agentState: v.agentState,
        agentStateVersion: v.agentStateVersion,
        dataEncryptionKey: access.dataEncryptionKey,
        projectId: v.projectId,
        role: access.role,
        ownerId: access.ownerId,
        // The session's kind (DROVE-388, decision 0c): the list draws the
        // glyph and the sheet the switch from these two.
        managed: v.escrowKey !== null,
        wasManagedAt: v.wasManagedAt ? v.wasManagedAt.getTime() : null
    };
}

async function listRows(rows: ListRow[], userId: string) {
    // One caller lookup per list, and only on a managed relay (callerFor).
    const caller = await callerFor(userId);
    return rows.map((v) => listRow(v, caller)).filter((v) => v !== null);
}

export function sessionRoutes(app: Fastify) {

    // The Managed switch, ON (DROVE-388, decision 0c): the owner's app opens
    // the session's own dataEncryptionKey with its box secret key, wraps the
    // key to the relay's escrow public key (GET /v1/relay) and puts it here;
    // the relay checks that the wrap opens and stores it. From then on the
    // relay can share the session for the owner. Owner only; a relay that
    // cannot manage refuses, because it has no key to open the wrap with and
    // must not hold one it cannot use. Idempotent: a session already managed
    // takes the new wrap.
    app.put('/v1/sessions/:sessionId/escrow', {
        preHandler: [app.authenticate, app.requireOwner],
        schema: {
            params: z.object({ sessionId: z.string() }),
            body: z.object({ escrowKey: z.string() })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        if (!canManage()) {
            return reply.code(409).send({ error: 'relay-cannot-manage' });
        }
        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId },
            select: { id: true, dataEncryptionKey: true, wasManagedAt: true }
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }
        if (!session.dataEncryptionKey) {
            return reply.code(409).send({ error: 'session-not-shareable' });
        }
        const escrowKey = acceptEscrowKey(request.body.escrowKey);
        if (!escrowKey) {
            return reply.code(400).send({ error: 'escrow-key-malformed' });
        }
        await db.session.update({ where: { id: sessionId }, data: { escrowKey } });
        log({ module: 'session-escrow', userId, sessionId }, `Session made managed by its owner`);
        return reply.send({ managed: true, wasManagedAt: session.wasManagedAt ? session.wasManagedAt.getTime() : null });
    });

    // The Managed switch, OFF: the relay deletes its wrap and, with it, the
    // grants that had no key of their own (they were the relay's to honour;
    // the owner re-shares end to end if wanted). wasManagedAt records that
    // the relay held the key until now and may have read the session; it
    // never clears. Idempotent on a session already private.
    app.delete('/v1/sessions/:sessionId/escrow', {
        preHandler: [app.authenticate, app.requireOwner],
        schema: {
            params: z.object({ sessionId: z.string() })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId },
            select: { id: true, escrowKey: true, wasManagedAt: true }
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }
        if (!session.escrowKey) {
            return reply.send({ managed: false, wasManagedAt: session.wasManagedAt ? session.wasManagedAt.getTime() : null, droppedGrants: 0 });
        }
        const now = new Date();
        const dropped = await db.$transaction(async (tx) => {
            const keyless = await tx.sessionGrant.findMany({
                where: { sessionId, wrappedKey: null },
                select: { granteeAccountId: true }
            });
            await tx.sessionGrant.deleteMany({ where: { sessionId, wrappedKey: null } });
            await tx.session.update({ where: { id: sessionId }, data: { escrowKey: null, wasManagedAt: now } });
            return keyless.map((g) => g.granteeAccountId);
        });
        log({ module: 'session-escrow', userId, sessionId, droppedGrants: dropped.length }, `Session made private by its owner`);
        // Each dropped grantee stops hearing the session and drops it from
        // its list, exactly as a revoke does.
        for (const granteeAccountId of dropped) {
            eventRouter.leaveUserScoped(granteeAccountId, sessionGrantRoom(sessionId));
            const updSeq = await allocateUserSeq(granteeAccountId);
            eventRouter.emitUpdate({
                userId: granteeAccountId,
                payload: buildDeleteSessionUpdate(sessionId, updSeq, randomKeyNaked(12)),
                recipientFilter: { type: 'user-scoped-only' }
            });
        }
        return reply.send({ managed: false, wasManagedAt: now.getTime(), droppedGrants: dropped.length });
    });

    // Sessions API
    app.get('/v1/sessions', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;

        const sessions = await db.session.findMany({
            where: sessionsVisibleTo(userId),
            orderBy: { updatedAt: 'desc' },
            take: 150,
            select: listSelect(userId)
        });

        return reply.send({
            sessions: (await listRows(sessions, userId)).map((v) => ({ ...v, lastMessage: null }))
        });
    });

    // V2 Sessions API - Active sessions only
    app.get('/v2/sessions/active', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                limit: z.coerce.number().int().min(1).max(500).default(150)
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const limit = request.query?.limit || 150;

        const sessions = await db.session.findMany({
            where: {
                ...sessionsVisibleTo(userId),
                active: true,
                lastActiveAt: { gt: new Date(Date.now() - 1000 * 60 * 15) /* 15 minutes */ }
            },
            orderBy: { lastActiveAt: 'desc' },
            take: limit,
            select: listSelect(userId)
        });

        return reply.send({
            sessions: await listRows(sessions, userId)
        });
    });

    // V2 Sessions API - Cursor-based pagination with change tracking
    app.get('/v2/sessions', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                cursor: z.string().optional(),
                limit: z.coerce.number().int().min(1).max(200).default(50),
                changedSince: z.coerce.number().int().positive().optional()
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { cursor, limit = 50, changedSince } = request.query || {};

        // Decode cursor - simple ID-based cursor
        let cursorSessionId: string | undefined;
        if (cursor) {
            if (cursor.startsWith('cursor_v1_')) {
                cursorSessionId = cursor.substring(10);
            } else {
                return reply.code(400).send({ error: 'Invalid cursor format' });
            }
        }

        // Build where clause
        const where: Prisma.SessionWhereInput = { ...sessionsVisibleTo(userId) };

        // Add changedSince filter (just a filter, doesn't affect pagination)
        if (changedSince) {
            where.updatedAt = {
                gt: new Date(changedSince)
            };
        }

        // Add cursor pagination - always by ID descending (most recent first)
        if (cursorSessionId) {
            where.id = {
                lt: cursorSessionId  // Get sessions with ID less than cursor (for desc order)
            };
        }

        // Always sort by ID descending for consistent pagination
        const orderBy = { id: 'desc' as const };

        const sessions = await db.session.findMany({
            where,
            orderBy,
            take: limit + 1, // Fetch one extra to determine if there are more
            select: listSelect(userId)
        });

        // Check if there are more results
        const hasNext = sessions.length > limit;
        const resultSessions = hasNext ? sessions.slice(0, limit) : sessions;

        // Generate next cursor - simple ID-based cursor
        let nextCursor: string | null = null;
        if (hasNext && resultSessions.length > 0) {
            const lastSession = resultSessions[resultSessions.length - 1];
            nextCursor = `cursor_v1_${lastSession.id}`;
        }

        return reply.send({
            sessions: listRows(resultSessions, userId),
            nextCursor,
            hasNext
        });
    });

    // Create or load session by tag. Owners only: a guest never creates a
    // session (DROVE-388).
    app.post('/v1/sessions', {
        schema: {
            body: z.object({
                tag: z.string(),
                metadata: z.string(),
                agentState: z.string().nullish(),
                dataEncryptionKey: z.string().nullish(),
                // A managed session: the same key wrapped to the relay's
                // escrow public key (GET /v1/relay). Absent, the session is
                // private (DROVE-388, decision 0c).
                escrowKey: z.string().nullish(),
                projectId: z.string().nullish()
            })
        },
        preHandler: [app.authenticate, app.requireOwner]
    }, async (request, reply) => {
        const userId = request.userId;
        const { tag, metadata, dataEncryptionKey, projectId } = request.body;

        // A wrap the relay cannot open is refused rather than stored: a
        // stored wrap that opens to nothing would make every later grant a
        // key nobody can use, and the CLI can only fix it now. A relay with
        // no key of its own says so, rather than quietly making the session
        // private when the CLI asked for managed.
        if (request.body.escrowKey && !canManage()) {
            return reply.code(409).send({ error: 'relay-cannot-manage' });
        }
        const escrowKey = acceptEscrowKey(request.body.escrowKey);
        if (request.body.escrowKey && !escrowKey) {
            return reply.code(400).send({ error: 'escrow-key-malformed' });
        }

        if (projectId !== undefined && projectId !== null) {
            const project = await db.project.findFirst({
                where: { id: projectId, accountId: userId },
                select: { id: true }
            });
            if (!project) return reply.code(404).send({ error: 'Project not found' });
        }

        const session = await db.session.findFirst({
            where: {
                accountId: userId,
                tag: tag
            }
        });
        if (session) {
            log({ module: 'session-create', sessionId: session.id, userId, tag }, `Found existing session: ${session.id} for tag ${tag}`);

            let sessionForResponse = session;
            // A CLI reconnecting to a private session and asking for managed
            // brings the escrow wrap with it; store it once. The owner turns
            // it off from the sheet, never the CLI by omission.
            if (escrowKey && !session.escrowKey) {
                sessionForResponse = await db.session.update({
                    where: { id: session.id },
                    data: { escrowKey }
                });
                log({ module: 'session-create', sessionId: session.id, userId }, `Session escrow key stored on reconnect`);
            }
            if (projectId !== undefined && projectId !== session.projectId) {
                sessionForResponse = await db.session.update({
                    where: { id: session.id },
                    data: { projectId }
                });
                const updateSeq = await allocateUserSeq(userId);
                eventRouter.emitUpdate({
                    userId,
                    payload: buildUpdateSessionUpdate(session.id, updateSeq, randomKeyNaked(12), undefined, undefined, projectId),
                    recipientFilter: { type: 'user-scoped-only' }
                });
            }

            // Session is starting back up - stop ignoring its heartbeats if it was stopped
            activityCache.resumeSessionUpdates(session.id);

            return reply.send({
                session: {
                    id: sessionForResponse.id,
                    seq: sessionForResponse.seq,
                    metadata: sessionForResponse.metadata,
                    metadataVersion: sessionForResponse.metadataVersion,
                    agentState: sessionForResponse.agentState,
                    agentStateVersion: sessionForResponse.agentStateVersion,
                    dataEncryptionKey: sessionForResponse.dataEncryptionKey ? Buffer.from(sessionForResponse.dataEncryptionKey).toString('base64') : null,
                    projectId: sessionForResponse.projectId,
                    active: sessionForResponse.active,
                    activeAt: sessionForResponse.lastActiveAt.getTime(),
                    createdAt: sessionForResponse.createdAt.getTime(),
                    updatedAt: sessionForResponse.updatedAt.getTime(),
                    managed: sessionForResponse.escrowKey !== null,
                    wasManagedAt: sessionForResponse.wasManagedAt ? sessionForResponse.wasManagedAt.getTime() : null,
                    lastMessage: null
                }
            });
        } else {

            // Resolve seq
            const updSeq = await allocateUserSeq(userId);

            // Create session
            log({ module: 'session-create', userId, tag }, `Creating new session for user ${userId} with tag ${tag}`);
            const session = await db.session.create({
                data: {
                    accountId: userId,
                    tag: tag,
                    metadata: metadata,
                    dataEncryptionKey: dataEncryptionKey ? new Uint8Array(Buffer.from(dataEncryptionKey, 'base64')) : undefined,
                    escrowKey: escrowKey ?? undefined,
                    projectId: projectId ?? null
                }
            });
            log({ module: 'session-create', sessionId: session.id, userId }, `Session created: ${session.id}${escrowKey ? ' (managed)' : ' (private)'}`);

            // Emit new session update
            const updatePayload = buildNewSessionUpdate(session, updSeq, randomKeyNaked(12));
            log({
                module: 'session-create',
                userId,
                sessionId: session.id,
                updateType: 'new-session',
                updatePayload: JSON.stringify(updatePayload)
            }, `Emitting new-session update to user-scoped connections`);
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });

            return reply.send({
                session: {
                    id: session.id,
                    seq: session.seq,
                    metadata: session.metadata,
                    metadataVersion: session.metadataVersion,
                    agentState: session.agentState,
                    agentStateVersion: session.agentStateVersion,
                    dataEncryptionKey: session.dataEncryptionKey ? Buffer.from(session.dataEncryptionKey).toString('base64') : null,
                    projectId: session.projectId,
                    active: session.active,
                    activeAt: session.lastActiveAt.getTime(),
                    createdAt: session.createdAt.getTime(),
                    updatedAt: session.updatedAt.getTime(),
                    managed: session.escrowKey !== null,
                    wasManagedAt: null,
                    lastMessage: null
                }
            });
        }
    });

    app.get('/v1/sessions/:sessionId/messages', {
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        // Owner or a read grant; anything else is not found.
        const access = await requireSessionRole(userId, sessionId, 'view');
        if (!access) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        const messages = await db.sessionMessage.findMany({
            where: { sessionId },
            orderBy: [
                { createdAt: 'desc' },
                { seq: 'desc' }
            ],
            take: 150,
            select: {
                id: true,
                seq: true,
                localId: true,
                content: true,
                createdAt: true,
                updatedAt: true
            }
        });

        return reply.send({
            messages: messages.map((v) => ({
                id: v.id,
                seq: v.seq,
                content: v.content,
                localId: v.localId,
                createdAt: v.createdAt.getTime(),
                updatedAt: v.updatedAt.getTime()
            }))
        });
    });

    // Archive session (force deactivate)
    app.post('/v1/sessions/:sessionId/archive', {
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        activityCache.clearSessionUpdates(sessionId);

        const result = await db.session.updateMany({
            where: { id: sessionId, accountId: userId },
            data: { active: false, lastActiveAt: new Date() }
        });

        if (result.count === 0) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // Notify all clients about the session deactivation
        const sessionActivity = buildSessionActivityEphemeral(sessionId, false, Date.now(), false);
        eventRouter.emitEphemeral({
            userId,
            payload: sessionActivity,
            recipientFilter: { type: 'user-scoped-and-grantees', sessionId }
        });

        return reply.send({ success: true });
    });

    // Delete session
    app.delete('/v1/sessions/:sessionId', {
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        activityCache.clearSessionUpdates(sessionId);

        const deleted = await sessionDelete({ uid: userId }, sessionId);

        if (!deleted) {
            return reply.code(404).send({ error: 'Session not found or not owned by user' });
        }

        return reply.send({ success: true });
    });
}
