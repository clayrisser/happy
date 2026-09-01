import { describe, expect, it } from 'vitest'
import { statusDotColors } from '@slopus/happy-wire'

import {
    createDotPublisher,
    dotPublishBody,
    dotStateFor,
    type DotPublishBody,
} from './dotPublish'

const idle = { mainWorking: false, toolRunning: false, compacting: false }

describe('dotStateFor', () => {
    it('draws connected when nothing is happening', () => {
        expect(dotStateFor(idle)).toBe('connected')
    })

    it('draws working while the main thread is busy — the state DROVE-247 was missing', () => {
        expect(dotStateFor({ ...idle, mainWorking: true })).toBe('working')
    })

    it('still says working while a tool runs, because the dot is about the session', () => {
        expect(dotStateFor({ mainWorking: true, toolRunning: true, compacting: false })).toBe('working')
    })

    it('lets a compaction outrank working (DROVE-257)', () => {
        expect(dotStateFor({ mainWorking: true, toolRunning: false, compacting: true })).toBe('compacting')
    })

    /**
     * The failure DROVE-257 measured: a compaction runs with no tool open, no
     * transcript movement and no fetch in flight, so `mainWorking` is false for
     * the whole pass. The observed latch has to carry it alone.
     */
    it('draws compacting even when every other term reads idle', () => {
        expect(dotStateFor({ ...idle, compacting: true })).toBe('compacting')
    })
})

describe('dotPublishBody', () => {
    it('hands the renderer the app’s own palette, so nothing downstream keeps a table', () => {
        expect(dotPublishBody('working').palette).toEqual(statusDotColors)
    })

    it('names exactly the two states DROVE-231 blinks', () => {
        expect(dotPublishBody('connected').blinks.sort()).toEqual(['compacting', 'working'])
    })

    it('carries the staleness threshold rather than making the bus invent one', () => {
        expect(dotPublishBody('connected').staleMs).toBe(120_000)
    })
})

describe('createDotPublisher', () => {
    function harness(id: string | null = 'sess-1') {
        const sent: { id: string, body: DotPublishBody }[] = []
        let sessionId = id
        const pub = createDotPublisher(
            () => sessionId,
            async (i, body) => { sent.push({ id: i, body }) },
        )
        return { sent, pub, name: (next: string | null) => { sessionId = next } }
    }

    it('publishes the first state it resolves', () => {
        const h = harness()
        h.pub.sync({ ...idle, mainWorking: true })
        expect(h.sent.map((s) => s.body.state)).toEqual(['working'])
        expect(h.sent[0].id).toBe('sess-1')
    })

    it('says nothing while the state holds — onLiveStatus fires about once a second', () => {
        const h = harness()
        h.pub.sync({ ...idle, mainWorking: true })
        h.pub.sync({ ...idle, mainWorking: true })
        h.pub.sync({ ...idle, mainWorking: true })
        expect(h.sent).toHaveLength(1)
    })

    it('publishes every transition', () => {
        const h = harness()
        h.pub.sync(idle)
        h.pub.sync({ ...idle, mainWorking: true })
        h.pub.sync({ mainWorking: true, toolRunning: false, compacting: true })
        h.pub.sync(idle)
        expect(h.sent.map((s) => s.body.state)).toEqual(['connected', 'working', 'compacting', 'connected'])
    })

    /**
     * `session.sessionId` is null until the SessionStart hook names the Claude
     * session. Remembering a state we never sent would swallow the first real
     * publish, which is the one that turns the dot blue on the first turn.
     */
    it('sends nothing without a session id, and still sends that state once the id lands', () => {
        const h = harness(null)
        h.pub.sync({ ...idle, mainWorking: true })
        expect(h.sent).toHaveLength(0)
        h.name('sess-late')
        h.pub.sync({ ...idle, mainWorking: true })
        expect(h.sent.map((s) => s.body.state)).toEqual(['working'])
        expect(h.sent[0].id).toBe('sess-late')
    })

    it('goes quiet after dispose, so a teardown cannot leave working in flight', () => {
        const h = harness()
        h.pub.sync({ ...idle, mainWorking: true })
        h.pub.dispose()
        h.pub.sync(idle)
        expect(h.sent.map((s) => s.body.state)).toEqual(['working'])
    })

    it('reports the last state it sent', () => {
        const h = harness()
        expect(h.pub.last()).toBeNull()
        h.pub.sync({ ...idle, compacting: true })
        expect(h.pub.last()).toBe('compacting')
    })
})
