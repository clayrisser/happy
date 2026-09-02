import { z } from "zod";
import { type Fastify } from "../types";
import { db } from "@/storage/db";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { allocateUserSeq } from "@/storage/seq";
import { buildDeleteSessionUpdate, buildNewSessionUpdate, eventRouter, sessionGrantRoom } from "@/app/events/eventRouter";
import { isWrappedKeyShaped } from "@/app/session/sessionAccess";

/**
 * Grants: one session handed to one other account (DROVE-388).
 *
 * The owner's app does the cryptography. It unwraps the session's own
 * dataEncryptionKey with its box private key, re-wraps the data key to the
 * grantee's content public key with the same layout, and posts the bytes
 * here. The server checks the shape, stores them, and from then on hands the
 * grantee those bytes in place of dataEncryptionKey on every session row.
 * It never sees a plaintext session key.
 *
 * Owner only, on every route. A guest cannot grant, list or revoke, and a
 * session the caller does not own is not found.
 */

const roleSchema = z.enum(['view', 'send']);

function grantOnWire(grant: {
    id: string;
    sessionId: string;
    granteeAccountId: string;
    role: 'view' | 'send';
    grantedById: string;
    createdAt: Date;
    updatedAt: Date;
}) {
    return {
        id: grant.id,
        sessionId: grant.sessionId,
        granteeAccountId: grant.granteeAccountId,
        role: grant.role,
        grantedById: grant.grantedById,
        createdAt: grant.createdAt.getTime(),
        updatedAt: grant.updatedAt.getTime()
    };
}

export function sessionGrantRoutes(app: Fastify) {

    app.post('/v1/sessions/:sessionId/grants', {
        preHandler: [app.authenticate, app.requireOwner],
        schema: {
            params: z.object({ sessionId: z.string() }),
            body: z.object({
                granteeAccountId: z.string().optional(),
                granteeContentPublicKey: z.string().optional(),
                wrappedKey: z.string(),
                role: roleSchema
            }).refine(
                (b) => (b.granteeAccountId ? 1 : 0) + (b.granteeContentPublicKey ? 1 : 0) === 1,
                { message: 'exactly one of granteeAccountId or granteeContentPublicKey' }
            )
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { granteeAccountId, granteeContentPublicKey, wrappedKey, role } = request.body;

        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId }
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }
        // A legacy session has no per-session key: its content is under the
        // owner's master secret, and there is nothing to re-wrap.
        if (!session.dataEncryptionKey) {
            return reply.code(409).send({ error: 'session-not-shareable' });
        }

        const wrapped = new Uint8Array(Buffer.from(wrappedKey, 'base64'));
        if (!isWrappedKeyShaped(wrapped)) {
            return reply.code(400).send({ error: 'wrapped-key-malformed' });
        }

        let granteeWhere: { id: string } | { contentPublicKey: string };
        if (granteeAccountId) {
            granteeWhere = { id: granteeAccountId };
        } else {
            const keyBytes = Buffer.from(granteeContentPublicKey!, 'base64');
            if (keyBytes.length !== 32) {
                return reply.code(400).send({ error: 'content-key-malformed' });
            }
            granteeWhere = { contentPublicKey: keyBytes.toString('hex') };
        }
        const grantee = await db.account.findUnique({
            where: granteeWhere,
            select: { id: true }
        });
        if (!grantee) {
            return reply.code(404).send({ error: 'grantee-not-found' });
        }
        if (grantee.id === userId) {
            return reply.code(400).send({ error: 'cannot-grant-to-self' });
        }

        const grant = await db.sessionGrant.upsert({
            where: { sessionId_granteeAccountId: { sessionId, granteeAccountId: grantee.id } },
            update: { wrappedKey: wrapped, role },
            create: { sessionId, granteeAccountId: grantee.id, wrappedKey: wrapped, role, grantedById: userId }
        });
        log({ module: 'session-grant', userId, sessionId, granteeAccountId: grantee.id, role }, `Session granted (${role})`);

        // The grantee's phone learns the session now, with the key IT can
        // open, and its live sockets start hearing the session's updates.
        eventRouter.joinUserScoped(grantee.id, sessionGrantRoom(sessionId));
        const updSeq = await allocateUserSeq(grantee.id);
        eventRouter.emitUpdate({
            userId: grantee.id,
            payload: buildNewSessionUpdate({ ...session, dataEncryptionKey: wrapped }, updSeq, randomKeyNaked(12)),
            recipientFilter: { type: 'user-scoped-only' }
        });

        return reply.send({ grant: grantOnWire(grant) });
    });

    app.get('/v1/sessions/:sessionId/grants', {
        preHandler: [app.authenticate, app.requireOwner],
        schema: {
            params: z.object({ sessionId: z.string() })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId },
            select: { id: true }
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        const grants = await db.sessionGrant.findMany({
            where: { sessionId },
            orderBy: { createdAt: 'asc' },
            include: {
                grantee: { select: { username: true, firstName: true, lastName: true, kind: true } }
            }
        });
        return reply.send({
            grants: grants.map((g) => ({ ...grantOnWire(g), grantee: g.grantee }))
        });
    });

    app.delete('/v1/sessions/:sessionId/grants/:granteeAccountId', {
        preHandler: [app.authenticate, app.requireOwner],
        schema: {
            params: z.object({ sessionId: z.string(), granteeAccountId: z.string() })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, granteeAccountId } = request.params;

        // Ownership is part of the delete's own where clause, so a session
        // the caller does not own and a grant that does not exist read the
        // same: not found.
        const { count } = await db.sessionGrant.deleteMany({
            where: { sessionId, granteeAccountId, session: { accountId: userId } }
        });
        if (count === 0) {
            return reply.code(404).send({ error: 'Grant not found' });
        }
        log({ module: 'session-grant', userId, sessionId, granteeAccountId }, `Session grant revoked`);

        // The revoked phone stops hearing the session and drops it from its
        // list. What it already read, it keeps: revocation is an access
        // revoke at the server, not a key rotation (docs/shared-sessions.md).
        eventRouter.leaveUserScoped(granteeAccountId, sessionGrantRoom(sessionId));
        const updSeq = await allocateUserSeq(granteeAccountId);
        eventRouter.emitUpdate({
            userId: granteeAccountId,
            payload: buildDeleteSessionUpdate(sessionId, updSeq, randomKeyNaked(12)),
            recipientFilter: { type: 'user-scoped-only' }
        });

        return reply.send({ success: true });
    });
}
