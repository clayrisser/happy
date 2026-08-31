/**
 * Cursor's model list, as the session publishes it to the app (DROVE-57).
 *
 * The app's model picker prefers `metadata.models` over its own hardcoded
 * table, so a Cursor session that publishes its list gets a picker of REAL
 * Cursor models that cannot drift from what the CLI accepts. The alternative —
 * a table in the app — is out of date the day Cursor ships a model.
 *
 * `cursor-agent --list-models` prints, after a header and a blank line:
 *   `auto - Auto (default)`
 *   `cursor-grok-4.6-xhigh-fast - Cursor Grok 4.6 Extra High Fast`
 * The id is what `--model` takes; the label is what a human recognises.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { resolveCursorBin } from './cursorBin';

const execFileAsync = promisify(execFile);

export interface CursorModelOption {
    code: string;
    value: string;
    description?: string | null;
}

/** Parse `--list-models` output. Anything that is not `id - Label` is skipped. */
export function parseCursorModels(stdout: string): CursorModelOption[] {
    const out: CursorModelOption[] = [];
    const seen = new Set<string>();
    for (const line of stdout.split('\n')) {
        const m = /^\s*([A-Za-z0-9._+-]+)\s+-\s+(.+?)\s*$/.exec(line);
        if (!m) continue;
        const [, code, value] = m;
        if (seen.has(code)) continue;
        seen.add(code);
        out.push({ code, value });
    }
    return out;
}

/**
 * Ask the CLI. An empty list is a normal outcome, not an error: the picker
 * then simply does not appear, which is the honest result of not knowing what
 * this login can run.
 */
export async function listCursorModels(configDir: string, cwd: string): Promise<CursorModelOption[]> {
    try {
        const { stdout } = await execFileAsync(resolveCursorBin(), ['--list-models'], {
            cwd,
            env: { ...process.env, CURSOR_CONFIG_DIR: configDir },
            timeout: 30_000,
            maxBuffer: 4 * 1024 * 1024,
        });
        return parseCursorModels(stdout);
    } catch {
        return [];
    }
}
