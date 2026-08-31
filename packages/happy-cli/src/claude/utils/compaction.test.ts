import { describe, expect, it } from 'vitest'

import { createCompactionLatch } from './compaction'

describe('createCompactionLatch', () => {
    const now = 1_700_000_000_000

    it('is empty until PreCompact fires', () => {
        expect(createCompactionLatch().read(now)).toBeNull()
    })

    it('holds the trigger and the start', () => {
        const latch = createCompactionLatch()
        latch.begin('auto', now)
        expect(latch.read(now + 5_000)).toEqual({ startedAt: now, trigger: 'auto' })
    })

    it('keeps the FIRST start when PreCompact fires twice', () => {
        // The clock the app draws is the pass's own, and a second hook firing
        // mid-pass would restart it and make the phone disagree with the
        // terminal's `(1m 55s, …)`.
        const latch = createCompactionLatch()
        latch.begin('auto', now)
        latch.begin('auto', now + 30_000)
        expect(latch.read(now + 30_000)!.startedAt).toBe(now)
    })

    it('lets go on end', () => {
        const latch = createCompactionLatch()
        latch.begin('manual', now)
        latch.end(now + 1_000)
        expect(latch.read(now + 1_000)).toBeNull()
    })

    it('lets go on its own rather than leave a purple dot on an idle session', () => {
        // The end signals are messages from a process that can die
        // mid-compaction. A latch nobody clears is worse than the green dot it
        // replaces, because it is a lie that never corrects itself.
        const latch = createCompactionLatch(60_000)
        latch.begin('auto', now)
        expect(latch.read(now + 59_999)).not.toBeNull()
        expect(latch.read(now + 60_001)).toBeNull()
    })

    it('takes a percentage only while something is latched, and clamps it', () => {
        const latch = createCompactionLatch()
        latch.progress(38)
        expect(latch.read(now)).toBeNull()
        latch.begin('auto', now)
        latch.progress(38.4)
        expect(latch.read(now)!.percent).toBe(38)
        latch.progress(140)
        expect(latch.read(now)!.percent).toBe(100)
        latch.progress(Number.NaN)
        expect(latch.read(now)!.percent).toBe(100)
    })
})
