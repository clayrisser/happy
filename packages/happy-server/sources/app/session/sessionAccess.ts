import { db } from "@/storage/db";
import type { Prisma, SessionGrantRole } from "@prisma/client";
import { canManage, sharingEnabled, wrapEscrowedKeyFor } from "@/app/relay/relayConfig";

export { isWrappedKeyShaped, WRAPPED_KEY_MIN_LENGTH } from "@/app/relay/keyWrap";

/**
 * Who may do what to a session (DROVE-388).
 *
 * A session is readable by its owner and by every account that holds a
 * SessionGrant on it. What the grantee is handed as its dataEncryptionKey
 * depends on the SESSION's kind (decision 0c; relayConfig.ts):
 *
 *   PRIVATE   Session.escrowKey is null. The grant carries the session key
 *             re-wrapped by the owner's app to the grantee's box public key;
 *             the relay stores bytes it cannot open and hands them back.
 *             Only while RELAY_SHARING is on: off, a grant row on a private
 *             session grants nothing and the session is invisible to the
 *             grantee.
 *   MANAGED   Session.escrowKey holds the key wrapped to the relay. The
 *             grant may carry no key: the relay opens the escrow wrap with
 *             its own key and re-wraps for the caller on every read, so a
 *             member admitted a second ago can open the session and a
 *             member revoked a second ago cannot. Shares whatever
 *             RELAY_SHARING says.
 *
 *   owner   everything
 *   send    view, subscribe, and send messages into the session
 *   view    view and subscribe
 *
 * Every session route resolves access through here rather than filtering on
 * `accountId: userId` by hand, so a missed check is a missed call to one
 * function rather than a missed `where` clause. A session the caller cannot
 * see is reported as not found, never as forbidden: a guest learns nothing
 * about a session it was not given.
 */

export type SessionRole = 'owner' | SessionGrantRole;

const roleRank: Record<SessionRole, number> = { view: 1, send: 2, owner: 3 };

export function roleAllows(have: SessionRole, need: SessionRole): boolean {
    return roleRank[have] >= roleRank[need];
}

export interface SessionAccess {
    sessionId: string;
    ownerId: string;
    role: SessionRole;
    /**
     * The wrapped data key this caller can open: the session's own wrap for
     * the owner, the grant's re-wrap (private) or the relay's re-wrap
     * (managed) for a grantee. Null for a legacy session, which has no
     * per-session key, and for a grantee the relay cannot wrap for.
     */
    wrappedKey: Uint8Array | null;
}

/** Whether a grant row on a session of this kind grants anything right now. */
export function grantsHonoured(session: { escrowKey: Uint8Array | null }): boolean {
    return session.escrowKey !== null || sharingEnabled();
}

/**
 * Prisma `where` fragment: sessions the caller owns or was granted. With
 * RELAY_SHARING off (the default) a grant on a private session grants
 * nothing, so only managed sessions match through their grants.
 */
export function sessionsVisibleTo(userId: string): Prisma.SessionWhereInput {
    const granted: Prisma.SessionWhereInput = { grants: { some: { granteeAccountId: userId } } };
    return {
        OR: [
            { accountId: userId },
            sharingEnabled() ? granted : { AND: [granted, { escrowKey: { not: null } }] }
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
    escrowKey: Uint8Array | null;
    grants: { role: SessionGrantRole; wrappedKey: Uint8Array | null }[];
};

/**
 * The caller as the ACL sees it: its id, and when the relay can manage the
 * box public key the relay wraps a managed session's key to. One lookup per
 * request, and none at all on a relay that cannot manage, where the key is
 * never needed.
 */
export interface Caller {
    id: string;
    contentPublicKey: string | null;
}

export async function callerFor(userId: string): Promise<Caller> {
    if (!canManage()) {
        return { id: userId, contentPublicKey: null };
    }
    const account = await db.account.findUnique({
        where: { id: userId },
        select: { contentPublicKey: true }
    });
    return { id: userId, contentPublicKey: account?.contentPublicKey ?? null };
}

function granteeWrappedKey(row: VisibleRow, grant: { wrappedKey: Uint8Array | null }, caller: Caller): Uint8Array | null {
    // An end-to-end wrap the owner's app made is the caller's own key
    // whichever kind the session is now; the relay only wraps where there
    // is none and the session is managed.
    if (grant.wrappedKey) {
        return grant.wrappedKey;
    }
    if (row.escrowKey) {
        return wrapEscrowedKeyFor(row.escrowKey, caller.contentPublicKey);
    }
    return null;
}

/**
 * For a row fetched with sessionsVisibleTo + grantsForCaller: the role the
 * caller holds and the wrapped key it should be handed (base64, the wire
 * shape every session row already uses). Null if the row is somehow neither
 * owned nor granted, in which case the caller must not see it.
 */
export function callerAccess(row: VisibleRow, caller: Caller | string): { role: SessionRole; ownerId: string; dataEncryptionKey: string | null } | null {
    const who: Caller = typeof caller === 'string' ? { id: caller, contentPublicKey: null } : caller;
    if (row.accountId === who.id) {
        return {
            role: 'owner',
            ownerId: row.accountId,
            dataEncryptionKey: row.dataEncryptionKey ? Buffer.from(row.dataEncryptionKey).toString('base64') : null
        };
    }
    const grant = row.grants[0];
    if (!grant || !grantsHonoured(row)) {
        return null;
    }
    const wrapped = granteeWrappedKey(row, grant, who);
    return {
        role: grant.role,
        ownerId: row.accountId,
        dataEncryptionKey: wrapped ? Buffer.from(wrapped).toString('base64') : null
    };
}

export async function resolveSessionAccess(userId: string, sessionId: string): Promise<SessionAccess | null> {
    const session = await db.session.findUnique({
        where: { id: sessionId },
        select: {
            id: true,
            accountId: true,
            dataEncryptionKey: true,
            escrowKey: true,
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
    if (!grant || !grantsHonoured(session)) {
        return null;
    }
    // The caller's box key is read only when the relay has to wrap for it:
    // a managed session and a grant that carries no key of its own.
    const caller = grant.wrappedKey ? { id: userId, contentPublicKey: null } : await callerFor(userId);
    return { sessionId, ownerId: session.accountId, role: grant.role, wrappedKey: granteeWrappedKey(session, grant, caller) };
}

/** Access if the caller holds at least `need` on the session, else null. */
export async function requireSessionRole(userId: string, sessionId: string, need: SessionRole): Promise<SessionAccess | null> {
    const access = await resolveSessionAccess(userId, sessionId);
    if (!access || !roleAllows(access.role, need)) {
        return null;
    }
    return access;
}
