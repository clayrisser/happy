/**
 * One attachment path for every harness that is not Claude or Codex (DROVE-378).
 *
 * DROVE-38 got a phone image in front of a Claude pane, and Codex grew its own
 * `localImage` route. Everybody else — opencode, gemini, pi, cursor, agy,
 * openclaw — never subscribed to the file event at all, so the bytes sat in
 * `pendingFileEvents` and were dropped without a word. The app then hid the
 * composer's plus on those sessions, which is how "the phone is not letting me
 * submit an image" reads on an OpenCode session: not a refusal, an absence.
 *
 * Two deliveries, because harnesses split two ways and only two:
 *
 *  - a harness that takes image bytes on the wire gets them (ACP's
 *    `ContentBlock` of type `image`, which OpenCode 1.18 advertises as
 *    `promptCapabilities.image`);
 *  - a harness whose only carrier is text gets the image ON DISK and the path
 *    spelled out in the prompt, which every one of them can then read with its
 *    own read tool. That is the same bargain `stageAttachments` struck for the
 *    Claude pane, and it is why this file borrows its shape.
 *
 * Nothing here may cost the message. Bytes that are not an image are skipped
 * with a debug line, a write that fails is skipped the same way, and the text
 * always goes through.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ApiSessionClient } from '@/api/apiSession'
import type { FileEventMessage } from '@/api/types'
import { configuration } from '@/configuration'
import { logger } from '@/ui/logger'
import type { PendingAttachment } from '@/utils/MessageQueue2'

type AttachmentDownloader = Pick<ApiSessionClient, 'downloadAndDecryptAttachment'>

/**
 * Download and decrypt one file event into the bytes the queue carries.
 *
 * Flavor-agnostic on purpose: Codex had its own copy of this
 * (`downloadCodexFileEventAttachment`) and every new harness would have grown
 * another. `tag` is only the log prefix.
 */
export async function downloadFileEventAttachment(
    session: AttachmentDownloader,
    fileEvent: FileEventMessage,
    tag: string,
): Promise<PendingAttachment | null> {
    const ev = fileEvent.content.data.ev
    try {
        const decrypted = await session.downloadAndDecryptAttachment(ev.ref)
        if (!decrypted) {
            logger.debug(`[${tag}] Failed to decrypt attachment`)
            return null
        }
        return {
            data: decrypted,
            mimeType: ev.mimeType ?? 'image/jpeg',
            name: ev.name,
        }
    } catch (error) {
        logger.debug(`[${tag}] Failed to download attachment`, {
            errorName: error instanceof Error ? error.name : typeof error,
        })
        return null
    }
}

export type HarnessImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

const extensionForMime: Record<HarnessImageMime, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
}

/**
 * The mime a harness will actually accept, read off the MAGIC BYTES.
 *
 * The picker's claimed mime type is not trusted, because the iOS picker
 * reports `image/jpeg` for a HEIC it has not converted and the model then
 * rejects the turn. Same four formats Claude and Codex settled on.
 */
export function detectHarnessImageMime(data: Uint8Array): HarnessImageMime | null {
    if (
        data.length >= 8
        && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
        && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a
    ) {
        return 'image/png'
    }
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
        return 'image/jpeg'
    }
    if (data.length >= 6) {
        const header = new TextDecoder().decode(data.slice(0, 6))
        if (header === 'GIF87a' || header === 'GIF89a') {
            return 'image/gif'
        }
    }
    if (
        data.length >= 12
        && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
        && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
    ) {
        return 'image/webp'
    }
    return null
}

export type StagedHarnessAttachment = {
    path: string
    mimeType: HarnessImageMime
    bytes: number
}

/**
 * Where a harness that reads files finds an image the phone sent.
 *
 * Under the happy home dir, never under `~/.claude` — that directory belongs
 * to Claude Code's own uploads and an OpenCode session writing into it would
 * put a stranger's image in front of the next Claude that looked (DROVE-336).
 */
export function resolveHarnessAttachmentDir(opts: {
    sessionId: string
    harness: string
    homeDir?: string
}): string {
    const root = opts.homeDir ?? configuration.happyHomeDir
    return join(root, 'harness-attachments', safeSegment(opts.harness), safeSegment(opts.sessionId))
}

/**
 * Write each image attachment to disk and say where it landed.
 *
 * Idempotent for identical bytes: the filename carries a content hash, so a
 * retried message overwrites its own file instead of minting a second one.
 */
export function stageHarnessAttachments(opts: {
    attachments: PendingAttachment[] | undefined
    dir: string
}): StagedHarnessAttachment[] {
    const { attachments, dir } = opts
    if (!attachments || attachments.length === 0) return []

    const staged: StagedHarnessAttachment[] = []
    for (const att of attachments) {
        const mimeType = detectHarnessImageMime(att.data)
        if (!mimeType) {
            logger.debug(`[attachments] skipping attachment with no image magic bytes: ${att.name} (claimed ${att.mimeType})`)
            continue
        }
        const hash = createHash('sha256').update(att.data).digest('hex').slice(0, 12)
        const path = join(dir, `${hash}-${safeStem(att.name)}.${extensionForMime[mimeType]}`)
        try {
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
            writeFileSync(path, att.data, { mode: 0o600 })
            staged.push({ path, mimeType, bytes: att.data.byteLength })
        } catch (err) {
            logger.debug(`[attachments] could not stage ${att.name}: ${String(err)}`)
        }
    }
    return staged
}

/**
 * The text a text-only harness actually receives.
 *
 * The path is spelled out and the ask is explicit, because a bare path in a
 * sentence reads as prose and gets answered instead of opened.
 */
export function withStagedAttachmentNote(text: string, staged: StagedHarnessAttachment[]): string {
    if (staged.length === 0) return text
    const lines = staged.map((s, i) => `[Image ${i + 1}: ${s.path}]`)
    const lead = staged.length === 1
        ? 'An image was attached from the phone. Read it from this path before answering:'
        : `${staged.length} images were attached from the phone. Read each from these paths before answering:`
    const body = text.trim()
    return body ? `${body}\n\n${lead}\n${lines.join('\n')}` : `${lead}\n${lines.join('\n')}`
}

function safeSegment(value: string): string {
    const cleaned = (value || 'unknown').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '')
    return (cleaned || 'unknown').slice(0, 80)
}

function safeStem(name: string): string {
    const base = (name || 'image').replace(/\.[A-Za-z0-9]+$/, '')
    const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
    return (cleaned || 'image').slice(0, 60)
}

/**
 * Subscribe a harness to the phone's file events.
 *
 * Every runner needs the same three lines and each one that grew its own copy
 * drifted, so this is the one place a harness opts in. It is deliberately
 * separate from the drain: downloads start the moment the event lands, and the
 * turn only waits for them when the text arrives.
 */
export function subscribeHarnessAttachments(
    session: Pick<ApiSessionClient, 'onFileEvent' | 'trackAttachmentDownload' | 'downloadAndDecryptAttachment'>,
    harness: string,
): void {
    session.onFileEvent((fileEvent) => {
        const ev = fileEvent.content.data.ev
        logger.debug(`[${harness}] File event received`, {
            size: ev.size,
            hasMimeType: Boolean(ev.mimeType),
        })
        session.trackAttachmentDownload(downloadFileEventAttachment(session, fileEvent, harness))
    })
}

/**
 * The prompt a TEXT-ONLY harness receives for a turn that carried images.
 *
 * pi, cursor, agy and openclaw all deliver a turn as a string — argv, a JSONL
 * `prompt` field, a websocket `chat.send`. None can carry bytes, and all four
 * have a read tool. So the image goes to disk and the path goes in the words.
 */
export function textWithHarnessAttachments(opts: {
    text: string
    attachments: PendingAttachment[] | undefined
    sessionId: string
    harness: string
}): string {
    const staged = stageHarnessAttachments({
        attachments: opts.attachments,
        dir: resolveHarnessAttachmentDir({ sessionId: opts.sessionId, harness: opts.harness }),
    })
    return withStagedAttachmentNote(opts.text, staged)
}
