/**
 * Export a session's conversation as a SEED, so the phone can clone it into
 * another harness (DROVE-337).
 *
 * A FORK and a CLONE are different things and the difference is not cosmetic.
 * A fork works because the target reads the same transcript the source wrote:
 * the daemon copies one JSONL and starts `claude --resume` on the copy, and
 * the conversation is CARRIED. No harness but Claude Code can read a Claude
 * Code transcript, so a cross-harness copy has nothing to carry. It exports
 * the conversation to a file and the new session is TOLD it. The seed says so
 * in its first paragraph, because a clone that believes it is a continuation
 * answers confidently from context it does not have.
 *
 * ONE EXPORTER, and it is not this file. `drover clone` already owns the
 * shape of a seed: which turns, the cap, the working-tree diff, thinking and
 * tool output left out, and the ledger row that makes the two ends agree.
 * Re-implementing any of that here would be a second answer to a question
 * cattle-drover has already answered, and the two would drift the first time
 * either changed. So this shells out to the same command a terminal runs, in
 * `--seed-only` mode: write the file, print its path, open nothing. The
 * daemon then spawns the harness with `--seed <path>` through the ordinary
 * window path, so a clone gets the same precondition checks, the same account
 * decision and the same tmux window as every other session.
 *
 * `--transcript` rather than a bus lookup, deliberately. The bus maps a
 * session id to a file on disk, and asking it from here would make a clone
 * fail whenever the bus is down even though the daemon already knows exactly
 * which file it wants. `drover clone --transcript <file>` is the documented
 * way to export a session by naming its file, and it is not a fallback: it is
 * the path for a caller that already has the path.
 */

import { execFile } from 'node:child_process';

import { logger } from '@/ui/logger';

import {
    droverBinExists as defaultDroverBinExists,
    droverBinPath as defaultDroverBinPath,
    droverMissingMessage,
} from '@/daemon/tmuxSpawn';

/**
 * Harnesses `drover clone --to` accepts.
 *
 * Kept here rather than inferred, so an unknown value is refused by the daemon
 * with a sentence naming what IS possible, instead of travelling to a shell
 * script to come back as a parse error the phone cannot act on.
 */
export const cloneTargetHarnesses = ['claude', 'opencode', 'cursor', 'pi'] as const;

export type CloneTargetHarness = typeof cloneTargetHarnesses[number];

export function isCloneTargetHarness(value: unknown): value is CloneTargetHarness {
    return typeof value === 'string' && (cloneTargetHarnesses as readonly string[]).includes(value);
}

export interface CloneSeedRequest {
    /** The exported conversation's JSONL, resolved by the caller. */
    transcriptPath: string;
    /** Names the export, and is the source id the ledger records. */
    sessionId: string;
    /** Working directory for the clone, and for the diff in the seed. */
    directory: string;
    harness: CloneTargetHarness;
    /** Newest N turns. Left unset means `drover clone`'s own default. */
    turns?: number;
}

export type CloneSeedResult =
    | { type: 'success'; seedPath: string }
    | { type: 'error'; errorMessage: string };

export interface CloneSeedRun {
    code: number;
    stdout: string;
    stderr: string;
}

/**
 * The argv, as a pure function, so the contract with cattle-drover is one
 * readable list a test can pin rather than a string built inside an exec call.
 */
export function cloneSeedArgv(request: CloneSeedRequest): string[] {
    const argv = [
        'clone',
        request.sessionId,
        '--transcript', request.transcriptPath,
        '--cwd', request.directory,
        '--to', request.harness,
    ];
    if (typeof request.turns === 'number' && Number.isInteger(request.turns) && request.turns >= 0) {
        argv.push('--turns', String(request.turns));
    }
    // Last, and load-bearing: without it `drover clone` opens the window
    // ITSELF, and the daemon would have no session id to hand back to the
    // phone and no way to apply the account decision the spawn path makes.
    argv.push('--seed-only');
    return argv;
}

/**
 * What a finished `drover clone --seed-only` means.
 *
 * A refusal from that command is a WRITTEN sentence on stderr, and it is the
 * most useful thing the phone can be shown: "the cursor harness has no lane
 * yet", "the transcript cannot be read", "this session has written no
 * conversation yet". So stderr is passed through rather than replaced with a
 * message of our own. A non-zero exit with nothing on stderr is the only case
 * that gets invented wording, because there is nothing else to say.
 */
export function readCloneSeedOutcome(run: CloneSeedRun): CloneSeedResult {
    const stderr = run.stderr.trim();
    if (run.code !== 0) {
        return {
            type: 'error',
            errorMessage: stderr || `drover clone exited with code ${run.code} and said nothing.`,
        };
    }
    const seedPath = run.stdout.trim().split('\n').pop()?.trim() ?? '';
    if (!seedPath) {
        return {
            type: 'error',
            errorMessage: stderr || 'drover clone wrote no seed file and gave no reason.',
        };
    }
    return { type: 'success', seedPath };
}

export interface CloneSeedDeps {
    droverBin?: () => string;
    droverExists?: (path: string) => boolean;
    run?: (bin: string, argv: string[], cwd: string) => Promise<CloneSeedRun>;
}

function runDroverClone(bin: string, argv: string[], cwd: string): Promise<CloneSeedRun> {
    return new Promise((resolve) => {
        // execFile, never a shell. Every value here is a path or an id the
        // phone chose, and a seed export is not a place to find out what a
        // directory name with a semicolon in it does.
        execFile(bin, argv, { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
            const code = error && typeof (error as { code?: unknown }).code === 'number'
                ? (error as unknown as { code: number }).code
                : (error ? 1 : 0);
            resolve({
                code,
                stdout: stdout ?? '',
                stderr: stderr || (error ? String(error.message ?? error) : ''),
            });
        });
    });
}

export async function exportCloneSeed(
    request: CloneSeedRequest,
    deps: CloneSeedDeps = {},
): Promise<CloneSeedResult> {
    const bin = (deps.droverBin ?? defaultDroverBinPath)();
    if (!(deps.droverExists ?? defaultDroverBinExists)(bin)) {
        return { type: 'error', errorMessage: droverMissingMessage(bin) };
    }
    const argv = cloneSeedArgv(request);
    logger.debug(`[CLONE SEED] ${bin} ${argv.join(' ')}`);
    const run = await (deps.run ?? runDroverClone)(bin, argv, request.directory);
    const outcome = readCloneSeedOutcome(run);
    if (outcome.type === 'error') {
        logger.debug(`[CLONE SEED] refused: ${outcome.errorMessage}`);
    }
    return outcome;
}
