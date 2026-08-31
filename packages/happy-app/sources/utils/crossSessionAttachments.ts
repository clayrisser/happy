/**
 * How the picture in `[Image 1: /Users/...]` reaches the phone (DROVE-234).
 *
 * The marker names a file on the MAC, and the phone has no way to open it. It
 * does not need one: the phone is where those bytes came from. Sending an
 * image uploads it encrypted to the server and puts a `file` event in the
 * session carrying its `ref`; the CLI downloads that same blob, writes it to
 * `<config dir>/uploads/<session>/<hash>-<name>.<ext>` for Claude's Read tool,
 * and spells that path into the text. So the marker and the blob are two names
 * for one upload, and the app already knows how to fetch the blob back
 * (useAttachmentImage: download, decrypt with the session blob key, render).
 *
 * The join is the FILENAME, and only the part after the last slash. The CLI
 * builds it as `<12 hex of sha256>-<safeStem(name)>.<ext from magic bytes>`,
 * so stripping the hash and the extension gives back `safeStem(name)`, which
 * this file recomputes from the `file` event's own `name`. The directory is
 * never read, which is what keeps a `/flip` from breaking this: the account
 * dir moved from `~/.claude` to `~/.claude-accounts/<account>/` mid-session,
 * and nothing here notices.
 *
 * Nothing is fetched over RPC. `readFile` exists but refuses paths outside the
 * session's working directory, and uploads/ is not in it.
 */

import type { Message } from '@/sync/typesMessage';

import {
    parsePhoneMessage,
    type CrossSessionImageMarker,
    type CrossSessionSender,
} from './crossSessionMessage';

export type TranscriptImageAttachment = {
    ref: string;
    name: string;
    /** `safeStem(name)`, the key the marker is matched on. */
    stem: string;
    width?: number;
    height?: number;
    thumbhash?: string;
};

export type CrossSessionImage = {
    marker: CrossSessionImageMarker;
    /** Null when no upload in this session matches the marker's filename. */
    attachment: TranscriptImageAttachment | null;
};

export type CrossSessionRender = {
    sender: CrossSessionSender | null;
    body: string;
    images: CrossSessionImage[];
};

export type CrossSessionIndex = {
    /** Only messages that carried a wrapper or a resolvable marker. */
    byMessageId: Map<string, CrossSessionRender>;
    /** Refs a marker took over, so the standalone upload row can stand down. */
    claimedRefs: Set<string>;
};

/**
 * `safeStem` from happy-cli's stageAttachments, byte for byte. It runs on the
 * picker's filename before the file is written, so recomputing it here is what
 * turns a `file` event back into the name on disk.
 */
export function attachmentStem(name: string): string {
    const base = (name || 'image').replace(/\.[A-Za-z0-9]+$/, '');
    const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    return (cleaned || 'image').slice(0, 60);
}

/** The upload behind a `file` tool call, or null for every other message. */
export function transcriptImageAttachment(message: Message): TranscriptImageAttachment | null {
    if (message.kind !== 'tool-call' || message.tool.name !== 'file') return null;
    const input = message.tool.input as {
        ref?: unknown;
        name?: unknown;
        image?: { width?: unknown; height?: unknown; thumbhash?: unknown };
    } | null | undefined;
    if (!input || typeof input.ref !== 'string' || input.ref.length === 0) return null;
    const name = typeof input.name === 'string' ? input.name : '';
    return {
        ref: input.ref,
        name,
        stem: attachmentStem(name),
        width: typeof input.image?.width === 'number' ? input.image.width : undefined,
        height: typeof input.image?.height === 'number' ? input.image.height : undefined,
        thumbhash: typeof input.image?.thumbhash === 'string' ? input.image.thumbhash : undefined,
    };
}

/**
 * Pair each marker with an upload seen earlier in the transcript.
 *
 * `seen` is oldest-first and holds every upload before this message. Same
 * filename twice in one message is the only awkward case: the markers then
 * take the LAST run of matching uploads in order, because the uploads for a
 * message are enqueued immediately before it.
 */
function pairMarkers(
    markers: CrossSessionImageMarker[],
    seen: TranscriptImageAttachment[],
): CrossSessionImage[] {
    const totals = new Map<string, number>();
    for (const marker of markers) {
        totals.set(marker.stem, (totals.get(marker.stem) ?? 0) + 1);
    }
    const used = new Map<string, number>();
    return markers.map((marker) => {
        const candidates = seen.filter((attachment) => attachment.stem === marker.stem);
        const ordinal = used.get(marker.stem) ?? 0;
        used.set(marker.stem, ordinal + 1);
        if (candidates.length === 0) return { marker, attachment: null };
        const at = candidates.length - (totals.get(marker.stem) ?? 1) + ordinal;
        const bounded = at >= 0 && at < candidates.length ? at : candidates.length - 1;
        return { marker, attachment: candidates[bounded] };
    });
}

/**
 * Read every phone envelope in a transcript in one pass.
 *
 * `messages` is the array storage keeps: NEWEST FIRST. Walked backwards so an
 * upload is only ever matched by a marker that came after it.
 */
export function indexCrossSessionMessages(messages: readonly Message[]): CrossSessionIndex {
    const byMessageId = new Map<string, CrossSessionRender>();
    const claimedRefs = new Set<string>();
    const seen: TranscriptImageAttachment[] = [];

    for (let at = messages.length - 1; at >= 0; at -= 1) {
        const message = messages[at];
        const attachment = transcriptImageAttachment(message);
        if (attachment) {
            seen.push(attachment);
            continue;
        }
        if (message.kind !== 'user-text') continue;
        const parsed = parsePhoneMessage(message.displayText || message.text);
        if (parsed.sender === null && parsed.images.length === 0) continue;
        const images = pairMarkers(parsed.images, seen);
        for (const image of images) {
            if (image.attachment) claimedRefs.add(image.attachment.ref);
        }
        byMessageId.set(message.id, { sender: parsed.sender, body: parsed.body, images });
    }

    return { byMessageId, claimedRefs };
}

/**
 * The index for a message array, computed once per array identity.
 *
 * Storage replaces the array on every update, so the entry dies with it. The
 * memo is what lets the renderer and the grouping filter read one answer, and
 * what makes the selector return a stable reference to zustand.
 */
const memo = new WeakMap<object, CrossSessionIndex>();

export function crossSessionIndexFor(messages: readonly Message[]): CrossSessionIndex {
    const key = messages as unknown as object;
    const hit = memo.get(key);
    if (hit) return hit;
    const index = indexCrossSessionMessages(messages);
    memo.set(key, index);
    return index;
}

/** True for an upload row a marker has taken over and now draws itself. */
export function isClaimedAttachmentRow(message: Message, claimedRefs: ReadonlySet<string>): boolean {
    if (claimedRefs.size === 0) return false;
    const attachment = transcriptImageAttachment(message);
    return attachment !== null && claimedRefs.has(attachment.ref);
}
