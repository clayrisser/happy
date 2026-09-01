/**
 * The drover verbs that run in node (DROVE-315).
 *
 * cattle-drover's `bin/drover` dispatches a verb it KNOWS to a POSIX-sh file
 * under libexec/ and hands anything else to this CLI unchanged. Those shell
 * files are moving here, verb by verb, and this table is where a moved verb
 * lands: one row, one lazily imported module, one `run(args)` returning the
 * exit code the shell file used to.
 *
 * LAZY, and the entry stays that way (DROVE-288, DROVE-314). Nothing in this
 * file imports a verb; `load` is an `import()` pkgroll splits into its own
 * chunk, so `drover mcps` compiles mcps and nothing else, and a verb that is
 * never typed is never loaded. The table itself has no imports beyond types
 * and costs one small chunk, paid only after every one of the fork's own arms
 * has declined the subcommand.
 *
 * WHAT A VERB IS. `run(args)` gets everything after the verb name, exactly as
 * `shift; run "$libexec/drover-<verb>" "$@"` passed it. It writes what it
 * writes and resolves to the exit code; it does not call process.exit, so the
 * entry can flush stdout before ending the process (see exit.ts). Help is the
 * verb's own — the shell file answered `--help` itself before spawning
 * anything, and the ported verb keeps that text.
 *
 * WHICH VERBS. Only those whose shell file was a wrapper around engine/ or the
 * bus. The rest are owned by in-flight shell lanes and are listed, with an
 * order and the test each one carries, in cattle-drover/docs/node-port.md.
 * bin/drover still routes a name in this table to libexec/ until its arm is
 * flipped there; until then the node verb is reachable as `drover.mjs <verb>`
 * (and `node dist/index.mjs <verb>`), which is how it is tested.
 */

export interface DroverVerb {
    /** The verb as typed: `drover <name>`. */
    name: string;
    /** One line for `drover --help`, in the shell usage's voice. */
    summary: string;
    /** The arm. Split into its own chunk by pkgroll; loaded on use only. */
    load: () => Promise<{ run: (args: string[]) => Promise<number> }>;
}

export const droverVerbs: readonly DroverVerb[] = [
    {
        name: 'mcps',
        summary: 'The MCP servers and model providers each harness is configured with. Reads only.',
        load: () => import('./mcps'),
    },
    {
        name: 'questions',
        summary: 'Every prompt still waiting for an answer, anywhere, including the ones no session owns.',
        load: () => import('./questions'),
    },
    {
        name: 'reclaim-sessions',
        summary: 'What the one-store merge parked under superseded/, and what --apply would really free. Never a file the store lacks.',
        load: () => import('./reclaim-sessions'),
    },
    {
        name: 'todos',
        summary: 'The things a session needs you to do, until you have done them.',
        load: () => import('./todos'),
    },
    {
        name: 'share-sessions',
        summary: 'One session store for every account, so a flip stops copying transcripts. Dry run unless --apply.',
        load: () => import('./share-sessions'),
    },
];

/** Is this a verb the node CLI carries? */
export function knowsDroverVerb(name: string): boolean {
    return droverVerbs.some((v) => v.name === name);
}

/**
 * Run a verb. Resolves to its exit code, or null when the name is not a verb
 * here — the entry then lets the argument fall through to where it went
 * before, so an unknown word still reaches Claude as it always has.
 */
export async function runDroverVerb(name: string, args: string[]): Promise<number | null> {
    const verb = droverVerbs.find((v) => v.name === name);
    if (!verb) return null;
    const { run } = await verb.load();
    return run(args);
}
