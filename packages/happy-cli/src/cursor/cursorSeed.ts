import { readFileSync } from 'node:fs';

/**
 * Read the file whose contents become a cloned Cursor session's first turn
 * (DROVE-337).
 *
 * FAILING is the point of this being a function at all. A clone whose seed
 * could not be read would open a tmux window, start cursor-agent, and begin
 * with no context whatsoever while reporting success. That exact failure is
 * why `drover clone --to cursor` refused to guess at this lane rather than
 * building half of it: "a window opens, a harness starts, and it starts with
 * no context at all while reporting success" is the worst outcome available,
 * and it is worse than no lane. So an unreadable or empty seed throws before
 * a session exists, and the message names the file.
 */
export function readCursorSeed(path: string): string {
    let text: string;
    try {
        text = readFileSync(path, 'utf8');
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`cursor: cannot read the seed file '${path}': ${detail}`);
    }
    if (text.trim().length === 0) {
        throw new Error(`cursor: the seed file '${path}' is empty, so there is nothing to start from.`);
    }
    return text;
}
