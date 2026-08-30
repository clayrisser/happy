/**
 * Getting a phone image in front of the Claude in a tmux pane (DROVE-38).
 *
 * The app uploads an image as an encrypted file event, the CLI downloads and
 * decrypts it, and the bytes ride the message queue as `attachments`. Remote
 * mode turns them into SDK image blocks. The LOCAL path never looked at them:
 * a pane session takes the queue item, hands `.message` to the inbox socket
 * or the pane, and the bytes it already decrypted are dropped on the floor.
 * Clay sent screenshots from the phone for an hour and the session answered
 * "can you see my screenshot" with a grep of an empty uploads/ dir.
 *
 * Both carriers a pane session has are text. The inbox socket frames
 * `content` as a string, and the pane is keystrokes. So the image goes to
 * DISK, at the path Claude Code itself uses for a pasted image —
 * `<config dir>/uploads/<session id>/<hash>-<name>` — and the path goes into
 * the text, where Claude reads it with its Read tool in the same turn. That
 * is also where Clay's own rules already say to look for an image he pasted,
 * so a screenshot from the phone and one from the keyboard end up side by
 * side.
 *
 * Nothing here can cost the message. A blob whose bytes are not an image
 * Claude accepts is skipped with a debug line; a write that fails is skipped
 * the same way; the text always goes through.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { PendingAttachment } from '@/utils/MessageQueue2'
import { logger } from '@/ui/logger'

import { detectClaudeImageMime, extensionFor } from './imageMime'

export interface StagedAttachment {
    path: string
    mime: string
    bytes: number
}

/**
 * Write each image attachment under `<configDir>/uploads/<sessionId>/` and
 * return where they landed. Idempotent for identical bytes: the name carries
 * a content hash, so a retried message overwrites its own file rather than
 * minting a second one.
 */
export function stageAttachments(opts: {
    attachments: PendingAttachment[] | undefined
    configDir: string
    sessionId: string
}): StagedAttachment[] {
    const { attachments, configDir, sessionId } = opts
    if (!attachments || attachments.length === 0) return []

    const dir = join(configDir, 'uploads', sessionId)
    const staged: StagedAttachment[] = []
    for (const att of attachments) {
        const mime = detectClaudeImageMime(att.data)
        if (!mime) {
            logger.debug(`[local] skipping attachment with no image magic bytes: ${att.name} (claimed ${att.mimeType})`)
            continue
        }
        const hash = createHash('sha256').update(att.data).digest('hex').slice(0, 12)
        const stem = safeStem(att.name)
        const path = join(dir, `${hash}-${stem}.${extensionFor[mime]}`)
        try {
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
            writeFileSync(path, att.data)
            staged.push({ path, mime, bytes: att.data.byteLength })
            logger.debug(`[local] staged attachment ${att.name} -> ${path} (${att.data.byteLength} bytes)`)
        } catch (err) {
            logger.debug(`[local] could not stage attachment ${att.name}: ${String(err)}`)
        }
    }
    return staged
}

/**
 * The text Claude actually receives. The path is spelled out and the ask is
 * explicit, because a bare path in a sentence is easy to read as prose.
 * Nothing is appended when nothing was staged.
 */
export function withAttachmentNote(text: string, staged: StagedAttachment[]): string {
    if (staged.length === 0) return text
    const lines = staged.map((s, i) => `[Image ${i + 1}: ${s.path}]`)
    const lead = staged.length === 1
        ? 'An image was attached from the phone. Read it with the Read tool before answering:'
        : `${staged.length} images were attached from the phone. Read each with the Read tool before answering:`
    const body = text.trim()
    return body ? `${body}\n\n${lead}\n${lines.join('\n')}` : `${lead}\n${lines.join('\n')}`
}

/** A filename stem safe on every filesystem, from whatever the picker sent. */
function safeStem(name: string): string {
    const base = (name || 'image').replace(/\.[A-Za-z0-9]+$/, '')
    const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
    return (cleaned || 'image').slice(0, 60)
}
