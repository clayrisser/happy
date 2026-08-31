import { describe, expect, it } from 'vitest'

import type { DistStamp } from './stamp'
import { createStaleWatcher } from './staleWatcher'

const loaded: DistStamp = { mtimeMs: 1000, size: 500, hash: 'a' }
const rebuilt: DistStamp = { mtimeMs: 2000, size: 900, hash: 'b' }
const rebuiltAgain: DistStamp = { mtimeMs: 3000, size: 950, hash: 'c' }

function watcherOver(reads: (DistStamp | null)[], clock: number[]) {
    let readAt = 0
    let clockAt = 0
    return createStaleWatcher({
        loaded,
        read: () => reads[Math.min(readAt++, reads.length - 1)],
        settleMs: 100,
        now: () => clock[Math.min(clockAt++, clock.length - 1)],
    })
}

describe('createStaleWatcher', () => {
    it('says nothing while the bundle on disk is the one we loaded', () => {
        const watcher = watcherOver([loaded, loaded], [0, 0])
        expect(watcher.tick()).toBe(false)
        expect(watcher.tick()).toBe(false)
        expect(watcher.stale()).toBe(false)
    })

    it('waits for a changed stamp to hold still before believing the build finished', () => {
        // pnpm build is `rm -rf dist && tsc && pkgroll`, so the file grows
        // between polls. Acting on the first change would relaunch onto half a
        // bundle.
        const watcher = watcherOver([rebuilt, rebuilt], [0, 50])
        expect(watcher.tick()).toBe(false)
        expect(watcher.tick()).toBe(false)
        expect(watcher.stale()).toBe(false)
    })

    it('reports stale once the new stamp has settled', () => {
        const watcher = watcherOver([rebuilt, rebuilt], [0, 500])
        expect(watcher.tick()).toBe(false)
        expect(watcher.tick()).toBe(true)
        expect(watcher.stale()).toBe(true)
        expect(watcher.pending()).toEqual(rebuilt)
    })

    it('restarts the wait when the stamp changes again mid-settle', () => {
        const watcher = watcherOver([rebuilt, rebuiltAgain, rebuiltAgain], [0, 500, 520])
        expect(watcher.tick()).toBe(false)
        expect(watcher.tick()).toBe(false)
        expect(watcher.tick()).toBe(false)
        expect(watcher.stale()).toBe(false)
    })

    it('treats a missing dist as "cannot tell", never as a change', () => {
        // `shx rm -rf dist` opens exactly this window on every build.
        const watcher = watcherOver([null, null, null], [0, 500, 1000])
        expect(watcher.tick()).toBe(false)
        expect(watcher.tick()).toBe(false)
        expect(watcher.tick()).toBe(false)
        expect(watcher.stale()).toBe(false)
    })

    it('does not carry a settle window across the gap where dist was missing', () => {
        const watcher = watcherOver([rebuilt, null, rebuilt], [0, 500, 520])
        expect(watcher.tick()).toBe(false)
        expect(watcher.tick()).toBe(false)
        expect(watcher.tick()).toBe(false)
        expect(watcher.stale()).toBe(false)
    })

    it('stays stale once latched, even if a later build is still in flight', () => {
        // The gate that acts on this waits for the turn to end, and that wait
        // can outlive another build. Going un-stale would strand the session.
        const watcher = watcherOver([rebuilt, rebuilt, null], [0, 500, 600])
        expect(watcher.tick()).toBe(false)
        expect(watcher.tick()).toBe(true)
        expect(watcher.tick()).toBe(false)
        expect(watcher.stale()).toBe(true)
    })

    it('is disabled when the process never read a dist of its own', () => {
        // tsx and vitest both run from src. There is no bundle to be stale
        // against, and guessing one would relaunch every dev session.
        const watcher = createStaleWatcher({ loaded: null, read: () => rebuilt, settleMs: 0, now: () => 0 })
        expect(watcher.tick()).toBe(false)
        expect(watcher.stale()).toBe(false)
    })
})
