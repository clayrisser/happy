/**
 * A Read of a picture the phone sent, drawn from the phone's own copy
 * (DROVE-366).
 *
 * The transcript row is the CLI's `Read` of
 * `<config dir>/uploads/<session>/<hash>-<name>.<ext>`, a path on the MAC. It
 * normally carries the file's base64 in its result, so the row draws. Two ways
 * that fails: the result is over `toolResultCharacterCap` and the whole thing
 * is replaced by a truncation note, or it never carried the bytes at all. The
 * row then has a picture in it and nothing to show.
 *
 * It does not need the Mac. Those bytes came FROM the phone: sending an image
 * uploads it encrypted and puts a `file` event in the session carrying its
 * `ref`, and the CLI wrote that same blob to the uploads dir for Claude to
 * read. So the landed path and the blob are two names for one upload, and
 * useAttachmentImage already knows how to fetch the blob back.
 *
 * The join is the one DROVE-234 established for `[Image N: /Users/...]`
 * markers, reused here rather than reinvented: the FILENAME, hash prefix and
 * extension stripped, matched against `safeStem(name)` recomputed from the
 * `file` event. The directory is never read, so a `/flip` that moves the
 * account dir out from under the session changes nothing.
 */

import type { Message } from '@/sync/typesMessage';

import {
    transcriptImageAttachment,
    type TranscriptImageAttachment,
} from './crossSessionAttachments';
import { markerStem } from './crossSessionMessage';

/** The 12 hex characters `stageAttachments` puts in front of every name. */
const hashPrefixRe = /^[0-9a-f]{12}-/;

/** The extensions the CLI writes, decided from the file's magic bytes. */
const imageExtensionRe = /\.(?:jpg|jpeg|png|gif|webp)$/i;

/**
 * The stem a landed upload path joins on, or null for every other path.
 *
 * Three things have to hold, and all three are cheap: an `uploads` segment in
 * the directory, the CLI's hash prefix on the basename, and an image
 * extension. A repo file called `photo.png` matches none of them, which is the
 * point: this must not claim a picture it cannot supply.
 */
export function uploadedImageStem(filePath: string | null | undefined): string | null {
    if (typeof filePath !== 'string' || filePath.length === 0) {
        return null;
    }
    const cut = filePath.lastIndexOf('/');
    if (cut < 0) {
        return null;
    }
    const directory = filePath.slice(0, cut);
    const base = filePath.slice(cut + 1);
    if (!directory.split('/').includes('uploads')) {
        return null;
    }
    if (!hashPrefixRe.test(base) || !imageExtensionRe.test(base)) {
        return null;
    }
    const stem = markerStem(filePath);
    return stem.length > 0 ? stem : null;
}

/** The path a read-shaped tool call names, or null. */
export function toolReadPath(input: unknown): string | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return null;
    }
    const record = input as Record<string, unknown>;
    const named = record.file_path ?? record.path;
    return typeof named === 'string' && named.length > 0 ? named : null;
}

/**
 * The upload behind a Read of a landed path, or null.
 *
 * `messages` is the array storage keeps: NEWEST FIRST, so the first match is
 * the most recent upload of that name. Two different photos that shared a
 * filename would collide, which is the same caveat the marker join carries and
 * the same reason it does not matter much: the CLI's prefix is 12 hex of the
 * file's own sha256, so one name plus one stem is nearly always one picture.
 */
export function readImageAttachment(
    filePath: string | null | undefined,
    messages: readonly Message[],
): TranscriptImageAttachment | null {
    const stem = uploadedImageStem(filePath);
    if (!stem) {
        return null;
    }
    for (const message of messages) {
        const attachment = transcriptImageAttachment(message);
        if (attachment && attachment.stem === stem) {
            return attachment;
        }
    }
    return null;
}
