import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { distEntryIsComplete, readDistStamp, sameStamp } from './stamp'

let dir: string

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'drove172-stamp-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('readDistStamp', () => {
    it('is null for a path that is not there', () => {
        expect(readDistStamp(join(dir, 'index.mjs'))).toBeNull()
    })

    it('is null for a directory', () => {
        mkdirSync(join(dir, 'index.mjs'))
        expect(readDistStamp(join(dir, 'index.mjs'))).toBeNull()
    })

    it('hashes the entry, which is a kilobyte of chunk names', () => {
        const path = join(dir, 'index.mjs')
        writeFileSync(path, "import './index-AAAA.mjs';\n")
        const stamp = readDistStamp(path)
        expect(stamp?.hash).toMatch(/^[0-9a-f]{64}$/)
        expect(stamp?.size).toBe(27)
    })
})

describe('sameStamp', () => {
    it('follows the content, so a rebuild that changed nothing is not a change', () => {
        // Otherwise every `make build-cli` bounces every open session, because
        // pkgroll rewrites the entry whether or not the code moved.
        const path = join(dir, 'index.mjs')
        writeFileSync(path, "import './index-AAAA.mjs';\n")
        const before = readDistStamp(path)
        utimesSync(path, new Date(0), new Date(0))
        writeFileSync(path, "import './index-AAAA.mjs';\n")
        expect(sameStamp(before, readDistStamp(path))).toBe(true)
    })

    it('sees a change when a chunk name moves', () => {
        const path = join(dir, 'index.mjs')
        writeFileSync(path, "import './index-AAAA.mjs';\n")
        const before = readDistStamp(path)
        writeFileSync(path, "import './index-BBBB.mjs';\n")
        expect(sameStamp(before, readDistStamp(path))).toBe(false)
    })

    it('is false whenever either side could not be read', () => {
        expect(sameStamp(null, { mtimeMs: 1, size: 1, hash: 'a' })).toBe(false)
        expect(sameStamp({ mtimeMs: 1, size: 1, hash: 'a' }, null)).toBe(false)
    })

    it('falls back to mtime and size when neither side could be hashed', () => {
        expect(sameStamp({ mtimeMs: 1, size: 2, hash: null }, { mtimeMs: 1, size: 2, hash: null })).toBe(true)
        expect(sameStamp({ mtimeMs: 1, size: 2, hash: null }, { mtimeMs: 9, size: 2, hash: null })).toBe(false)
    })
})

describe('distEntryIsComplete', () => {
    it('is false while a chunk the entry names is still missing', () => {
        // The window between pkgroll writing the entry and writing its chunks.
        // Relaunching into it hands the pane a bundle that cannot start.
        const path = join(dir, 'index.mjs')
        writeFileSync(path, "import './index-AAAA.mjs';\nimport 'chalk';\n")
        expect(distEntryIsComplete(path)).toBe(false)
    })

    it('is true once every relative chunk is on disk', () => {
        const path = join(dir, 'index.mjs')
        writeFileSync(join(dir, 'index-AAAA.mjs'), 'export const a = 1\n')
        writeFileSync(path, "import './index-AAAA.mjs';\nimport 'chalk';\n")
        expect(distEntryIsComplete(path)).toBe(true)
    })

    it('ignores bare specifiers, which resolve through node_modules', () => {
        const path = join(dir, 'index.mjs')
        writeFileSync(path, "import 'chalk';\nimport 'node:fs';\n")
        expect(distEntryIsComplete(path)).toBe(true)
    })

    it('follows re-exports as well as imports', () => {
        const path = join(dir, 'index.mjs')
        writeFileSync(path, "export { x } from './lib-BBBB.mjs';\n")
        expect(distEntryIsComplete(path)).toBe(false)
        writeFileSync(join(dir, 'lib-BBBB.mjs'), 'export const x = 1\n')
        expect(distEntryIsComplete(path)).toBe(true)
    })

    it('is false for an entry that is not there at all', () => {
        expect(distEntryIsComplete(join(dir, 'index.mjs'))).toBe(false)
    })
})
