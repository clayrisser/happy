/**
 * "The bundle under me has been rebuilt" (DROVE-172).
 *
 * The daemon has done this since #1107 -- `daemon/run.ts` stamps
 * `dist/index.mjs`'s mtime at boot and hands off to a fresh daemon when it
 * changes. This is the same signal for a SESSION, which is the half that was
 * missing: `launchctl kickstart` restarts the daemon and nothing else, so
 * every open session kept running the code it was spawned with.
 *
 * Two rules make it safe to act on.
 *
 * SETTLE. `pnpm build` is `shx rm -rf dist && tsc && pkgroll`. Between those
 * the path is missing, then present and growing. Acting on the first changed
 * stamp would relaunch onto a half-written bundle. So a change has to hold the
 * same stamp across `settleMs` before it counts, and a null read resets the
 * wait rather than reporting anything.
 *
 * LATCH. Once stale, always stale. The gate that acts on this waits for the
 * turn to end, and that wait can outlive another build; going un-stale halfway
 * through would strand the session on the older of two new bundles.
 */

import type { DistStamp } from './stamp'
import { sameStamp } from './stamp'

export interface StaleWatcherOptions {
    /** The stamp of the bundle this process is running. Null disables the watcher. */
    loaded: DistStamp | null
    read: () => DistStamp | null
    /**
     * Are the chunks the new entry names all on disk? The entry is one file
     * among thirty and nothing promises it is written last, so a settled stamp
     * is not on its own proof the bundle can start.
     */
    complete?: () => boolean
    /** How long a changed stamp must hold still before we believe the build finished. */
    settleMs?: number
    now?: () => number
}

export interface StaleWatcher {
    /** Read the bundle once. Returns true the first tick that declares staleness. */
    tick(): boolean
    /** Has the bundle been replaced and settled? Latched. */
    stale(): boolean
    /** The stamp we are running, for the message that explains the relaunch. */
    loaded(): DistStamp | null
    /** The stamp we would relaunch onto, once settled. */
    pending(): DistStamp | null
}

export const defaultSettleMs = 4000

export function createStaleWatcher(opts: StaleWatcherOptions): StaleWatcher {
    const loaded = opts.loaded
    const settleMs = opts.settleMs ?? defaultSettleMs
    const now = opts.now ?? Date.now

    let latched = false
    let candidate: DistStamp | null = null
    let candidateSince = 0

    function tick(): boolean {
        if (latched) return false
        // No stamp at start-up means dev mode (`tsx src/index.ts`, vitest) or an
        // unreadable dist. Never guess staleness from a file we never loaded.
        if (loaded === null) return false

        const current = opts.read()
        if (current === null) {
            // Mid-build, or gone. Not an answer either way, and the wait starts
            // over so the settle window only ever covers a readable file.
            candidate = null
            return false
        }
        if (sameStamp(current, loaded)) {
            candidate = null
            return false
        }
        if (!sameStamp(current, candidate)) {
            candidate = current
            candidateSince = now()
            return false
        }
        if (now() - candidateSince < settleMs) return false
        if (opts.complete !== undefined && !opts.complete()) return false

        latched = true
        return true
    }

    return {
        tick,
        stale: () => latched,
        loaded: () => loaded,
        pending: () => (latched ? candidate : null),
    }
}
