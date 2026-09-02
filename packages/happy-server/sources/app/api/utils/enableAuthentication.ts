import { Fastify } from "../types";
import { debug } from "@/utils/log";
import { auth } from "@/app/auth/auth";
import { getAccountKind, isAccountAdmin, registrationPolicy } from "@/app/auth/accountKind";
import { announceRelay } from "@/app/relay/relayConfig";
import { log } from "@/utils/log";

export function enableAuthentication(app: Fastify) {
    // Both entrypoints (main.ts and the self-host standalone) pass through
    // here, so an unknown ACCOUNT_REGISTRATION fails the boot in either.
    log({ module: 'auth' }, `Account registration policy: ${registrationPolicy()}`);
    // Same boot-time discipline for the relay's capabilities: a malformed
    // escrow key or sharing word does not start (relayConfig.ts).
    announceRelay();

    // Runs AFTER authenticate. The "may add machines" switch and the account
    // list are admin only (relayRoutes.ts).
    app.decorate('requireAdmin', async function (request: any, reply: any) {
        if (!(await isAccountAdmin(request.userId))) {
            debug({ module: 'auth' }, `auth:refused reason=admin-only userId=${request.userId}`);
            return reply.code(403).send({ error: 'admin-only' });
        }
    });

    // Runs AFTER authenticate: `preHandler: [app.authenticate, app.requireOwner]`.
    // A guest account (DROVE-388) reaches only what it was granted; every
    // route that creates, pairs, uploads or connects refuses it here.
    app.decorate('requireOwner', async function (request: any, reply: any) {
        const kind = await getAccountKind(request.userId);
        if (kind !== 'owner') {
            debug({ module: 'auth' }, `auth:refused reason=guest-account userId=${request.userId}`);
            return reply.code(403).send({ error: 'guest-account' });
        }
    });

    app.decorate('authenticate', async function (request: any, reply: any) {
        try {
            const authHeader = request.headers.authorization;
            const route = request.routeOptions?.url || '<unmatched>';
            debug({ module: 'auth' }, `auth:check route=${route} hasHeader=${!!authHeader}`);
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                debug({ module: 'auth' }, 'auth:failed reason=missing-or-invalid-header');
                return reply.code(401).send({ error: 'Missing authorization header' });
            }

            const token = authHeader.substring(7);
            const verified = await auth.verifyToken(token);
            if (!verified) {
                debug({ module: 'auth' }, 'auth:failed reason=invalid-token');
                return reply.code(401).send({ error: 'Invalid token' });
            }

            debug({ module: 'auth' }, `auth:success userId=${verified.userId}`);
            request.userId = verified.userId;
        } catch (error) {
            return reply.code(401).send({ error: 'Authentication failed' });
        }
    });
}
