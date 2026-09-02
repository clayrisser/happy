/**
 * `drover install` — take a bare machine to a working one (DROVE-307), in node
 * (DROVE-315).
 *
 * A SHIM, deliberately, exactly as the shell file was. Everything this command
 * does lives in engine/install.js — the same way `drover mcps` is
 * engine/mcp.js — so there is ONE reader of the DROVE-307 manifests and the
 * terminal cannot disagree with anything else that reads them. There is no
 * second implementation of the manifest format here, and there will not be
 * one: the port replaces the wrapper, not the engine.
 *
 * WHAT THE ENGINE WILL NOT DO, and these are rules rather than defaults:
 *
 *   It never authenticates anything. Installing a harness binary and logging
 *   into it are different acts. Drover does the first and REPORTS the second.
 *
 *   It never installs a second copy of something you already have.
 *
 *   It never edits a file it did not create. The one config edit in the whole
 *   bootstrap — tmux's `source-file` line — is delegated to `make tmux`, which
 *   is DROVE-306's marker contract.
 *
 * --help answers HERE, before the engine is loaded. The load-time gate treats
 * a subprocess on --help as a load-time side effect, and it is right: help
 * must be free.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

const HELP = `drover install — install the harnesses and the OS dependencies drover needs.

USAGE
  drover install                    pick from a menu (gum), or the base set
  drover install <name>...          install these units and their dependsOn
  drover install --all              every unit this machine supports
  drover install --base             just the dependencies drover cannot run without
  drover install --list             what exists, what this box supports, and why not
  drover install --plan [<name>...] say what would happen and change nothing

EXIT
  0  everything asked for is installed (or already was)
  1  an install failed
  2  bad arguments
  3  refused: already present elsewhere, or a version you run
  4  a unit asked for is not supported on this machine

Installs binaries. Never logs anything in, never writes a credential.
`;

/**
 * THE ONE MANUAL STEP ON A TRULY BARE MACHINE. Drover is a node program — the
 * bus, the bridges and this engine all are — so node is a prerequisite of
 * drover rather than merely of the installer, and pretending otherwise would
 * mean a second manifest reader written in shell just to bootstrap the first.
 */
export const NO_NODE = `drover install needs node (>= 22) and this machine has none.

Drover itself is a node program — the bus, the bridges and the install engine —
so this is the one step that cannot install itself. Install node, then re-run:

  macOS          brew install node
  debian/ubuntu  sudo apt-get install -y nodejs npm
  fedora/rhel    sudo dnf install -y nodejs npm
  arch           sudo pacman -S --noconfirm nodejs npm

Drover takes it from there: \`drover install --base\`.
`;

/** `command -v node`, without a shell. */
export function hasNode(env: Record<string, string | undefined> = process.env): boolean {
    for (const dir of (env.PATH || '').split(':')) {
        if (!dir) continue;
        if (existsSync(join(dir, 'node'))) return true;
    }
    return false;
}

export interface InstallIo {
    out: (s: string) => void;
    err: (s: string) => void;
}

const processIo: InstallIo = {
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s),
};

interface InstallEngine {
    main: (argv: string[], opts?: unknown) => number;
}

export async function run(
    args: string[],
    io: InstallIo = processIo,
    env: Record<string, string | undefined> = process.env,
): Promise<number> {
    const first = args[0];
    if (first === '--help' || first === '-h' || first === 'help') {
        io.out(HELP);
        return 0;
    }
    if (!hasNode(env)) {
        io.err(NO_NODE);
        return 1;
    }
    const { loadEngine } = await import('./engine');
    const engine = await loadEngine<InstallEngine>('install.js');
    return engine.main(args);
}
