/**
 * Which build of the CLI this process is running (DROVE-172).
 *
 * A session is one long-lived `dist/index.mjs`. `make build-cli` rewrites that
 * file and `launchctl kickstart` restarts the daemon, and neither touches a
 * launcher that is already up: it keeps executing the bundle node read at
 * spawn. On 2026-08-31 that cost Clay five shipped CLI fixes in one night --
 * his session started 05:34, the bundle carrying them was written 08:53, and
 * he reported the effort picker as still broken because for his process it
 * genuinely was.
 *
 * The daemon has detected its own replacement by `dist/index.mjs` mtime since
 * #1107, and mtime is the right idea. It is not quite the right stamp here,
 * because a session relaunch is disruptive in a way a daemon restart is not:
 * mtime changes on EVERY build, so a no-op rebuild would bounce every open
 * session for nothing.
 *
 * So the content, when it is cheap. pkgroll emits `dist/index.mjs` as a ~1KB
 * entry whose whole body is `import './index-<content hash>.mjs'` lines, so
 * hashing it is free and its bytes change if and only if some chunk's content
 * did. mtime and size stay in the stamp as the fallback for a bundler that
 * stops content-hashing, and as the thing the log line prints.
 */

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { projectPath } from '@/projectPath'

export interface DistStamp {
    mtimeMs: number
    size: number
    /** sha256 of the entry, or null when it was too big to be worth reading. */
    hash: string | null
}

/**
 * Above this the entry is not a thin re-export list any more and hashing it on
 * a timer stops being free. Nothing here has ever been close: the entry is
 * about a kilobyte.
 */
const hashSizeLimit = 2 * 1024 * 1024

/** The bundle a spawned session actually executes. */
export function distEntrypoint(): string {
    return join(projectPath(), 'dist', 'index.mjs')
}

/**
 * The stamp of `path`, or null when it cannot be read.
 *
 * Null is "cannot tell", never "changed": a missing dist is the normal case
 * under vitest and `tsx src/index.ts`, and a build that has deleted dist and
 * not yet written it (`shx rm -rf dist && tsc --noEmit && pkgroll`) spends
 * most of a minute in the same window. Treating either as staleness would
 * relaunch every session in the middle of every build.
 */
export function readDistStamp(path: string): DistStamp | null {
    try {
        const stat = statSync(path)
        if (!stat.isFile()) return null
        let hash: string | null = null
        if (stat.size <= hashSizeLimit) {
            hash = createHash('sha256').update(readFileSync(path)).digest('hex')
        }
        return { mtimeMs: stat.mtimeMs, size: stat.size, hash }
    } catch {
        return null
    }
}

export function sameStamp(a: DistStamp | null, b: DistStamp | null): boolean {
    if (a === null || b === null) return false
    if (a.hash !== null && b.hash !== null) return a.hash === b.hash
    return a.mtimeMs === b.mtimeMs && a.size === b.size
}

/**
 * Is every chunk the entry imports actually on disk?
 *
 * The entry is one file among thirty and there is no promise it is written
 * last. Relaunching between the entry landing and its chunks landing would put
 * the session on a bundle that cannot start, and `bin/drover.mjs` would then
 * be holding a pane with nothing in it. Cheap to rule out: read the ~1KB entry
 * and stat what it names.
 *
 * Only relative specifiers are checked. A bare `import 'chalk'` resolves
 * through node_modules and was already resolvable a moment ago.
 */
export function distEntryIsComplete(path: string): boolean {
    let source: string
    try {
        source = readFileSync(path, 'utf8')
    } catch {
        return false
    }
    const dir = dirname(path)
    const specifiers = source.matchAll(/(?:^|[\s({,;])(?:import|export)[^'"]*?['"](\.[^'"]+)['"]/g)
    for (const match of specifiers) {
        try {
            if (!statSync(resolve(dir, match[1])).isFile()) return false
        } catch {
            return false
        }
    }
    return true
}

/**
 * The stamp of the bundle this process is running, read once at start-up.
 *
 * Read at module init on purpose. `dist/index.mjs` is a single pkgroll entry,
 * so every module behind it initialises milliseconds after node opened the
 * file, which is as close to "what we loaded" as anything can get without node
 * handing us the bytes it read.
 */
export const loadedDistStamp: DistStamp | null = readDistStamp(distEntrypoint())
