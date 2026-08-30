/**
 * DROVE-42: a second daemon start against a live daemon must not produce a
 * second listener. These tests pin the DECISION (stand down / replace / fail),
 * not the process mechanics.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mockAcquireDaemonLock: vi.fn(),
  mockReadDaemonState: vi.fn(),
  mockIsDaemonRunningCurrentlyInstalledHappyVersion: vi.fn(),
  mockStopDaemon: vi.fn(),
}))

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn(), warn: vi.fn() },
}))

vi.mock('@/persistence', () => ({
  acquireDaemonLock: mocks.mockAcquireDaemonLock,
  readDaemonState: mocks.mockReadDaemonState,
}))

vi.mock('./controlClient', () => ({
  isDaemonRunningCurrentlyInstalledHappyVersion: mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion,
  stopDaemon: mocks.mockStopDaemon,
}))

import { claimDaemonSlot } from './singleInstance'

const fakeLock = { close: vi.fn() } as any

describe('claimDaemonSlot', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockReadDaemonState.mockResolvedValue(null)
    mocks.mockStopDaemon.mockResolvedValue(undefined)
    mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(false)
  })

  it('takes the lock before asking any advisory question', async () => {
    mocks.mockAcquireDaemonLock.mockResolvedValue(fakeLock)

    const slot = await claimDaemonSlot()

    expect(slot).toEqual({ outcome: 'acquired', lock: fakeLock })
    // The old order ran the health check first, and its stale-state cleanup
    // deleted the lock a live daemon was holding.
    expect(mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion).not.toHaveBeenCalled()
    expect(mocks.mockStopDaemon).not.toHaveBeenCalled()
  })

  it('stands down instead of coexisting when a live daemon at our version holds the lock', async () => {
    mocks.mockAcquireDaemonLock.mockResolvedValue(null)
    mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(true)

    const slot = await claimDaemonSlot()

    expect(slot.outcome).toBe('already-running')
    expect(mocks.mockStopDaemon).not.toHaveBeenCalled()
  })

  it('replaces, never joins, a daemon running a different version', async () => {
    mocks.mockAcquireDaemonLock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(fakeLock)
    mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(false)

    const slot = await claimDaemonSlot()

    expect(mocks.mockStopDaemon).toHaveBeenCalledTimes(1)
    expect(slot).toEqual({ outcome: 'acquired', lock: fakeLock })
  })

  it('fails rather than starting a second listener when the lock never comes free', async () => {
    mocks.mockAcquireDaemonLock.mockResolvedValue(null)
    mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(false)

    const slot = await claimDaemonSlot()

    expect(slot.outcome).toBe('unavailable')
  })

  it('stops a live daemon still named by the state file even after taking the lock', async () => {
    // The pre-fix world: the incumbent's lock was deleted underneath it, so it
    // is still running and still heartbeating into daemon.state.json.
    mocks.mockAcquireDaemonLock.mockResolvedValue(fakeLock)
    mocks.mockReadDaemonState.mockResolvedValue({ pid: process.pid === 1 ? 2 : 1, httpPort: 1234 })

    const slot = await claimDaemonSlot()

    expect(slot.outcome).toBe('acquired')
    expect(mocks.mockStopDaemon).toHaveBeenCalledTimes(1)
  })

  it('does not stop anything when the state file names a pid that is gone', async () => {
    mocks.mockAcquireDaemonLock.mockResolvedValue(fakeLock)
    // Above the pid_max of every platform we run on, so it is never alive.
    mocks.mockReadDaemonState.mockResolvedValue({ pid: 4194303, httpPort: 1234 })

    const slot = await claimDaemonSlot()

    expect(slot.outcome).toBe('acquired')
    expect(mocks.mockStopDaemon).not.toHaveBeenCalled()
  })

  it('does not stop itself when the state file already names this process', async () => {
    mocks.mockAcquireDaemonLock.mockResolvedValue(fakeLock)
    mocks.mockReadDaemonState.mockResolvedValue({ pid: process.pid, httpPort: 1234 })

    await claimDaemonSlot()

    expect(mocks.mockStopDaemon).not.toHaveBeenCalled()
  })
})
