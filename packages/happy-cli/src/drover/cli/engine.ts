/**
 * Loading a cattle-drover engine module into THIS process (DROVE-315).
 *
 * The engine — `engine/mcp.js`, `engine/inbox.js`, `engine/install.js` and the
 * rest — stays in the cattle-drover checkout. It is plain ESM the bus imports,
 * on its own release cadence, and the rule every shell verb kept is ONE READER:
 * `drover mcps` runs engine/mcp.js, GET /v1/mcps runs engine/mcp.js, and the
 * terminal cannot disagree with the phone. The port keeps that rule by loading
 * the same file rather than translating it into TypeScript beside a copy.
 *
 * In process, not as a child. The shell wrappers `exec node engine/<x>.js`,
 * which is a second node boot on top of this one; a dynamic import from the
 * checkout path costs the module's own load and nothing else. pkgroll leaves a
 * non-literal `import()` alone, so this is a genuine runtime import and the
 * bundle carries no copy of the engine.
 *
 * Typed loosely on purpose. The engine is JavaScript with no declarations, and
 * a hand-written .d.ts here would be the second copy the one-reader rule is
 * about — it would drift the day the engine added a field. Each verb narrows
 * what it uses at the call site.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { droverEnv } from './env';

export class EngineMissingError extends Error {
    constructor(readonly path: string) {
        super(
            `no engine module at ${path} — point DROVER_DIR at your cattle-drover checkout `
            + '(the shell wrapper exports it; `node dist/index.mjs` on its own defaults to ~/Projects/bitspur/cattle-drover)',
        );
        this.name = 'EngineMissingError';
    }
}

/** Where `engine/<name>` is on this machine. */
export function enginePath(name: string, droverDir: string = droverEnv().droverDir): string {
    return join(droverDir, 'engine', name);
}

/**
 * Import `engine/<name>` from the checkout. Throws EngineMissingError, with the
 * path it looked at, when the file is not there — a missing engine is a
 * misconfigured machine, and the message names the fix.
 */
export async function loadEngine<T = Record<string, unknown>>(
    name: string,
    droverDir: string = droverEnv().droverDir,
): Promise<T> {
    const file = enginePath(name, droverDir);
    if (!existsSync(file)) throw new EngineMissingError(file);
    const url = pathToFileURL(file).href;
    return (await import(/* @vite-ignore */ url)) as T;
}
