/**
 * What a harness launcher prints when its runner throws (DROVE-374).
 *
 * THE REGRESSION THIS EXISTS FOR. Before the DROVE-315 arm flip, `drover
 * cursor` reached the fork through `src/index.ts`, whose `cursor` arm wrapped
 * runCursor in a try/catch and printed one line:
 *
 *     } catch (error) {
 *       console.error(chalk.red('Error:'), error.message)
 *       process.exit(1)
 *     }
 *
 * The node launchers in this directory replaced that arm and did not carry the
 * catch. `runDroverVerb` does not catch either, and the entry's IIFE has no
 * `.catch`, so the first throw out of a runner reached Clay as an UNHANDLED
 * PROMISE REJECTION — a raw stack through `node:internal/errors:983` and
 * `ChildProcess.exithandler`, on top of a message that had already said the
 * useful thing. A locked login keychain is a one-sentence problem with a
 * one-command fix, and it arrived looking like a crash in node.
 *
 * THE SENTENCE IS DROVE-337's RULE, the same one `describeTmuxFailure` follows:
 * name the COMMAND, quote what the child actually said, and give the exit
 * code. A failure the reader cannot act on is the same as no message.
 *
 * The stack is not thrown away, it is moved behind DEBUG, exactly as the old
 * arm had it.
 */

/** Node's own shape for a child that ran and failed. */
interface ExecFailure {
    message?: string;
    stderr?: string | Buffer;
    stdout?: string | Buffer;
    cmd?: string;
    code?: number | string;
    signal?: string | null;
}

function text(value: string | Buffer | undefined): string {
    if (value === undefined) return '';
    return (typeof value === 'string' ? value : value.toString('utf8')).trim();
}

/**
 * The command a failed child ran.
 *
 * `execFile` hangs `cmd` on the error; `spawn` does not, and node's own
 * message is `Command failed: <cmd>\n<stderr>`, so the first line carries it
 * when the property does not.
 */
function commandOf(e: ExecFailure): string {
    if (e.cmd) return e.cmd.trim();
    const first = (e.message ?? '').split('\n')[0] ?? '';
    const m = first.trim().match(/^Command failed: (.+)$/);
    return m ? m[1] : '';
}

/**
 * One sentence for a thrown anything.
 *
 * A child that failed is reported as the command, its exit code and its own
 * stderr — never node's concatenation of the three, which repeats the command
 * and buries the sentence that matters under it.
 */
export function describeHarnessFailure(error: unknown): string {
    if (error === null || error === undefined) return 'the session ended with an error that carried no message.';
    if (typeof error !== 'object') return String(error);

    const e = error as ExecFailure;
    const cmd = commandOf(e);
    const stderr = text(e.stderr);
    if (cmd) {
        const said = stderr || text(e.stdout) || 'it printed nothing.';
        const how = e.signal
            ? `was killed by ${e.signal}`
            : e.code === undefined
                ? 'failed'
                : `exited ${e.code}`;
        return `\`${cmd}\` ${how}: ${said}`;
    }
    const message = typeof e.message === 'string' ? e.message.trim() : '';
    if (message && stderr && !message.includes(stderr)) return `${message}: ${stderr}`;
    return message || stderr || 'the session ended with an error that carried no message.';
}

/**
 * Run a harness runner, and turn anything it throws into one sentence.
 *
 * Wrapped around the REAL runner inside each launcher's `defaultIo`, and never
 * around `run()` itself: an injected io in a test throws on purpose to prove
 * the port did not reach for the live bus, and a catch up there would swallow
 * exactly the failure the test is asserting.
 */
export async function guardHarness(
    verb: string,
    err: (line: string) => void,
    body: () => Promise<number>,
): Promise<number> {
    try {
        return await body();
    } catch (error) {
        err(`drover ${verb}: ${describeHarnessFailure(error)}`);
        if (process.env.DEBUG) err(String(error instanceof Error ? (error.stack ?? error) : error));
        return 1;
    }
}
