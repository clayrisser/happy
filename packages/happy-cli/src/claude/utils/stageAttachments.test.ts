/**
 * A phone image lands on disk where Claude can Read it (DROVE-38).
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } }))

import { stageAttachments, withAttachmentNote } from './stageAttachments'

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9])
const junk = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'stage-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('staging phone attachments for a pane session', () => {
    it('writes the bytes under <configDir>/uploads/<sessionId>/ with a content hash in the name', () => {
        const staged = stageAttachments({
            attachments: [{ data: png, mimeType: 'image/heic', name: 'IMG_0042.HEIC' }],
            configDir: root,
            sessionId: 'sess-1',
        })
        expect(staged).toHaveLength(1)
        // Named by what the bytes ARE, not what iOS claimed.
        expect(staged[0].path).toMatch(/\/uploads\/sess-1\/[0-9a-f]{12}-IMG_0042\.png$/)
        expect(staged[0].mime).toBe('image/png')
        expect(readFileSync(staged[0].path)).toEqual(Buffer.from(png))
    })

    it('skips bytes that are not an image Claude accepts, and never throws', () => {
        const staged = stageAttachments({
            attachments: [
                { data: junk, mimeType: 'image/png', name: 'lies.png' },
                { data: jpeg, mimeType: '', name: '' },
            ],
            configDir: root,
            sessionId: 'sess-1',
        })
        expect(staged).toHaveLength(1)
        expect(staged[0].path).toMatch(/-image\.jpg$/)
        expect(readdirSync(join(root, 'uploads', 'sess-1'))).toHaveLength(1)
    })

    it('is idempotent for the same bytes: a retried send does not mint a second file', () => {
        const att = { data: png, mimeType: 'image/png', name: 'shot.png' }
        stageAttachments({ attachments: [att], configDir: root, sessionId: 's' })
        stageAttachments({ attachments: [att], configDir: root, sessionId: 's' })
        expect(readdirSync(join(root, 'uploads', 's'))).toHaveLength(1)
    })

    it('returns nothing and touches nothing when there are no attachments', () => {
        expect(stageAttachments({ attachments: undefined, configDir: root, sessionId: 's' })).toEqual([])
        expect(stageAttachments({ attachments: [], configDir: root, sessionId: 's' })).toEqual([])
        expect(existsSync(join(root, 'uploads'))).toBe(false)
    })
})

describe('the text Claude receives', () => {
    it('is untouched when nothing was staged', () => {
        expect(withAttachmentNote('hello', [])).toBe('hello')
    })

    it('names the path and asks for a Read, so it is not mistaken for prose', () => {
        const text = withAttachmentNote('can you see my screenshot', [{ path: '/x/uploads/s/ab-shot.png', mime: 'image/png', bytes: 3 }])
        expect(text).toContain('can you see my screenshot')
        expect(text).toContain('Read it with the Read tool')
        expect(text).toContain('[Image 1: /x/uploads/s/ab-shot.png]')
    })

    it('works with no text at all, which is how a bare photo arrives', () => {
        const text = withAttachmentNote('   ', [{ path: '/p.png', mime: 'image/png', bytes: 1 }])
        expect(text.startsWith('An image was attached')).toBe(true)
        expect(text).toContain('[Image 1: /p.png]')
    })

    it('numbers several', () => {
        const text = withAttachmentNote('two', [
            { path: '/a.png', mime: 'image/png', bytes: 1 },
            { path: '/b.jpg', mime: 'image/jpeg', bytes: 1 },
        ])
        expect(text).toContain('2 images were attached')
        expect(text).toContain('[Image 2: /b.jpg]')
    })
})
