/**
 * What an ACP `session/prompt` carries when the phone attached an image
 * (DROVE-378).
 *
 * `AcpBackend.sendPrompt` used to hardcode exactly one block — `{type:'text'}`
 * — so an image sent from the phone had nowhere to go even though ACP has
 * carried `ContentBlock::Image` since 0.1. OpenCode 1.18.20 answers
 * `initialize` with `promptCapabilities.image: true`; measured, not assumed.
 *
 * Two shapes, and which one you get is the agent's own answer, never a guess:
 *
 *  - `image: true` — the bytes ride the prompt as base64 image blocks, so the
 *    model sees the picture itself and no file is written anywhere.
 *  - otherwise — the image is already on disk (see `stageHarnessAttachments`)
 *    and the prompt says where. ACP guarantees `Text` and `ResourceLink` on
 *    every agent, so the link goes alongside a sentence naming the path: the
 *    link is what a good client renders, the sentence is what makes a model
 *    with only a read tool actually open it.
 *
 * Pure by construction — no connection, no disk — because the thing worth
 * pinning is which blocks come out for which capability, and that should be
 * checkable without an agent running.
 */

import type { ContentBlock } from '@agentclientprotocol/sdk'

import type { StagedHarnessAttachment } from '@/utils/harnessAttachments'
import { withStagedAttachmentNote } from '@/utils/harnessAttachments'

export type AcpImageAttachment = {
    /** Raw bytes, base64-encoded by the caller so this stays pure. */
    base64: string
    mimeType: string
    name: string
}

/**
 * The prompt blocks for a turn.
 *
 * `text` may be empty: an image with no words is a real message on every
 * harness that takes images, and dropping it is what the ACP runner used to do.
 */
export function buildAcpPromptBlocks(opts: {
    text: string
    /** Decoded images, for an agent that advertised `promptCapabilities.image`. */
    images?: AcpImageAttachment[]
    /** Images already written to disk, for an agent that did not. */
    staged?: StagedHarnessAttachment[]
}): ContentBlock[] {
    const images = opts.images ?? []
    const staged = opts.staged ?? []
    const blocks: ContentBlock[] = []

    if (images.length > 0) {
        // Images lead so the words that follow can refer to them.
        for (const image of images) {
            blocks.push({
                type: 'image',
                mimeType: image.mimeType,
                data: image.base64,
            })
        }
        const text = opts.text.trim()
        if (text.length > 0) {
            blocks.push({ type: 'text', text: opts.text })
        }
        return blocks
    }

    if (staged.length > 0) {
        blocks.push({ type: 'text', text: withStagedAttachmentNote(opts.text, staged) })
        for (const file of staged) {
            blocks.push({
                type: 'resource_link',
                uri: pathToFileUri(file.path),
                name: basename(file.path),
                mimeType: file.mimeType,
            })
        }
        return blocks
    }

    blocks.push({ type: 'text', text: opts.text })
    return blocks
}

/** `file://` for an absolute POSIX or Windows path, with each segment escaped. */
export function pathToFileUri(path: string): string {
    const normalized = path.replace(/\\/g, '/')
    const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`
    return `file://${withLeadingSlash.split('/').map(encodeURIComponent).join('/')}`
}

function basename(path: string): string {
    const parts = path.replace(/\\/g, '/').split('/')
    return parts[parts.length - 1] || path
}
