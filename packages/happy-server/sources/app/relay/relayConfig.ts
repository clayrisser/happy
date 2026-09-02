import nacl from "tweetnacl";
import { log } from "@/utils/log";
import { openWithSecretKey, wrapToPublicKey } from "./keyWrap";

/**
 * What this relay can do (DROVE-388, decision 0c). A relay has no mode; the
 * mix of private and managed sessions is per session (Session.escrowKey).
 *
 *   RELAY_ESCROW_SECRET_KEY   the relay's own box secret key, 32 bytes as 64
 *                             hex characters, minted and placed by the
 *                             operator; the relay never generates one, since
 *                             a key that appears at boot is a key nobody
 *                             backed up. Set, the relay CAN MANAGE: a session
 *                             whose key is wrapped to this keypair is opened
 *                             and re-wrapped for any member on read. Unset,
 *                             every session is private and stays so.
 *   RELAY_SHARING=on|off      whether a PRIVATE session may be shared at all,
 *                             by the end-to-end per-member wraps the owner's
 *                             app makes. Off unless set, whatever the escrow
 *                             key says: on a relay where "personal chats can't
 *                             be shared ever", sharing means managed.
 *
 * A managed session shares regardless of RELAY_SHARING: managing sharing is
 * what escrow is for. A malformed value of either variable fails the boot,
 * for the same reason ACCOUNT_REGISTRATION does: a typo must not quietly
 * change who can read what.
 */

export function sharingEnabled(): boolean {
    const raw = (process.env.RELAY_SHARING ?? '').trim().toLowerCase();
    if (raw === '' || raw === 'off') {
        return false;
    }
    if (raw === 'on') {
        return true;
    }
    throw new Error(`RELAY_SHARING must be on or off, got "${raw}"`);
}

export interface EscrowKeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
}

let escrow: EscrowKeyPair | null | undefined;

/** The relay's own box keypair; null when the relay cannot manage. */
export function escrowKeyPair(): EscrowKeyPair | null {
    if (escrow !== undefined) {
        return escrow;
    }
    const raw = (process.env.RELAY_ESCROW_SECRET_KEY ?? '').trim();
    if (!raw) {
        escrow = null;
        return escrow;
    }
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
        throw new Error('RELAY_ESCROW_SECRET_KEY must be 32 bytes as 64 hex characters');
    }
    const secretKey = new Uint8Array(Buffer.from(raw, 'hex'));
    const publicKey = nacl.box.keyPair.fromSecretKey(secretKey).publicKey;
    escrow = { publicKey, secretKey };
    return escrow;
}

/** Whether a session on this relay can be managed at all. */
export function canManage(): boolean {
    return escrowKeyPair() !== null;
}

/** Base64 of the relay's escrow public key, for GET /v1/relay; null when it cannot manage. */
export function escrowPublicKeyBase64(): string | null {
    const pair = escrowKeyPair();
    return pair ? Buffer.from(pair.publicKey).toString('base64') : null;
}

/**
 * Open a session's escrow wrap with the relay's key. Null when the relay
 * cannot manage, on a session with no escrow wrap, and on bytes that do not
 * open: the caller treats all three as "cannot wrap for anyone".
 */
export function openEscrowKey(escrowKey: Uint8Array | null | undefined): Uint8Array<ArrayBuffer> | null {
    const pair = escrowKeyPair();
    if (!pair || !escrowKey) {
        return null;
    }
    const opened = openWithSecretKey(escrowKey, pair.secretKey);
    return opened && opened.length === 32 ? opened : null;
}

/**
 * A managed session's key re-wrapped for one member's box public key (hex,
 * as Account.contentPublicKey stores it). Null when the relay cannot open
 * the escrow wrap or the member has no registered key.
 */
export function wrapEscrowedKeyFor(escrowKey: Uint8Array | null | undefined, memberContentPublicKeyHex: string | null | undefined): Uint8Array<ArrayBuffer> | null {
    if (!memberContentPublicKeyHex) {
        return null;
    }
    const dataKey = openEscrowKey(escrowKey);
    if (!dataKey) {
        return null;
    }
    return wrapToPublicKey(dataKey, new Uint8Array(Buffer.from(memberContentPublicKeyHex, 'hex')));
}

/**
 * Validate an escrow wrap a client posted: it must be the layout and it
 * must open with the relay's key to a 32-byte session key. Returns the
 * bytes to store, or null. A relay that cannot manage stores nothing: it
 * has no key to open the wrap with and must not pretend to.
 */
export function acceptEscrowKey(escrowKeyBase64: string | null | undefined): Uint8Array<ArrayBuffer> | null {
    if (!escrowKeyBase64 || !canManage()) {
        return null;
    }
    const bytes = new Uint8Array(Buffer.from(escrowKeyBase64, 'base64'));
    return openEscrowKey(bytes) ? bytes : null;
}

/** Logged once at boot by enableAuthentication; fails the boot on a malformed key or sharing word. */
export function announceRelay(): void {
    const manage = canManage();
    const sharing = sharingEnabled();
    log({ module: 'relay' }, `Relay: ${manage ? 'can manage sessions (escrow key loaded)' : 'cannot manage sessions (no escrow key)'}, private sharing ${sharing ? 'on' : 'off'}`);
}
