import { eventRouter, buildUpdateAccountUpdate } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { Fastify } from "../types";
import { getPublicUrl } from "@/storage/files";
import { z } from "zod";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { allocateUserSeq } from "@/storage/seq";
import { log } from "@/utils/log";
import { AccountProfile } from "@/types";
import { Prisma } from "@prisma/client";

// The curve25519 box public key is 32 bytes; anything else is not one.
const BOX_PUBLIC_KEY_LENGTH = 32;

function decodeBoxPublicKey(base64: string): string | null {
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length !== BOX_PUBLIC_KEY_LENGTH) {
        return null;
    }
    return bytes.toString('hex');
}

function encodeBoxPublicKey(hex: string | null): string | null {
    return hex ? Buffer.from(hex, 'hex').toString('base64') : null;
}

export function accountRoutes(app: Fastify) {
    app.get('/v1/account/profile', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;
        const user = await db.account.findUniqueOrThrow({
            where: { id: userId },
            select: {
                firstName: true,
                lastName: true,
                username: true,
                avatar: true,
                githubUser: true,
                kind: true,
                contentPublicKey: true,
                newSessionsManaged: true
            }
        });
        const connectedVendors = new Set((await db.serviceAccountToken.findMany({ where: { accountId: userId } })).map(t => t.vendor));
        return reply.send({
            id: userId,
            timestamp: Date.now(),
            firstName: user.firstName,
            lastName: user.lastName,
            username: user.username,
            avatar: user.avatar ? { ...user.avatar, url: getPublicUrl(user.avatar.path) } : null,
            github: user.githubUser ? user.githubUser.profile : null,
            connectedServices: Array.from(connectedVendors),
            // DROVE-388: which chrome the app draws, and the key an owner
            // wraps a session key to when it grants this account a session.
            kind: user.kind,
            contentPublicKey: encodeBoxPublicKey(user.contentPublicKey),
            // Whether a session this account's CLI creates is managed when
            // nothing on the command line or the machine says (decision 0c).
            newSessionsManaged: user.newSessionsManaged
        });
    });

    // The account's "new sessions managed" default (DROVE-388, decision 0c).
    // In the clear on purpose: it is policy, not content, and the CLI reads
    // it from the profile before it has any session key. The CLI's own
    // --managed / --private and the machine's override both beat it.
    app.put('/v1/account/new-sessions-managed', {
        preHandler: [app.authenticate, app.requireOwner],
        schema: {
            body: z.object({ managed: z.boolean() })
        }
    }, async (request, reply) => {
        const { managed } = request.body;
        await db.account.update({
            where: { id: request.userId },
            data: { newSessionsManaged: managed }
        });
        log({ module: 'account', userId: request.userId, managed }, `New sessions default set to ${managed ? 'managed' : 'private'}`);
        return reply.send({ newSessionsManaged: managed });
    });

    // Register the account's content (box) public key, so an owner can wrap
    // a session key to it (DROVE-388). Any kind of account may register one;
    // the signing key never leaves the device and is not this key. A key
    // already bound to another account is refused: it is the identity a
    // grant is addressed to, and two accounts must not share one.
    app.post('/v1/account/content-key', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                contentPublicKey: z.string()
            })
        }
    }, async (request, reply) => {
        const hex = decodeBoxPublicKey(request.body.contentPublicKey);
        if (!hex) {
            return reply.code(400).send({ error: 'content-key-malformed' });
        }
        try {
            await db.account.update({
                where: { id: request.userId },
                data: { contentPublicKey: hex }
            });
        } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                return reply.code(409).send({ error: 'content-key-taken' });
            }
            throw error;
        }
        return reply.send({ success: true });
    });

    // Resolve a content public key to the account that registered it: the
    // owner's share sheet turns a scanned QR into a grantee with this. Owners
    // only, and it says nothing beyond what the grantee chose to publish.
    app.get('/v1/account/lookup', {
        preHandler: [app.authenticate, app.requireOwner],
        schema: {
            querystring: z.object({
                contentPublicKey: z.string()
            })
        }
    }, async (request, reply) => {
        const hex = decodeBoxPublicKey(request.query.contentPublicKey);
        if (!hex) {
            return reply.code(400).send({ error: 'content-key-malformed' });
        }
        const account = await db.account.findUnique({
            where: { contentPublicKey: hex },
            select: { id: true, kind: true, username: true, firstName: true, lastName: true }
        });
        if (!account) {
            return reply.code(404).send({ error: 'account-not-found' });
        }
        return reply.send({ account });
    });

    // Get Account Settings API
    app.get('/v1/account/settings', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({
                    settings: z.string().nullable(),
                    settingsVersion: z.number()
                }),
                500: z.object({
                    error: z.literal('Failed to get account settings')
                })
            }
        }
    }, async (request, reply) => {
        try {
            const user = await db.account.findUnique({
                where: { id: request.userId },
                select: { settings: true, settingsVersion: true }
            });

            if (!user) {
                return reply.code(500).send({ error: 'Failed to get account settings' });
            }

            return reply.send({
                settings: user.settings,
                settingsVersion: user.settingsVersion
            });
        } catch (error) {
            return reply.code(500).send({ error: 'Failed to get account settings' });
        }
    });

    // Update Account Settings API
    app.post('/v1/account/settings', {
        schema: {
            body: z.object({
                settings: z.string().nullable(),
                expectedVersion: z.number().int().min(0)
            }),
            response: {
                200: z.union([z.object({
                    success: z.literal(true),
                    version: z.number()
                }), z.object({
                    success: z.literal(false),
                    error: z.literal('version-mismatch'),
                    currentVersion: z.number(),
                    currentSettings: z.string().nullable()
                })]),
                500: z.object({
                    success: z.literal(false),
                    error: z.literal('Failed to update account settings')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { settings, expectedVersion } = request.body;

        try {
            // Get current user data for version check
            const currentUser = await db.account.findUnique({
                where: { id: userId },
                select: { settings: true, settingsVersion: true }
            });

            if (!currentUser) {
                return reply.code(500).send({
                    success: false,
                    error: 'Failed to update account settings'
                });
            }

            // Check current version
            if (currentUser.settingsVersion !== expectedVersion) {
                return reply.code(200).send({
                    success: false,
                    error: 'version-mismatch',
                    currentVersion: currentUser.settingsVersion,
                    currentSettings: currentUser.settings
                });
            }

            // Update settings with version check
            const { count } = await db.account.updateMany({
                where: {
                    id: userId,
                    settingsVersion: expectedVersion
                },
                data: {
                    settings: settings,
                    settingsVersion: expectedVersion + 1,
                    updatedAt: new Date()
                }
            });

            if (count === 0) {
                // Re-fetch to get current version
                const account = await db.account.findUnique({
                    where: { id: userId }
                });
                return reply.code(200).send({
                    success: false,
                    error: 'version-mismatch',
                    currentVersion: account?.settingsVersion || 0,
                    currentSettings: account?.settings || null
                });
            }

            // Generate update for connected clients
            const updSeq = await allocateUserSeq(userId);
            const settingsUpdate = {
                value: settings,
                version: expectedVersion + 1
            };

            // Send account update to user-scoped connections only
            const updatePayload = buildUpdateAccountUpdate(userId, { settings: settingsUpdate }, updSeq, randomKeyNaked(12));
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });

            return reply.send({
                success: true,
                version: expectedVersion + 1
            });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to update account settings: ${error}`);
            return reply.code(500).send({
                success: false,
                error: 'Failed to update account settings'
            });
        }
    });

    app.post('/v1/usage/query', {
        schema: {
            body: z.object({
                sessionId: z.string().nullish(),
                startTime: z.number().int().positive().nullish(),
                endTime: z.number().int().positive().nullish(),
                groupBy: z.enum(['hour', 'day']).nullish()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, startTime, endTime, groupBy } = request.body;
        const actualGroupBy = groupBy || 'day';

        try {
            // Build query conditions
            const where: {
                accountId: string;
                sessionId?: string | null;
                createdAt?: {
                    gte?: Date;
                    lte?: Date;
                };
            } = {
                accountId: userId
            };

            if (sessionId) {
                // Verify session belongs to user
                const session = await db.session.findFirst({
                    where: {
                        id: sessionId,
                        accountId: userId
                    }
                });
                if (!session) {
                    return reply.code(404).send({ error: 'Session not found' });
                }
                where.sessionId = sessionId;
            }

            if (startTime || endTime) {
                where.createdAt = {};
                if (startTime) {
                    where.createdAt.gte = new Date(startTime * 1000);
                }
                if (endTime) {
                    where.createdAt.lte = new Date(endTime * 1000);
                }
            }

            // Fetch usage reports
            const reports = await db.usageReport.findMany({
                where,
                orderBy: {
                    createdAt: 'desc'
                }
            });

            // Aggregate data by time period
            const aggregated = new Map<string, {
                tokens: Record<string, number>;
                cost: Record<string, number>;
                count: number;
                timestamp: number;
            }>();

            for (const report of reports) {
                const data = report.data as PrismaJson.UsageReportData;
                const date = new Date(report.createdAt);

                // Calculate timestamp based on groupBy
                let timestamp: number;
                if (actualGroupBy === 'hour') {
                    // Round down to hour
                    const hourDate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), 0, 0, 0);
                    timestamp = Math.floor(hourDate.getTime() / 1000);
                } else {
                    // Round down to day
                    const dayDate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
                    timestamp = Math.floor(dayDate.getTime() / 1000);
                }

                const key = timestamp.toString();

                if (!aggregated.has(key)) {
                    aggregated.set(key, {
                        tokens: {},
                        cost: {},
                        count: 0,
                        timestamp
                    });
                }

                const agg = aggregated.get(key)!;
                agg.count++;

                // Aggregate tokens
                for (const [tokenKey, tokenValue] of Object.entries(data.tokens)) {
                    if (typeof tokenValue === 'number') {
                        agg.tokens[tokenKey] = (agg.tokens[tokenKey] || 0) + tokenValue;
                    }
                }

                // Aggregate costs
                for (const [costKey, costValue] of Object.entries(data.cost)) {
                    if (typeof costValue === 'number') {
                        agg.cost[costKey] = (agg.cost[costKey] || 0) + costValue;
                    }
                }
            }

            // Convert to array and sort by timestamp
            const result = Array.from(aggregated.values())
                .map(data => ({
                    timestamp: data.timestamp,
                    tokens: data.tokens,
                    cost: data.cost,
                    reportCount: data.count
                }))
                .sort((a, b) => a.timestamp - b.timestamp);

            return reply.send({
                usage: result,
                groupBy: actualGroupBy,
                totalReports: reports.length
            });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to query usage reports: ${error}`);
            return reply.code(500).send({ error: 'Failed to query usage reports' });
        }
    });
}