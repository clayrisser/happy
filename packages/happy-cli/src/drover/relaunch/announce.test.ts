import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ debug: vi.fn(), execFile: vi.fn() }))
vi.mock('@/ui/logger', () => ({ logger: { debug: mocks.debug } }))
vi.mock('node:child_process', () => ({ execFile: mocks.execFile }))

import { announceRelaunch } from './announce'

describe('announceRelaunch', () => {
    beforeEach(() => {
        mocks.debug.mockClear()
        mocks.execFile.mockClear()
        delete process.env.TMUX
        delete process.env.TMUX_PANE
    })

    /**
     * DROVE-220. The tmux bar and the debug log are both on a Mac Clay is not
     * looking at; the conversation is on his phone. A notice that reaches only
     * the first two is the bug, not the fix.
     */
    it('says it on the phone', () => {
        const phone = vi.fn()
        announceRelaunch('a newer CLI has been built', phone)
        expect(phone).toHaveBeenCalledWith('a newer CLI has been built')
    })

    it('still says it on the phone when there is no tmux', () => {
        const phone = vi.fn()
        announceRelaunch('picking up the CLI that was just built', phone)
        expect(phone).toHaveBeenCalledTimes(1)
        expect(mocks.execFile).not.toHaveBeenCalled()
    })

    it('reaches the tmux status line as well as the phone', () => {
        process.env.TMUX = '/tmp/tmux-501/default,1,0'
        process.env.TMUX_PANE = '%42'
        const phone = vi.fn()
        announceRelaunch('a newer CLI has been built', phone)
        expect(phone).toHaveBeenCalledTimes(1)
        expect(mocks.execFile).toHaveBeenCalledTimes(1)
        expect(mocks.execFile.mock.calls[0][1]).toContain('%42')
    })

    /**
     * The caller is the poll timer that decides whether to hand a live session
     * over. A socket that is down must not become an exception on that path,
     * and it must not cost the tmux line either.
     */
    it('does not throw when the phone is unreachable, and still reaches tmux', () => {
        process.env.TMUX = '/tmp/tmux-501/default,1,0'
        process.env.TMUX_PANE = '%42'
        const phone = vi.fn(() => { throw new Error('socket closed') })
        expect(() => announceRelaunch('a newer CLI has been built', phone)).not.toThrow()
        expect(mocks.execFile).toHaveBeenCalledTimes(1)
    })

    it('works with no phone at all', () => {
        expect(() => announceRelaunch('a newer CLI has been built')).not.toThrow()
        expect(mocks.debug).toHaveBeenCalled()
    })
})
