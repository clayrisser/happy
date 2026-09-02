#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

// Check if we're already running with the flags
const hasNoWarnings = process.execArgv.includes('--no-warnings');
const hasNoDeprecation = process.execArgv.includes('--no-deprecation');

if (!hasNoWarnings || !hasNoDeprecation) {
  // Get path to the actual CLI entrypoint
  const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const entrypoint = join(projectRoot, 'dist', 'index.mjs');

  /**
   * This wrapper is the SUPERVISOR for the session (DROVE-172).
   *
   * It was already a blocking parent for the whole life of the session, so the
   * tmux pane belongs to it rather than to `dist/index.mjs`. That is what makes
   * the fix cheap: the launcher cannot swap its own code (node has read the
   * bundle and there is no execve to reach for), but it can exit 75 and let
   * this loop start the rebuilt bundle in the same pane, with
   * `--resume <transcript id>` so the conversation carries over.
   *
   * Before this, `make build-cli` plus a daemon kickstart left every open
   * session on the code it was spawned with. On 2026-08-31 that cost five
   * shipped CLI fixes in one night: the session started 05:34, the bundle
   * carrying them was written 08:53, and the phone behaved exactly as if
   * nothing had been fixed.
   *
   * The launcher decides WHEN — never mid-turn, never with subagents running.
   * This only carries it out.
   */
  const relaunchExitCode = 75;
  const relaunchDir = mkdtempSync(join(tmpdir(), 'drover-relaunch-'));
  const relaunchFile = join(relaunchDir, 'relaunch.json');

  /**
   * A rebuilt bundle that exits 75 on sight would spin here forever. Three
   * relaunches inside a minute is far more than a real one (a build takes
   * longer than that on its own) and far less than a loop.
   */
  const relaunchWindowMs = 60_000;
  const relaunchLimit = 3;
  const relaunches = [];

  /**
   * A build DELETES dist before it writes it — `shx rm -rf dist && tsc &&
   * pkgroll` — and the window is most of a minute. The launcher checks the
   * bundle is complete before it asks, but the child then takes seconds to
   * stop, and a second build can start inside that gap. Spawning into the gap
   * is what killed the proof session on 2026-08-31: node printed
   * MODULE_NOT_FOUND, this loop ended, and the pane closed on a conversation
   * that was meant to be carried over. So a relaunch waits for the entrypoint.
   *
   * Only on the relaunch path. A FIRST start with no dist is a different
   * problem, and cattle-drover's `bin/drover` already builds or restores a
   * last-known-good before it gets here — making that case block for two
   * minutes would hide a real failure behind a hang.
   */
  const entrypointWaitMs = 120_000;
  const entrypointPollMs = 250;

  function waitForEntrypoint() {
    if (existsSync(entrypoint)) return true;
    process.stderr.write('drover: waiting for the CLI build to finish before resuming this session…\n');
    const deadline = Date.now() + entrypointWaitMs;
    while (Date.now() < deadline) {
      // Synchronous on purpose: there is nothing else for this process to do,
      // and the pane is holding a conversation until it comes back.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, entrypointPollMs);
      if (existsSync(entrypoint)) return true;
    }
    return false;
  }

  let argv = process.argv.slice(2);
  let handover = null;
  let status = 0;
  let relaunching = false;

  try {
    for (;;) {
      if (relaunching && !waitForEntrypoint()) {
        process.stderr.write(`drover: ${entrypoint} never reappeared — the session cannot be resumed here. Run: drover --resume <id>\n`);
        status = 1;
        break;
      }
      // NOTHING STARTS WHILE THE TREE IS MOVING (DROVE-369). `drover home
      // migrate` holds ~/.drover/migrating from its writer check to its end,
      // and cattle-drover's bin/drover waits a typed start out on it. This
      // loop is the one start that never passes through bin/drover — a flip
      // or a rebuilt bundle exits 75 and is respawned right here — and on the
      // real run of 2026-09-02 a respawned child was a writer under ~/.happy
      // and ~/.claude-shared exactly while verify hashed them.
      //
      // It WAITS, it does not refuse (run of 04:29Z). A refusal here was a
      // closed pane with the reason lost inside it: the quiesce stopped the
      // coordinator's Claude, Claude printed its own "Resume this session
      // with" line, this loop refused twice on the lock, and all Clay saw was
      // that line, twice, with no reason. The move takes about two minutes;
      // the wait is ten, polled every two seconds, said once, and the reason
      // is on the terminal before anything else happens.
      if (!waitForMigration(relaunching)) {
        status = 3;
        break;
      }
      const env = { ...process.env, DROVER_RELAUNCH_FILE: relaunchFile };
      // Only ever set for the process we are handing a session TO, so a
      // wrapper that has never relaunched cannot waive another session's
      // live-wrapper check.
      if (handover) {
        env.DROVER_RELAUNCH_HANDOVER = handover;
      } else {
        delete env.DROVER_RELAUNCH_HANDOVER;
      }

      const result = spawnSync(process.execPath, [
        '--no-warnings',
        '--no-deprecation',
        entrypoint,
        ...argv
      ], {
        stdio: 'inherit',
        env
      });

      if (result.error) throw result.error;
      // Killed by a signal: no exit code to pass on, and nothing to relaunch.
      if (result.signal) { status = 1; break; }
      status = result.status === null ? 1 : result.status;
      if (status !== relaunchExitCode) break;

      const request = readRelaunchRequest(relaunchFile);
      if (request === null) {
        // The launcher asked and then could not say what to run. Ending the
        // session is wrong in a different way from looping, but it is honest,
        // and it is what happened before this loop existed.
        process.stderr.write('drover: a relaunch was requested but no argv was left behind — ending the session\n');
        status = 0;
        break;
      }

      const now = Date.now();
      while (relaunches.length > 0 && now - relaunches[0] > relaunchWindowMs) relaunches.shift();
      relaunches.push(now);
      if (relaunches.length > relaunchLimit) {
        process.stderr.write('drover: the rebuilt CLI asked to relaunch three times in a minute — stopping instead of looping\n');
        status = 1;
        break;
      }

      argv = request.argv;
      handover = request.happySessionId ?? null;
      relaunching = true;
    }
  } finally {
    try { rmSync(relaunchDir, { recursive: true, force: true }); } catch { /* best effort */ }
    // Claude turns mouse reporting on and does not always turn it off when it
    // is signalled: the `0;66;29M0;66;29m` Clay saw at his prompt after the
    // 04:29Z run was SGR mouse reports arriving after Claude had gone. So the
    // supervisor, the last thing standing in the pane, resets it on its way
    // out (X10, button-event, any-event tracking, and the SGR encoding).
    if (process.stdout.isTTY) {
      try { process.stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l'); } catch { /* best effort */ }
    }
  }

  process.exit(status);
} else {
  // We're running Node with the flags we wanted, import the CLI entrypoint
  // module to avoid creating a new process. Nothing supervises this path, so
  // DROVER_RELAUNCH_FILE is deliberately not set and the CLI reports a stale
  // bundle instead of trying to hand itself over.
  import("../dist/index.mjs");
}

function readRelaunchRequest(path) {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || !Array.isArray(parsed.argv)) return null;
    if (!parsed.argv.every((a) => typeof a === 'string')) return null;
    return parsed;
  } catch {
    return null;
  } finally {
    try { rmSync(path, { force: true }); } catch { /* best effort */ }
  }
}

/**
 * Wait the migration out: one line when the lock is first seen, a poll every
 * DROVER_MIGRATING_POLL seconds (2) for up to DROVER_MIGRATING_WAIT seconds
 * (600), one line when it is gone, and false (the old refusal, with the reason
 * already on the terminal) only if the wait runs out. Same two knobs, same
 * defaults and the same sentences as etc/drover.env's drover_wait_if_migrating,
 * which is the shell half of this for a typed start. DROVER_MIGRATING_WAIT=0
 * is the refusal at once. A lock whose pid is gone is stepped over, as before.
 */
function waitForMigration(relaunching) {
  const waitS = Number(process.env.DROVER_MIGRATING_WAIT ?? 600);
  const pollS = Math.max(1, Number(process.env.DROVER_MIGRATING_POLL ?? 2) || 2);
  const what = relaunching ? 'resume' : 'start';
  let said = false;
  const deadline = Date.now() + waitS * 1000;
  for (;;) {
    const migrating = migrationInProgress();
    if (!migrating) {
      if (said) process.stderr.write(`drover: the migration is done; ${relaunching ? 'resuming' : 'starting'} this session.\n`);
      return true;
    }
    if (!(waitS > 0)) {
      process.stderr.write(`drover: a state migration to ~/.drover is in progress (${migrating}); this session does not ${what} until it finishes. Log: ~/.drover/migrate.log\n`);
      return false;
    }
    if (!said) {
      process.stderr.write(`drover: a state migration to ~/.drover is in progress (${migrating}); this session does not ${what} until it finishes. Waiting for it, every ${pollS} s for up to ${waitS} s. Log: ~/.drover/migrate.log\n`);
      said = true;
    }
    if (Date.now() >= deadline) {
      process.stderr.write(`drover: the migration is still running after ${waitS} s; giving up. Start this session again once ~/.drover/migrating is gone${relaunching ? ` (drover --resume ${resumeIdOf(argvNow())})` : ''}.\n`);
      return false;
    }
    // Synchronous on purpose, as above: the pane is holding a conversation.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pollS * 1000);
  }
}

/**
 * The migration lock cattle-drover's `drover home migrate` holds while the
 * six state trees move under ~/.drover (DROVE-369): `<DROVER_HOME>/migrating`,
 * `pid=`, `started=` and `by=` one per line. Read the same way etc/drover.env's
 * drover_wait_if_migrating reads it: a live pid means the run is live, a pid
 * that is gone means a crashed run whose lock is stepped over (with a note),
 * no file means go. Returns a short description of the live run, or null.
 */
function migrationInProgress() {
  const home = process.env.DROVER_HOME || join(homedir(), '.drover');
  let text;
  try {
    text = readFileSync(join(home, 'migrating'), 'utf8');
  } catch {
    return null;
  }
  const pid = Number((/^pid=(\d+)/m.exec(text) || [])[1]);
  const since = (/^started=(\S+)/m.exec(text) || [])[1] || '?';
  if (pid) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      // ESRCH: nothing has that pid. Anything else (EPERM) is a live process
      // that is not ours, which is still a live process.
      if (e && e.code === 'ESRCH') {
        process.stderr.write(`drover: stale migration lock (${join(home, 'migrating')} names pid ${pid}, which is gone); stepping over it. Read ~/.drover/migrate.log, then remove the file.\n`);
        return null;
      }
    }
  }
  return `pid ${pid || '?'}, since ${since}`;
}
