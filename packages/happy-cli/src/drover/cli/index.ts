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
        name: 'approval-parse',
        summary: "Read Claude Code's own approval dialog off a tmux pane capture. Pure: stdin to stdout.",
        load: () => import('./approval-parse'),
    },
    {
        name: 'ask',
        summary: 'Put a question on the phone, the watch and tmux, and block until a human answers it.',
        load: () => import('./ask'),
    },
    {
        name: 'check',
        summary: 'Refuse a tree whose header comments have become commands. The tripwire bin/drover runs before it dispatches.',
        load: () => import('./check'),
    },
    {
        name: 'daemon',
        summary: 'The fork\'s happy-cli daemon under a supervisor: adopt the one already running, or start it.',
        load: () => import('./daemon'),
    },
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
        name: 'needs',
        summary: 'Ask the human to DO something, and keep it on a list until it is.',
        load: () => import('./needs'),
    },
    {
        name: 'read',
        summary: 'Steer what the PHONE reads aloud. The Mac never speaks.',
        load: () => import('./read'),
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
        name: 'config',
        summary: 'Every edit drover makes to a file it does not own, and the command that takes it back out.',
        load: () => import('./config'),
    },
    {
        name: 'install',
        summary: 'Install the harnesses and the OS dependencies drover needs. Binaries only, never a login.',
        load: () => import('./install'),
    },
    {
        name: 'client',
        summary: 'The standalone prompt subscriber for this tmux server: one per server, and how it picks up new code.',
        load: () => import('./client'),
    },
    {
        name: 'share-sessions',
        summary: 'One session store for every account, so a flip stops copying transcripts. Dry run unless --apply.',
        load: () => import('./share-sessions'),
    },
    {
        name: 'accounts',
        summary: 'List subscriptions, and which are out of headroom. The registry merged with the cooldown ledger.',
        load: () => import('./accounts'),
    },
    {
        name: 'account',
        summary: 'The Claude subscriptions, and the sessions that run on them. list / add / rm / rename / use.',
        load: () => import('./account'),
    },
    {
        name: 'account-of',
        summary: 'Which account THIS process is running on, from the config dir rather than a stale stamp.',
        load: () => import('./account-of'),
    },
    {
        name: 'sessions',
        summary: 'What is running, where, and on which account. One session is one row, sized to the terminal.',
        load: () => import('./sessions'),
    },
    {
        name: 'pick-session',
        summary: 'Pick a conversation in this directory to resume, so the id is known before claude starts.',
        load: () => import('./pick-session'),
    },
    {
        name: 'stale-sessions',
        summary: 'Running sessions still on the CLI code the last build replaced, by name, and which of them relaunch themselves.',
        load: () => import('./stale-sessions'),
    },
    {
        name: 'flip',
        summary: 'Move a live session onto another Claude subscription, carrying the transcript. The escape hatch: never mediated by the policy.',
        load: () => import('./flip'),
    },
    {
        name: 'flip-policy',
        summary: 'The per-session answer to "you have run out": rank the accounts by headroom, decide, or do it.',
        load: () => import('./flip-policy'),
    },
    {
        name: 'settings',
        summary: 'The per-session flip policy: auto-flip, or ask first. Every path is a bus call, so the phone and the terminal cannot disagree.',
        load: () => import('./settings'),
    },
    {
        name: 'flip-menu',
        summary: 'A tmux picker for which account this pane flips to, ordered by headroom with the key on every row.',
        load: () => import('./flip-menu'),
    },
    {
        name: 'flip-request',
        summary: 'What the injected /flip slash command runs inside the claude child. Every path exits 0.',
        load: () => import('./flip-request'),
    },
    // --- the harness launcher family (DROVE-315 wave 3a) --------------------
    //
    // `codex`, `cursor` and `pi` are also arms in src/index.ts, which sits
    // above this table, so they are reached through the DROVER_NODE_LAUNCHERS
    // switch there rather than by falling through. The rest fall through like
    // every other verb. All of them share one pane opener, ./harness/tmuxEnter,
    // for the same reason the shell had exactly one: which server, which
    // session, and what a curated setup gets left alone is one set of rules.
    {
        name: 'tmux-enter',
        summary: 'Open a tmux window on the user\'s own server and run a command in it. The one place a session gets a pane.',
        load: () => import('./harness/tmuxEnter'),
    },
    {
        name: 'codex',
        summary: 'An OpenAI Codex session, managed like a Claude Code one.',
        load: () => import('./codex'),
    },
    {
        name: 'opencode',
        summary: 'An OpenCode session drover can see and the phone can drive.',
        load: () => import('./opencode'),
    },
    {
        name: 'cursor',
        summary: 'A Cursor agent session, managed like a Claude Code one.',
        load: () => import('./cursor'),
    },
    {
        name: 'pi',
        summary: 'A pi session drover can see and the phone can drive. The local-model harness.',
        load: () => import('./pi'),
    },
    {
        name: 'clone',
        summary: 'Seed a NEW session in another harness with this one\'s conversation. A flip moves accounts; a clone crosses harnesses.',
        load: () => import('./clone'),
    },
    {
        name: 'pick-cursor-chat',
        summary: 'Pick a Cursor chat in this directory to resume. The id on stdout, the list on stderr.',
        load: () => import('./pick-cursor-chat'),
    },
    {
        name: 'pick-pi-model',
        summary: 'Pick a model pi actually reports, by lookup against `pi --list-models`. Never free text.',
        load: () => import('./pick-pi-model'),
    },
    {
        name: 'pick-pi-session',
        summary: 'Pick a pi session to resume, for this project.',
        load: () => import('./pick-pi-session'),
    },
    {
        name: 'status',
        summary: 'Bus health, pending prompts, push delivery, gates, services. Reads only.',
        load: () => import('./status'),
    },
    {
        name: 'providers',
        summary: "OpenCode's custom model providers. The write half of `drover mcps`, and it never carries a key.",
        load: () => import('./providers'),
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
