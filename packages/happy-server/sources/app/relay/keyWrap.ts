import nacl from "tweetnacl";

/**
 * The one wrapped-key layout every side writes and opens (DROVE-388):
 *
 *   0x00 | ephemeral public key (32) | nonce (24) | crypto_box(data key)
 *
 * libsodiumEncryptForPublicKey in happy-cli and encryptBox in happy-app
 * write it for the owner's box key; the relay writes it for a grantee's box
 * key on a managed session; a session's escrowKey is the same layout to the
 * relay's own box key. crypto_box of a 32-byte key is 32 bytes plus a 16-byte tag.
 */
export const WRAPPED_KEY_MIN_LENGTH = 1 + 32 + 24 + 32 + 16;

export function isWrappedKeyShaped(bytes: Uint8Array): boolean {
    return bytes.length >= WRAPPED_KEY_MIN_LENGTH && bytes[0] === 0;
}

export function wrapToPublicKey(dataKey: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array<ArrayBuffer> {
    const ephemeral = nacl.box.keyPair();
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const box = nacl.box(dataKey, nonce, recipientPublicKey, ephemeral.secretKey);
    const out = new Uint8Array(1 + ephemeral.publicKey.length + nonce.length + box.length);
    out[0] = 0;
    out.set(ephemeral.publicKey, 1);
    out.set(nonce, 1 + ephemeral.publicKey.length);
    out.set(box, 1 + ephemeral.publicKey.length + nonce.length);
    return out;
}

/** Null when the bytes are not this layout or do not open with the key. */
export function openWithSecretKey(wrapped: Uint8Array, secretKey: Uint8Array): Uint8Array<ArrayBuffer> | null {
    if (!isWrappedKeyShaped(wrapped)) {
        return null;
    }
    const ephemeralPublicKey = wrapped.slice(1, 33);
    const nonce = wrapped.slice(33, 57);
    const box = wrapped.slice(57);
    const opened = nacl.box.open(box, nonce, ephemeralPublicKey, secretKey);
    return opened ? new Uint8Array(opened) : null;
}
