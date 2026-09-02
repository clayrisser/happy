/**
 * The pane IS the TUI (DROVE-377).
 *
 * Every harness verb that runs a real interactive agent in this pane ends here:
 * the harness binary is spawned with the pane's own stdio, this process waits
 * for it, and its exit code is the verb's. What this file adds over a bare
 * `spawnSync(bin, argv, { stdio: 'inherit' })`, and why each part exists:
 *
 *   the pid        a sibling bridge (adapters/<harness>-bridge.mjs) needs to
 *                  know WHICH process is drawing the pane, so it can tell a TUI
 *                  that outlived its pane from one that is still in it. The
 *                  shell launchers pass `$$` before an exec; in node the child
 *                  has its own pid, so it is handed out the moment it exists.
 *
 *   SIGTERM/SIGHUP  forwarded to the child. MEASURED on Clay's machine
 *                  (2026-09-02 04:15Z): the launcher was killed, `opencode
 *                  --port 50249` stayed alive with parent 1, still answered
 *                  its API, and the phone kept a green row for a pane that no
 *                  longer existed. A launcher that dies without its child is
 *                  how a twin is born. The bridge reaps that case too; this is
 *                  the belt to its braces.
 *
 *   SIGINT         NOT forwarded and NOT fatal here. Ctrl-C in a pane goes to
 *                  the whole foreground process group, so the child already
 *                  has its own copy and handles it the way its TUI does
 *                  (interrupt the turn, or ask before quitting). Node's
 *                  default would exit on that same signal and leave the TUI
 *                  parentless mid-keystroke, which is the orphan again.
 *
 * It is `spawn` and not `spawnSync` for the same reason: a blocked event loop
 * can neither report the pid nor run a signal handler.
 */

import { spawn } from 'node:child_process';
import { constants } from 'node:os';

import type { Env } from './tmuxEntry';

export type TuiStarted = (pid: number) => void;

/**
 * Run the harness's real TUI in this pane and answer with its exit code.
 * `started(pid)` fires once the child exists. A binary that cannot be started
 * answers 127, the shell's own code for it, and says why on stderr.
 */
export function runPaneTui(bin: string, argv: string[], env: Env, started?: TuiStarted): Promise<number> {
    return new Promise((resolve) => {
        const child = spawn(bin, argv, { stdio: 'inherit', env: env as NodeJS.ProcessEnv });

        const forward = (sig: NodeJS.Signals) => () => {
            try {
                child.kill(sig);
            } catch {
                // Already gone; the exit handler below answers.
            }
        };
        const onTerm = forward('SIGTERM');
        const onHup = forward('SIGHUP');
        const onInt = () => {
            // The child has its own copy. Staying alive is the whole point.
        };
        process.on('SIGTERM', onTerm);
        process.on('SIGHUP', onHup);
        process.on('SIGINT', onInt);
        const release = () => {
            process.off('SIGTERM', onTerm);
            process.off('SIGHUP', onHup);
            process.off('SIGINT', onInt);
        };

        let done = false;
        const finish = (code: number) => {
            if (done) return;
            done = true;
            release();
            resolve(code);
        };

        child.once('spawn', () => {
            if (child.pid !== undefined) started?.(child.pid);
        });
        child.once('error', (err) => {
            process.stderr.write(`could not start '${bin}': ${err.message}\n`);
            finish(127);
        });
        child.once('exit', (code, signal) => {
            if (code !== null) return finish(code);
            const num = signal ? (constants.signals as Record<string, number>)[signal] ?? 0 : 0;
            finish(128 + num);
        });
    });
}
