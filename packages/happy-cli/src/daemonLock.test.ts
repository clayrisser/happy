/**
 * DROVE-42: the daemon lock is the single-instance guard, so nothing may
 * delete it out from under a live owner. These run against a real temp
 * directory, because the bug was in filesystem behaviour, not in a decision.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'

// Strings only: vi.hoisted runs before the imports above are evaluated, so the
// directory itself is created in beforeAll.
const paths = vi.hoisted(() => {
  const home = `${process.env.TMPDIR || '/tmp'}/happy-daemon-lock-${process.pid}-${Date.now()}`
  return {
    happyHomeDir: home,
    daemonStateFile: `${home}/daemon.state.json`,
    daemonLockFile: `${home}/daemon.state.json.lock`,
    settingsFile: `${home}/settings.json`,
    privateKeyFile: `${home}/access.key`,
    sessionsFile: `${home}/sessions.json`,
  }
})

vi.mock('@/configuration', () => ({ configuration: paths }))
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }))

import {
  acquireDaemonLock,
  clearDaemonState,
  isDaemonLockHeldByAnotherProcess,
  readDaemonLockPid,
  releaseDaemonLock,
} from './persistence'

// Above the pid_max of every platform this runs on, so it is never alive.
const deadPid = 4194303

let sleeper: ChildProcess | null = null

/** A real, live pid that is not this process. */
function liveForeignPid(): number {
  sleeper = spawn('sleep', ['30'], { stdio: 'ignore' })
  if (!sleeper.pid) {
    throw new Error('could not spawn a helper process')
  }
  return sleeper.pid
}

describe('daemon lock ownership', () => {
  beforeAll(() => {
    mkdirSync(paths.happyHomeDir, { recursive: true })
  })

  beforeEach(() => {
    for (const f of [paths.daemonStateFile, paths.daemonLockFile]) {
      if (existsSync(f)) {
        unlinkSync(f)
      }
    }
  })

  afterEach(() => {
    if (sleeper) {
      sleeper.kill('SIGKILL')
      sleeper = null
    }
  })

  it('reads back the pid the lock was created with', async () => {
    const lock = await acquireDaemonLock(1, 0)
    expect(lock).not.toBeNull()
    expect(readDaemonLockPid()).toBe(process.pid)
    await releaseDaemonLock(lock!)
  })

  it('refuses a second lock while the first is held', async () => {
    const first = await acquireDaemonLock(1, 0)
    expect(first).not.toBeNull()

    // Rewrite the payload as a live FOREIGN pid: acquireDaemonLock reclaims a
    // lock whose owner is dead, and inside one test process our own pid is
    // alive either way, so this is the honest simulation of another daemon.
    writeFileSync(paths.daemonLockFile, String(liveForeignPid()))

    expect(await acquireDaemonLock(2, 0)).toBeNull()
    await releaseDaemonLock(first!)
  })

  it('leaves a lock alone when a live process holds it', async () => {
    writeFileSync(paths.daemonLockFile, String(liveForeignPid()))
    writeFileSync(paths.daemonStateFile, JSON.stringify({ pid: deadPid }))

    await clearDaemonState()

    // The state file was stale and goes; the lock is NOT the state file, and
    // deleting it here is what let a second daemon start and coexist.
    expect(existsSync(paths.daemonStateFile)).toBe(false)
    expect(existsSync(paths.daemonLockFile)).toBe(true)
    expect(await acquireDaemonLock(2, 0)).toBeNull()
  })

  it('reclaims a lock whose owner is gone', async () => {
    writeFileSync(paths.daemonLockFile, String(deadPid))
    writeFileSync(paths.daemonStateFile, JSON.stringify({ pid: deadPid }))

    await clearDaemonState()

    expect(existsSync(paths.daemonLockFile)).toBe(false)
  })

  it('reclaims its own lock, so a daemon can still clean up after itself', async () => {
    writeFileSync(paths.daemonLockFile, String(process.pid))

    await clearDaemonState()

    expect(existsSync(paths.daemonLockFile)).toBe(false)
  })

  it('treats a missing or nonsense lock payload as unheld', () => {
    expect(isDaemonLockHeldByAnotherProcess()).toBe(false)
    writeFileSync(paths.daemonLockFile, 'not-a-pid')
    expect(readDaemonLockPid()).toBeNull()
    expect(isDaemonLockHeldByAnotherProcess()).toBe(false)
  })
})
