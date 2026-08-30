/**
 * One daemon per machine (DROVE-42).
 *
 * The daemon lock file is the only thing that can answer "is another daemon
 * already running?" without a race, because it is created atomically (a
 * hard-link of a temp file that already contains the pid). Everything else is
 * advisory: the state file outlives the process that wrote it, and the HTTP
 * health ping can time out against a daemon that is merely busy.
 *
 * startDaemon() used to ask the advisory questions FIRST and only then take
 * the lock, which is how five daemons ended up alive at once sharing one
 * ~/.happy/daemon.state.json. The health check's stale-state cleanup deleted
 * the lock a live daemon was holding, stopDaemon() then found no state file
 * and killed nothing, and the newcomer walked into the freed lock. Both halves
 * are fixed — clearDaemonState() no longer touches a held lock — but the order
 * is the load-bearing part: claim the slot, then decide.
 */

import type { FileHandle } from 'node:fs/promises';

import { logger } from '@/ui/logger';
import { acquireDaemonLock, readDaemonState } from '@/persistence';
import { isDaemonRunningCurrentlyInstalledHappyVersion, stopDaemon } from './controlClient';

export type DaemonSlot =
  /** We hold the lock and are the one daemon. Release it on shutdown. */
  | { outcome: 'acquired'; lock: FileHandle }
  /** A daemon at our version is already running. This process is redundant. */
  | { outcome: 'already-running' }
  /** Something holds the lock and would not give it up. Startup failed. */
  | { outcome: 'unavailable' };

/** Is a pid alive? EPERM counts as alive — it is running, just not ours. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

/**
 * Claim the single daemon slot for this process.
 *
 * Two fast attempts first, with no delay: attempt one takes a free lock,
 * attempt two takes a lock whose owner is dead (acquireDaemonLock reclaims a
 * stale lock and retries). Only if a LIVE owner is in the way do we fall back
 * to the slower "same version, or replace it?" decision.
 */
export async function claimDaemonSlot(): Promise<DaemonSlot> {
  let lock = await acquireDaemonLock(2, 0);

  if (!lock) {
    // Someone live is holding the lock. If they are running our exact bundle
    // there is nothing to gain by replacing them.
    if (await isDaemonRunningCurrentlyInstalledHappyVersion()) {
      logger.debug('[DAEMON SLOT] A daemon at this version already holds the lock');
      return { outcome: 'already-running' };
    }

    // Different version (or a daemon that has stopped answering): replace it
    // rather than coexist with it. Two daemons on one state file is the bug.
    logger.debug('[DAEMON SLOT] Lock held by a daemon we should replace, stopping it');
    await stopDaemon();
    lock = await acquireDaemonLock(5, 200);
  }

  if (!lock) {
    return { outcome: 'unavailable' };
  }

  // Holding the lock is not by itself proof of being alone. A daemon whose
  // lock was reclaimed underneath it (the pre-fix behaviour, or an operator
  // deleting the file) keeps running and keeps writing the state file. Take
  // over from it explicitly instead of letting two heartbeats fight over the
  // pid recorded there.
  const state = await readDaemonState();
  if (state && state.pid !== process.pid && isProcessAlive(state.pid)) {
    logger.debug(`[DAEMON SLOT] Lock acquired but pid ${state.pid} is still running, stopping it`);
    await stopDaemon();
  }

  return { outcome: 'acquired', lock };
}
