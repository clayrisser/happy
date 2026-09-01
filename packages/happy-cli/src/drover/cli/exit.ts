/**
 * Ending a verb without losing its output (DROVE-315).
 *
 * On macOS node writes to a PIPE asynchronously: one big stdout.write returns
 * with everything past the first 64KiB still queued in userspace, and
 * `process.exit()` drops that queue. engine/mcp.js learned this the hard way —
 * the app's `drover mcps --json` fallback got exactly 65536 bytes of a 77KB
 * report and died parsing it — and answers with `process.exitCode` so the loop
 * drains on its own.
 *
 * A CLI entry cannot always afford that: the logger and the rest of the fork
 * may leave a handle open, and a verb that "returns" then hangs the terminal.
 * So: set the code, wait for stdout to report the queue flushed (writes are
 * ordered, so an empty write's callback means everything before it is out),
 * then exit. Both properties, neither trap.
 */

export async function flushExit(code: number): Promise<never> {
    process.exitCode = code;
    await new Promise<void>((resolve) => {
        // An empty write still queues behind everything already written, so
        // its callback is the flush signal. If stdout is closed (EPIPE), the
        // callback still fires with an error, and there is nothing to wait for.
        process.stdout.write('', () => resolve());
    });
    await new Promise<void>((resolve) => {
        process.stderr.write('', () => resolve());
    });
    process.exit(code);
}
