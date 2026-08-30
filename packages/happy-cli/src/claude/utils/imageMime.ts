/**
 * Detect the image media type Claude accepts from the decrypted blob's
 * magic-byte header. The wire-supplied mimeType is unreliable (iOS picker
 * reports things like "image/heic" or no value at all), and the Anthropic
 * API enforces a strict enum on `image.source.base64.media_type`. Returning
 * null when the bytes don't match a supported format causes the caller to
 * drop the attachment instead of shipping an invalid request that the API
 * rejects with HTTP 400.
 *
 * Lived in claudeRemoteLauncher until DROVE-38, when the local pane path
 * needed the same answer to name a file on disk.
 */
export type ClaudeImageMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export function detectClaudeImageMime(bytes: Uint8Array): ClaudeImageMime | null {
    if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
        return 'image/png';
    }
    if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
        return 'image/jpeg';
    }
    if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
        return 'image/gif';
    }
    if (
        bytes.length >= 12 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) {
        return 'image/webp';
    }
    return null;
}

export const extensionFor: Record<ClaudeImageMime, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
};
