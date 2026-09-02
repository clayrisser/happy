import { db } from "@/storage/db";
import { log } from "@/utils/log";
import type { AccountKind } from "@prisma/client";

/**
 * Account kinds and the registration policy (DROVE-388).
 *
 * `owner` is every account that existed before this file: it creates
 * sessions, registers machines, approves pairings. `guest` can do none of
 * that; it authenticates, keeps its own profile, and sees exactly the
 * sessions an owner granted it (see sessionAccess.ts).
 *
 * Which kind a NEW key becomes is the relay's decision, not the client's:
 *
 *   ACCOUNT_REGISTRATION=open    (default) a new key is an owner, as always
 *   ACCOUNT_REGISTRATION=guest   a new key is a guest
 *   ACCOUNT_REGISTRATION=closed  a new key is refused
 *
 * ACCOUNT_OWNER_PUBLIC_KEYS (comma-separated hex signing keys) pins owners
 * regardless of policy and promotes a pinned key that is already a guest on
 * its next login, so first-contact order cannot strand the household's own
 * phone as a guest. An unknown policy word fails at boot rather than falling
 * back to `open`: the whole point of setting it is to stop strangers
 * becoming owners, so a typo must not quietly reopen the door.
 */

export type RegistrationPolicy = 'open' | 'guest' | 'closed';

export function registrationPolicy(): RegistrationPolicy {
    const raw = (process.env.ACCOUNT_REGISTRATION ?? 'open').trim().toLowerCase();
    if (raw === 'open' || raw === 'guest' || raw === 'closed') {
        return raw;
    }
    throw new Error(`ACCOUNT_REGISTRATION must be open, guest or closed, got "${raw}"`);
}

export function pinnedOwnerPublicKeys(): Set<string> {
    const raw = process.env.ACCOUNT_OWNER_PUBLIC_KEYS ?? '';
    return new Set(
        raw.split(',')
            .map((k) => k.trim().toLowerCase())
            .filter((k) => k.length > 0)
    );
}

/**
 * Resolve the account for a signing key that just proved itself, creating
 * it under the registration policy when it is new. Returns null only when
 * the policy refuses a new key.
 */
export async function registerOrLogin(publicKeyHex: string): Promise<{ id: string; kind: AccountKind } | null> {
    const key = publicKeyHex.toLowerCase();
    const pinned = pinnedOwnerPublicKeys().has(key);

    const existing = await db.account.findUnique({
        where: { publicKey: key },
        select: { id: true, kind: true, admin: true }
    });
    if (existing) {
        // A pinned key is an owner and an admin, whatever it was before:
        // the pin is the operator's word and it wins on every login.
        const promote = pinned && (existing.kind !== 'owner' || !existing.admin);
        await db.account.update({
            where: { id: existing.id },
            data: { updatedAt: new Date(), ...(promote ? { kind: 'owner' as const, admin: true } : {}) }
        });
        if (promote) {
            forgetAccountKind(existing.id);
            log({ module: 'auth', userId: existing.id }, `Account promoted to owner and admin: pinned in ACCOUNT_OWNER_PUBLIC_KEYS`);
        }
        return { id: existing.id, kind: promote ? 'owner' : existing.kind };
    }

    const policy = registrationPolicy();
    if (policy === 'closed' && !pinned) {
        log({ module: 'auth' }, `Registration refused: policy is closed and key is not pinned`);
        return null;
    }
    const kind: AccountKind = policy === 'guest' && !pinned ? 'guest' : 'owner';
    try {
        const created = await db.account.create({
            data: { publicKey: key, kind, admin: pinned },
            select: { id: true, kind: true }
        });
        log({ module: 'auth', userId: created.id }, `Account created as ${kind} (policy ${policy}${pinned ? ', pinned, admin' : ''})`);
        return created;
    } catch (error) {
        // Two first logins with the same key at once: the loser re-reads the
        // row the winner wrote. Any other failure is real and propagates.
        const again = await db.account.findUnique({
            where: { publicKey: key },
            select: { id: true, kind: true }
        });
        if (again) {
            return again;
        }
        throw error;
    }
}

/**
 * The kind of an account, cached briefly. requireOwner runs on every
 * owner-only request and the kind of an account changes only through
 * registerOrLogin above, which invalidates the entry it changes.
 */
const KIND_TTL_MS = 60_000;
const kinds = new Map<string, { kind: AccountKind; admin: boolean; until: number }>();

async function readKind(userId: string): Promise<{ kind: AccountKind; admin: boolean } | null> {
    const now = Date.now();
    const cached = kinds.get(userId);
    if (cached && cached.until > now) {
        return cached;
    }
    const account = await db.account.findUnique({
        where: { id: userId },
        select: { kind: true, admin: true }
    });
    if (!account) {
        kinds.delete(userId);
        return null;
    }
    const entry = { kind: account.kind, admin: account.admin ?? false, until: now + KIND_TTL_MS };
    kinds.set(userId, entry);
    return entry;
}

export async function getAccountKind(userId: string): Promise<AccountKind | null> {
    return (await readKind(userId))?.kind ?? null;
}

/** May flip other accounts' kind. Same cache, same invalidation as the kind. */
export async function isAccountAdmin(userId: string): Promise<boolean> {
    return (await readKind(userId))?.admin ?? false;
}

export function forgetAccountKind(userId: string): void {
    kinds.delete(userId);
}
