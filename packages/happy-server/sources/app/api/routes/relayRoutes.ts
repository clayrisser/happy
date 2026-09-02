import { z } from "zod";
import { type Fastify } from "../types";
import { db } from "@/storage/db";
import { log } from "@/utils/log";
import { forgetAccountKind, registrationPolicy } from "@/app/auth/accountKind";
import { escrowPublicKeyBase64, sharingEnabled } from "@/app/relay/relayConfig";

/**
 * What this relay can do, and who may add machines (DROVE-388).
 *
 * GET /v1/relay is public: the app asks it before any account exists, so
 * the first screen offers the sign-in surfaces the relay actually has, and
 * the CLI learns the escrow key it wraps a managed session's key to.
 * Nothing here is secret: the relay's box PUBLIC key (null when it cannot
 * manage), whether private sessions may be shared, the registration policy,
 * and the ways in (the secret key always; OIDC once configured).
 *
 * PUT /v1/accounts/:id/kind is the "may add machines" switch. Account.kind
 * is the gate requireOwner enforces: an owner pairs machines and creates
 * sessions, a guest sees only what it was granted. A relay that admits new
 * keys as guests has an admin flip them here, and that account then links
 * a machine of its own and owns it. Admins are the pinned owner keys and,
 * once OIDC lands, the accounts in RELAY_ADMIN_GROUP.
 */

export function relayRoutes(app: Fastify) {

    app.get('/v1/relay', async (_request, reply) => {
        return reply.send({
            escrowPublicKey: escrowPublicKeyBase64(),
            sharing: sharingEnabled(),
            registration: registrationPolicy(),
            signIn: {
                secretKey: true,
                oidc: null
            }
        });
    });

    app.get('/v1/accounts', {
        preHandler: [app.authenticate, app.requireAdmin]
    }, async (_request, reply) => {
        const accounts = await db.account.findMany({
            orderBy: { createdAt: 'asc' },
            select: {
                id: true,
                kind: true,
                admin: true,
                username: true,
                firstName: true,
                lastName: true,
                contentPublicKey: true,
                createdAt: true,
                _count: { select: { Machine: true, Session: true } }
            }
        });
        return reply.send({
            accounts: accounts.map((a) => ({
                id: a.id,
                kind: a.kind,
                admin: a.admin,
                username: a.username,
                firstName: a.firstName,
                lastName: a.lastName,
                hasContentKey: a.contentPublicKey !== null,
                machines: a._count.Machine,
                sessions: a._count.Session,
                createdAt: a.createdAt.getTime()
            }))
        });
    });

    app.put('/v1/accounts/:accountId/kind', {
        preHandler: [app.authenticate, app.requireAdmin],
        schema: {
            params: z.object({ accountId: z.string() }),
            body: z.object({ kind: z.enum(['owner', 'guest']) })
        }
    }, async (request, reply) => {
        const { accountId } = request.params;
        const { kind } = request.body;
        if (accountId === request.userId) {
            // An admin demoting itself to guest would lock the switch
            // behind an account that can no longer reach it.
            return reply.code(400).send({ error: 'cannot-change-own-kind' });
        }
        const account = await db.account.findUnique({
            where: { id: accountId },
            select: { id: true, kind: true }
        });
        if (!account) {
            return reply.code(404).send({ error: 'account-not-found' });
        }
        if (account.kind !== kind) {
            await db.account.update({ where: { id: accountId }, data: { kind } });
            forgetAccountKind(accountId);
            log({ module: 'relay', userId: request.userId, accountId, kind }, `Account kind set to ${kind} by admin`);
        }
        return reply.send({ account: { id: accountId, kind } });
    });
}
