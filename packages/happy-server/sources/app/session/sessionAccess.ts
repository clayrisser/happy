import { db } from "@/storage/db";
import type { Prisma, SessionGrantRole } from "@prisma/client";

/**
 * Who may do what to a session (DROVE-388).
 *
 * A session is readable by its owner and by every account that holds a
 * SessionGrant on it. The grant carries the session's data key re-wrapped
 * to the grantee's content public key, so the server hands each caller the
 * wrapped bytes THAT CALLER can open and never sees a plaintext key.
 *
 *   owner   everything
 *   answer  read, subscribe, and send messages into the session
 *   read    read and subscribe
 *
 * Every session route resolves access through here rather than filtering on
 * `accountId: userId` by hand, so a missed check is a missed call to one
 * function rather than a missed `where` clause. A session the caller cannot
 * see is reported as not found, never as forbidden: a guest learns nothing
 * about a session it was not given.
 */

export type SessionRole = 'owner' | SessionGrantRole;

const roleRank: Record<SessionRole, number> = { read: 1, answer: 2, owner: 3 };

export function roleAllows(have: SessionRole, need: SessionRole): boolean {
    return roleRank[have] >= roleRank[need];
}

export interface SessionAccess {
    sessionId: string;
    ownerId: string;
    role: SessionRole;
    /**
     * The wrapped data key this caller can open: the session's own wrap for
     * the owner, the grant's re-wrap for a grantee. Null for a legacy
     * session, which has no per-session key and cannot be granted at all.
     */
    wrappedKey: Uint8Array | null;
}

/** Prisma `where` fragment: sessions the caller owns or was granted. */
export function sessionsVisibleTo(userId: string): Prisma.SessionWhereInput {
    return {
        OR: [
            { accountId: userId },
            { grants: { some: { granteeAccountId: userId } } }
        ]
    };
}

/** Prisma `select` fragment for the caller's own grant on each row, if any. */
export function grantsForCaller(userId: string) {
    return {
        where: { granteeAccountId: userId },
        select: { role: true, wrappedKey: true }
    } satisfies Prisma.Session$grantsArgs;
}

type VisibleRow = {
    accountId: string;
    dataEncryptionKey: Uint8Array | null;
    grants: { role: SessionGrantRole; wrappedKey: Uint8Array }[];
};

/**
 * For a row fetched with sessionsVisibleTo + grantsForCaller: the role the
 * caller holds and the wrapped key it should be handed (base64, the wire
 * shape every session row already uses). Null if the row is somehow neither
 * owned nor granted, in which case the caller must not see it.
 */
export function callerAccess(row: VisibleRow, userId: string): { role: SessionRole; ownerId: string; dataEncryptionKey: string | null } | null {
    if (row.accountId === userId) {
        return {
            role: 'owner',
            ownerId: row.accountId,
            dataEncryptionKey: row.dataEncryptionKey ? Buffer.from(row.dataEncryptionKey).toString('base64') : null
        };
    }
    const grant = row.grants[0];
    if (!grant) {
        return null;
    }
    return {
        role: grant.role,
        ownerId: row.accountId,
        dataEncryptionKey: Buffer.from(grant.wrappedKey).toString('base64')
    };
}

export async function resolveSessionAccess(userId: string, sessionId: string): Promise<SessionAccess | null> {
    const session = await db.session.findUnique({
        where: { id: sessionId },
        select: {
            id: true,
            accountId: true,
            dataEncryptionKey: true,
            grants: grantsForCaller(userId)
        }
    });
    if (!session) {
        return null;
    }
    if (session.accountId === userId) {
        return { sessionId, ownerId: session.accountId, role: 'owner', wrappedKey: session.dataEncryptionKey };
    }
    const grant = session.grants[0];
    if (!grant) {
        return null;
    }
    return { sessionId, ownerId: session.accountId, role: grant.role, wrappedKey: grant.wrappedKey };
}

/** Access if the caller holds at least `need` on the session, else null. */
export async function requireSessionRole(userId: string, sessionId: string, need: SessionRole): Promise<SessionAccess | null> {
    const access = await resolveSessionAccess(userId, sessionId);
    if (!access || !roleAllows(access.role, need)) {
        return null;
    }
    return access;
}

/**
 * The wrapped-key layout both clients write for `dataEncryptionKey`
 * (libsodiumEncryptForPublicKey in happy-cli, encryptBox in happy-app):
 *
 *   0x00 | ephemeral public key (32) | nonce (24) | crypto_box(data key)
 *
 * crypto_box of a 32-byte key is 32 + 16 bytes of tag. The server cannot
 * verify a wrap, only that it has the shape one; a wrong wrap costs the
 * grantee a session it cannot open, not the owner anything.
 */
export const WRAPPED_KEY_MIN_LENGTH = 1 + 32 + 24 + 32 + 16;

export function isWrappedKeyShaped(bytes: Uint8Array): boolean {
    return bytes.length >= WRAPPED_KEY_MIN_LENGTH && bytes[0] === 0;
}
