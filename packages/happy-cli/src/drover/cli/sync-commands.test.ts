/**
 * `drover sync-commands`, checked against the shell it was ported from
 * (DROVE-315 wave 4).
 *
 * ONE FIXTURE, TWO IMPLEMENTATIONS, BYTE FOR BYTE — and for this verb the
 * bytes on stdout are the smaller half. It WRITES: two command files per
 * account, four kinds of symlink, a merged settings.json, a mirrored
 * .claude.json, an OpenCode `mcp` block spliced into a JSONC file somebody else
 * owns, and a stamp of every path it touched. So each case runs
 * cattle-drover/libexec/drover-sync-commands over one copy of the fixture and
 * the node verb over an identical copy, and compares stdout, stderr, the exit
 * code AND the whole resulting tree — every file's bytes and mode, every
 * symlink's target, and the stamp line for line.
 *
 * The two copies live at `<root>/sh` and `<root>/nd`, two characters each, so
 * folding one onto the other is a string replace that cannot change a length —
 * which matters, because a symlink's SIZE is its target's length and that size
 * is in the stamp.
 *
 * LC_ALL=C is exported to both. `sort -u` and sh's `*` glob order by the
 * locale's collation and the port orders by bytes; under C they are the same
 * order, which is the divergence named in the module header held still rather
 * than papered over.
 *
 * NOTHING HERE TOUCHES ANYTHING REAL. HAPPY_HOME_DIR is pinned to a throwaway
 * directory before the first import and refused at every run and every spawn;
 * HOME is a temp dir, so ~/.claude, ~/.claude-accounts and ~/.config/opencode
 * are the fixture's and never Clay's; STATE_DIR is a temp dir, so no local.env
 * of his is read and no stamp of his is overwritten; DROVER_URL points at a
 * port nothing listens on. The verb opens no socket and starts no session at
 * all — the only thing it spawns in shell form is `node
 * engine/opencode-mirror.js`, which the port loads in process instead.
 */

import { spawnSync } from 'node:child_process';
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    readlinkSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { droverEnv } from './env';

/**
 * A throwaway HAPPY_HOME_DIR, pinned above every import (DROVE-336).
 *
 * A bench that did not set it once registered seventy-eight real sessions on
 * Clay's phone, because the entry takes an unknown word to Claude and Claude
 * registers. Nothing in this file goes near the entry, and this is what makes
 * that a fact rather than an intention.
 */
const { happyHome, realHappyHome } = await vi.hoisted(async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const realHappyHome = path.join(os.homedir(), '.happy');
    const happyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-commands-happy-'));
    process.env.HAPPY_HOME_DIR = happyHome;
    process.env.HAPPY_SERVER_URL = 'http://127.0.0.1:1';
    return { happyHome, realHappyHome };
});

vi.mock('../../configuration', () => {
    throw new Error('sync-commands.test: configuration was imported; this verb must not reach the session machinery');
});
vi.mock('../../api/api', () => {
    throw new Error('sync-commands.test: api/api was imported; this verb must not reach the session machinery');
});

type Env = Record<string, string | undefined>;

function refuseRealHappyHome(env: Env, where: string): void {
    const raw = env.HAPPY_HOME_DIR;
    const at = raw ? resolve(raw.replace(/^~/, homedir())) : resolve(realHappyHome);
    if (at === resolve(realHappyHome)) {
        throw new Error(`${where}: HAPPY_HOME_DIR resolves to the real ${realHappyHome}. Refusing.`);
    }
}

const droverDir = droverEnv({ ...process.env, DROVER_DIR: process.env.DROVER_DIR }).droverDir;
const shellVerb = join(droverDir, 'libexec', 'drover-sync-commands');
/** What the verb bakes into the command files: `$root` is the REALPATH of $0. */
const libexec = existsSync(shellVerb) ? dirname(realpathSync(shellVerb)) : join(droverDir, 'libexec');

let root = '';
/**
 * A bin directory holding the REAL jq and node, prepended to both sides' PATH.
 *
 * jq and node are asdf SHIMS on this machine and a shim reads its version from
 * $HOME — which the fixture replaces with a tmpdir, so the shim finds no
 * install and exits 1. The shell verb then reports `could not read <registry>`
 * for a registry that is perfectly fine, which is a fixture artefact and not a
 * difference between the two implementations. Resolving the binaries once
 * removes it.
 */
let toolBin = '';

// --- the fixture --------------------------------------------------------------

/**
 * A default tree, three accounts and an OpenCode config, all under one HOME.
 *
 * The shapes are the ones cattle-drover's own suites pin, gathered into one
 * tree so a single run exercises every branch that writes:
 *
 *   default/          skills, agents and a commands/ holding both a plain file
 *                     and a DIRECTORY, so the per-entry link pass has one of
 *                     each; settings.json with hooks, allow/deny/ask and three
 *                     keys that must never travel; .claude.json with the five
 *                     server shapes the OpenCode converter has to face —
 *                     including the ${VAR:+alt} it must skip BY NAME and the
 *                     ${VAR:-default} DROVE-317 taught it to resolve.
 *   accts/one         an account with its own theme, model, allow and deny —
 *                     the add-only merge and the "preferences stay" split.
 *   accts/two         a config dir and nothing in it, which is what `drover
 *                     account login` leaves behind: the fresh-account path.
 *   accts/forgotten   a directory the registry does not name, which the sweep
 *                     picks up because the registry's own accounts live there.
 *   ~/.claude         named by the `"configDir": "default"` spelling, so the
 *                     resolver that once wrote ./default/commands/flip.md into
 *                     the launch directory is exercised too.
 *   a cursor row      carries no configDir and must be SKIPPED (DROVE-256).
 *   opencode.jsonc    Clay's own comments, a provider block holding an apiKey
 *                     and a stale mcp block: everything outside the block has
 *                     to survive byte for byte.
 */
function seed(base: string): void {
    const home = join(base, 'home');
    const def = join(home, 'default');
    const accts = join(home, 'accts');
    const oc = join(home, 'opencode');
    mkdirSync(join(def, 'skills', 'huly-ticket'), { recursive: true });
    mkdirSync(join(def, 'agents'), { recursive: true });
    mkdirSync(join(def, 'commands', 'agent-os'), { recursive: true });
    mkdirSync(join(accts, 'one'), { recursive: true });
    mkdirSync(join(accts, 'two'), { recursive: true });
    mkdirSync(join(accts, 'forgotten'), { recursive: true });
    mkdirSync(oc, { recursive: true });
    mkdirSync(join(base, 'state'), { recursive: true });

    writeFileSync(join(def, 'skills', 'huly-ticket', 'SKILL.md'), 'x\n');
    writeFileSync(join(def, 'agents', 'code-reviewer.md'), 'x\n');
    writeFileSync(join(def, 'commands', 'other.md'), 'x\n');
    writeFileSync(join(def, 'commands', 'agent-os', 'plan-new-product.md'), 'x\n');
    writeFileSync(join(def, 'settings.json'), `${JSON.stringify({
        permissions: {
            allow: ['mcp__pdf__*'],
            deny: ['mcp__thunderbird-mail__deleteMessages'],
            ask: ['Skill(update-config)'],
        },
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'gate' }] }] },
        model: 'claude-opus-5',
        theme: 'light',
        enabledPlugins: { 'swift-lsp@claude-plugins-official': true },
        tui: 'fullscreen',
    }, null, 2)}\n`);
    writeFileSync(join(def, '.claude.json'), `${JSON.stringify({
        mcpServers: {
            huly: { command: 'node', args: ['/x/huly.js'], env: { HULY_HELPER: '${HOME}/helper.sh' } },
            pdf: { command: 'uv', args: ['run', 'pdf.py'] },
            serpapi: { type: 'http', url: 'https://serp.example/mcp?key=${SERPAPI_KEY}' },
            gitlab: { command: 'npx', env: { GITLAB_URL: '${GITLAB_URL:-https://gitlab.com}' } },
            picky: { command: 'npx', env: { PICKY_FLAGS: '${PICKY_MODE:+--strict}' } },
        },
        oauthAccount: { emailAddress: 'def@example.com' },
        userID: 'main-user',
        hasCompletedOnboarding: true,
    }, null, 2)}\n`);

    writeFileSync(join(accts, 'one', 'settings.json'), `${JSON.stringify({
        theme: 'dark',
        model: 'claude-sonnet-5',
        skipDangerousModePermissionPrompt: true,
        permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(curl:*)'] },
    }, null, 2)}\n`);
    writeFileSync(join(accts, 'one', '.claude.json'), `${JSON.stringify({
        oauthAccount: { emailAddress: 'one@example.com' },
        userID: 'one-user',
        numStartups: 7,
        projects: { '/tmp/p': { hasTrustDialogAccepted: true } },
        mcpServers: { gone: { command: 'x' } },
    }, null, 2)}\n`);

    writeFileSync(join(home, 'accounts.json'), `${JSON.stringify([
        { name: 'main', configDir: 'default' },
        { name: 'one', configDir: join(accts, 'one') },
        { name: 'two', configDir: join(accts, 'two') },
        { name: 'cur', harness: 'cursor' },
    ], null, 2)}\n`);

    writeFileSync(join(oc, 'opencode.jsonc'), [
        "// clay's own header, which the mirror must not touch",
        '{',
        '  // a comment clay wrote',
        '  "theme": "dark",',
        '  "provider": {',
        '    "myrouter": {',
        '      "name": "My Router",',
        '      "options": { "apiKey": "{env:MYROUTER_API_KEY}" }',
        '    }',
        '  },',
        '  "mcp": {"stale": {"type": "local", "command": ["gone"]}},',
        '  "keybinds": {"leader": "ctrl+x"}',
        '}',
        '',
    ].join('\n'));
}

function fixtureEnv(twin: 'sh' | 'nd', over: Env = {}): Env {
    const base = join(root, twin);
    const home = join(base, 'home');
    return {
        PATH: `${toolBin}:${process.env.PATH ?? ''}`,
        HOME: home,
        LC_ALL: 'C',
        DROVER_DIR: droverDir,
        STATE_DIR: join(base, 'state'),
        DROVER_ACCOUNTS: join(home, 'accounts.json'),
        DROVER_DEFAULT_CONFIG_DIR: join(home, 'default'),
        DROVER_ACCOUNTS_DIR: join(home, 'accts'),
        DROVER_SYNC_STAMP: join(base, 'state', 'stamp'),
        OPENCODE_CONFIG_DIR: join(home, 'opencode'),
        DROVER_URL: 'http://127.0.0.1:1',
        HAPPY_HOME_DIR: happyHome,
        HAPPY_SERVER_URL: 'http://127.0.0.1:1',
        ...over,
    };
}

// --- running the two sides ----------------------------------------------------

interface Ran { stdout: string; stderr: string; code: number }

function shell(args: string[], over: Env = {}): Ran {
    const env = fixtureEnv('sh', over);
    refuseRealHappyHome(env, 'sync-commands.test: spawn');
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
    const res = spawnSync(shellVerb, args, { env: clean, encoding: 'utf8' });
    if (res.error || res.status === 126 || res.status === 127) {
        throw new Error(`sync-commands.test: could not run ${shellVerb} (status ${res.status}, ${String(res.error)}) stderr=${res.stderr}`);
    }
    return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', code: res.status ?? 0 };
}

/**
 * The node verb, in this process, with the LIVE environment swapped.
 *
 * Mutated in place rather than `process.env = {...}`, and that is not style.
 * Replacing the object leaves getenv() alone, so os.homedir() — which
 * engine/opencode-mirror.js uses to tildeify the source it names inside the
 * generated block — would still answer Clay's real home while the shell child,
 * which gets HOME through exec, answers the fixture's. Same environment, both
 * sides, is what makes the comparison mean anything.
 */
async function node(args: string[], over: Env = {}): Promise<Ran> {
    const env = fixtureEnv('nd', over);
    refuseRealHappyHome(env, 'sync-commands.test: in-process run');
    const saved: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) saved[k] = v;
    const install = (vars: Record<string, string | undefined>): void => {
        for (const k of Object.keys(process.env)) delete process.env[k];
        for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
    };
    let stdout = '';
    let stderr = '';
    const outWrite = process.stdout.write.bind(process.stdout);
    const errWrite = process.stderr.write.bind(process.stderr);
    install(env);
    (process.stdout as unknown as { write: (c: string) => boolean }).write = (c: string) => {
        stdout += String(c);
        return true;
    };
    (process.stderr as unknown as { write: (c: string) => boolean }).write = (c: string) => {
        stderr += String(c);
        return true;
    };
    try {
        const { run } = await import('./sync-commands');
        const code = await run(args);
        return { stdout, stderr, code };
    } finally {
        install(saved);
        (process.stdout as unknown as { write: typeof outWrite }).write = outWrite;
        (process.stderr as unknown as { write: typeof errWrite }).write = errWrite;
    }
}

/** The one legitimate difference between the two runs: which copy they edited. */
function fold(text: string): string {
    return text.split(`${root}/sh`).join(`${root}/T`).split(`${root}/nd`).join(`${root}/T`);
}

/** Both sides, same arguments, folded; returns the node answer for pinning. */
async function both(args: string[], over: Env = {}): Promise<Ran> {
    const sh = shell(args, over);
    const nd = await node(args, over);
    expect(fold(nd.stdout), `stdout for ${args.join(' ')}`).toBe(fold(sh.stdout));
    expect(fold(nd.stderr), `stderr for ${args.join(' ')}`).toBe(fold(sh.stderr));
    expect(nd.code, `exit code for ${args.join(' ')}`).toBe(sh.code);
    expectSameTree();
    return nd;
}

// --- comparing what was WRITTEN ----------------------------------------------

/**
 * The tree as one flat map: every path's kind, mode, bytes and link target.
 *
 * A backup's name carries a UTC second, so two runs a second apart would name
 * two different files for the same content; the second is folded out of the KEY
 * and the content is still compared. The stamp's mtime column is folded out for
 * the same reason and nothing else in it is: the paths, their order, the sizes,
 * the modes and the symlink targets all have to match line for line.
 */
function snapshot(base: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (dir: string, rel: string): void => {
        for (const name of readdirSync(dir).sort()) {
            const path = join(dir, name);
            // A backup is named for the UTC SECOND it was taken, so two writes
            // inside one second overwrite each other and two a second apart do
            // not. Which of those happens is wall-clock luck and identical in
            // both implementations, so the second is folded out of the key and
            // every backup of one prefix collapses onto the newest — whose
            // content is the file as it stood before the last write, which both
            // sides performed identically. The bytes are still compared; only
            // the count of same-prefix backups, the part that is timing, is not.
            const plain = name.replace(/^(.*)\.\d{8}T\d{6}Z\.json$/, '$1.<stamped>.json');
            const key = rel ? `${rel}/${plain}` : plain;
            const st = lstatSync(path);
            if (st.isSymbolicLink()) {
                out[key] = `L ${fold(readlinkSync(path))}`;
                continue;
            }
            if (st.isDirectory()) {
                out[key] = 'D';
                walk(path, rel ? `${rel}/${name}` : name);
                continue;
            }
            let body = fold(readFileSync(path, 'utf8'));
            if (key === 'state/stamp') body = blankMtimes(body);
            out[key] = `F ${(st.mode & 0o777).toString(8)} ${body}`;
        }
    };
    walk(base, '');
    return out;
}

/** The mtime column of a stamp line, which two copies made a second apart differ on. */
function blankMtimes(text: string): string {
    return text.split('\n').map((line) => {
        const f = line.split('\t');
        if (f.length < 3 || f[0] === 'header') return line;
        f[1] = '<m>';
        return f.join('\t');
    }).join('\n');
}

function expectSameTree(): void {
    expect(snapshot(join(root, 'nd'))).toEqual(snapshot(join(root, 'sh')));
}

/** Read a JSON file out of the node twin. */
function ndJson(...parts: string[]): Record<string, unknown> {
    return JSON.parse(readFileSync(join(root, 'nd', 'home', ...parts), 'utf8')) as Record<string, unknown>;
}

function ndText(...parts: string[]): string {
    return readFileSync(join(root, 'nd', 'home', ...parts), 'utf8');
}

let realJq = '';

beforeAll(() => {
    refuseRealHappyHome(process.env, 'sync-commands.test');
    if (!existsSync(shellVerb)) throw new Error(`sync-commands.test: no shell verb at ${shellVerb}`);
    const jq = spawnSync('sh', ['-c', 'asdf which jq 2>/dev/null || command -v jq'], { encoding: 'utf8' });
    realJq = (jq.stdout ?? '').trim();
    if ((jq.status ?? 1) !== 0 || realJq === '' || realJq.includes('/shims/')) {
        throw new Error(`sync-commands.test: need a real jq binary for the shell half of the comparison, got '${realJq}'`);
    }
    root = mkdtempSync(join(tmpdir(), 'drover-sync-'));
    toolBin = join(root, 'bin');
    mkdirSync(toolBin, { recursive: true });
    symlinkSync(realJq, join(toolBin, 'jq'));
    symlinkSync(process.execPath, join(toolBin, 'node'));
    seed(join(root, 'sh'));
    seed(join(root, 'nd'));
});

afterAll(() => {
    // The pinned happy home is exactly as empty as mkdtemp made it.
    const left = existsSync(happyHome) ? readdirSync(happyHome) : [];
    expect(left).toEqual([]);
    rmSync(happyHome, { recursive: true, force: true });
    if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('drover sync-commands — the arguments', () => {
    it('--help is byte-identical, and answers before anything is loaded', async () => {
        for (const flag of ['-h', '--help']) {
            const r = await both([flag]);
            expect(r.code).toBe(0);
            // Not two empty answers: the sentences the bats suite greps for.
            expect(r.stdout).toContain('--force');
            expect(r.stdout).toContain('It keeps a stamp of every path it reads and writes');
            expect(r.stdout).toContain("drover-sync-commands — put /flip in every account's Claude Code config dir.");
            expect(r.stdout.trimEnd().endsWith('commands beats no session.')).toBe(true);
        }
        // -v before it is still help, and the engine is never reached.
        const { run } = await import('./sync-commands');
        const io = {
            loadMirror: () => {
                throw new Error('help must not load engine/opencode-mirror.js');
            },
        };
        const outWrite = process.stdout.write.bind(process.stdout);
        (process.stdout as unknown as { write: (c: string) => boolean }).write = () => true;
        try {
            expect(await run(['-v', '--help'], io)).toBe(0);
        } finally {
            (process.stdout as unknown as { write: typeof outWrite }).write = outWrite;
        }
    });

    it('an unknown argument exits 2 with the same sentence, before help can answer', async () => {
        const bad = await both(['--nope']);
        expect(bad.code).toBe(2);
        expect(bad.stderr).toBe("drover-sync-commands: unknown argument '--nope' (try --help)\n");
        expect(bad.stdout).toBe('');
        // The loop is left to right, so an unknown word ahead of --help wins.
        const first = await both(['--nope', '--help']);
        expect(first.code).toBe(2);
        expect(first.stdout).toBe('');
        // ...and one behind it does not, because help already returned.
        const second = await both(['--help', '--nope']);
        expect(second.code).toBe(0);
    });

    it('a missing, an empty and an unreadable registry each say their own thing', async () => {
        const missing = await both(['-v'], { DROVER_ACCOUNTS: join(root, 'sh', 'home', 'nope.json') });
        expect(missing.code).toBe(0);
        expect(missing.stdout).toContain('no registry at ');
        expect(missing.stdout).toContain('nope.json');

        writeFileSync(join(root, 'sh', 'home', 'empty.json'), '[]\n');
        writeFileSync(join(root, 'nd', 'home', 'empty.json'), '[]\n');
        const empty = await both(['-v'], { DROVER_ACCOUNTS: join(root, 'sh', 'home', 'empty.json') });
        expect(empty.stdout).toContain('no accounts in ');

        writeFileSync(join(root, 'sh', 'home', 'bad.json'), '{ mid-edit');
        writeFileSync(join(root, 'nd', 'home', 'bad.json'), '{ mid-edit');
        const bad = await both(['-v'], { DROVER_ACCOUNTS: join(root, 'sh', 'home', 'bad.json') });
        expect(bad.stdout).toContain('could not read ');
    });

    it('a relative configDir is refused out loud, and plants nothing', async () => {
        writeFileSync(join(root, 'sh', 'home', 'rel.json'), '[{"name":"bad","configDir":"oops/relative"}]\n');
        writeFileSync(join(root, 'nd', 'home', 'rel.json'), '[{"name":"bad","configDir":"oops/relative"}]\n');
        const r = await both([], { DROVER_ACCOUNTS: join(root, 'sh', 'home', 'rel.json'), OPENCODE_CONFIG_DIR: undefined });
        expect(r.code).toBe(0);
        expect(r.stderr).toBe("drover-sync-commands: skipping configDir 'oops/relative' — not an absolute path\n");
        expect(existsSync(join(root, 'nd', 'home', 'oops'))).toBe(false);
        expect(existsSync(join(process.cwd(), 'oops'))).toBe(false);
    });
});

describe('drover sync-commands — the sync that writes', () => {
    it('the first full run agrees on every line and every byte it wrote', async () => {
        const r = await both(['-v']);
        expect(r.code).toBe(0);

        // Not two empty answers. The command files, the links, the two merges
        // and the opencode splice all really happened, and the cursor row and
        // the forgotten sweep behaved.
        expect(r.stdout).toContain(`wrote ${join(root, 'nd', 'home', 'accts', 'one', 'commands', 'flip.md')}`);
        expect(r.stdout).toContain(`wrote ${join(root, 'nd', 'home', 'accts', 'two', 'commands', 'todos.md')}`);
        expect(r.stdout).toContain(`wrote ${join(root, 'nd', 'home', '.claude', 'commands', 'flip.md')}`);
        expect(r.stdout).toContain(`linked ${join(root, 'nd', 'home', 'accts', 'one', 'skills')} -> ${join(root, 'nd', 'home', 'default', 'skills')}`);
        expect(r.stdout).toContain(`merged ${join(root, 'nd', 'home', 'accts', 'one', 'settings.json')}`);
        expect(r.stdout).toContain(`mirrored ${join(root, 'nd', 'home', 'accts', 'two', '.claude.json')}`);
        expect(r.stdout).toContain('mirrored ');
        expect(r.stdout).toContain('opencode.jsonc (4 servers, 1 skipped)');
        expect(r.stdout).toContain('skipped picky');
        expect(r.stdout).toContain('defaulted gitlab: GITLAB_URL');
        // A directory the registry has forgotten is swept, and a cursor row is
        // not resolved to the ambient account.
        expect(r.stdout).toContain(`linked ${join(root, 'nd', 'home', 'accts', 'forgotten', 'agents')}`);
        expect(existsSync(join(root, 'nd', 'home', 'accts', 'forgotten', 'commands', 'flip.md'))).toBe(false);

        // The capability, not the listing: the file is reachable THROUGH the link.
        expect(existsSync(join(root, 'nd', 'home', 'accts', 'one', 'skills', 'huly-ticket', 'SKILL.md'))).toBe(true);
        expect(existsSync(join(root, 'nd', 'home', 'accts', 'one', 'commands', 'agent-os', 'plan-new-product.md'))).toBe(true);
        expect(lstatSync(join(root, 'nd', 'home', 'accts', 'one', 'commands', 'flip.md')).isSymbolicLink()).toBe(false);
        // The source is never linked to itself, and never written back.
        expect(existsSync(join(root, 'nd', 'home', 'default', 'skills', 'skills'))).toBe(false);
        expect(ndJson('default', 'settings.json').model).toBe('claude-opus-5');

        // Policy in, preferences left alone, and the merge adds without widening.
        const one = ndJson('accts', 'one', 'settings.json');
        const perms = one.permissions as Record<string, string[]>;
        expect(one.theme).toBe('dark');
        expect(one.model).toBe('claude-sonnet-5');
        expect(one.enabledPlugins).toBeUndefined();
        expect(one.tui).toBeUndefined();
        expect(perms.deny).toEqual(['Bash(curl:*)', 'mcp__thunderbird-mail__deleteMessages']);
        expect(perms.allow).toEqual(['Bash(ls:*)', 'mcp__pdf__*']);
        expect(perms.ask).toEqual(['Skill(update-config)']);
        // A fresh account inherits POLICY and nothing else.
        expect(Object.keys(ndJson('accts', 'two', 'settings.json'))).toEqual(['hooks', 'permissions']);
        // Mirrored, not unioned: `gone` is gone. Identity and history stay.
        const oneCfg = ndJson('accts', 'one', '.claude.json');
        expect(Object.keys(oneCfg.mcpServers as object).sort()).toEqual(['gitlab', 'huly', 'pdf', 'picky', 'serpapi']);
        expect((oneCfg.oauthAccount as Record<string, string>).emailAddress).toBe('one@example.com');
        expect(oneCfg.numStartups).toBe(7);
        expect(oneCfg.hasCompletedOnboarding).toBeUndefined();
        // A file this run CREATED starts private, because a server carries env.
        expect((lstatSync(join(root, 'nd', 'home', 'accts', 'two', '.claude.json')).mode & 0o777).toString(8)).toBe('600');
        // The old file is kept before the write, once.
        expect(readdirSync(join(root, 'nd', 'home', 'accts', 'one', 'drover-backups')).length).toBe(2);

        // Everything outside the opencode mcp block survives byte for byte.
        const jsonc = ndText('opencode', 'opencode.jsonc');
        expect(jsonc).toContain("// clay's own header, which the mirror must not touch");
        expect(jsonc).toContain('  "theme": "dark",');
        expect(jsonc).toContain('"apiKey": "{env:MYROUTER_API_KEY}"');
        expect(jsonc).toContain('"keybinds": {"leader": "ctrl+x"}');
        expect(jsonc).not.toContain('"stale"');
        expect(jsonc).toContain('// skipped picky:');
        const mcp = JSON.parse(jsonc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')) as {
            mcp: Record<string, Record<string, unknown>>;
        };
        expect(Object.keys(mcp.mcp).sort()).toEqual(['gitlab', 'huly', 'pdf', 'serpapi']);
        expect((mcp.mcp.huly.environment as Record<string, string>).HULY_HELPER).toBe('{env:HOME}/helper.sh');
        expect((mcp.mcp.gitlab.environment as Record<string, string>).GITLAB_URL).toBe('https://gitlab.com');
    });

    it('the stamp is written, and honoured on the second run', async () => {
        const stamp = readFileSync(join(root, 'nd', 'state', 'stamp'), 'utf8');
        expect(stamp.split('\n')[0].startsWith('header\tv2\t')).toBe(true);
        expect(stamp).toContain(join(root, 'nd', 'home', 'accts', 'one', 'commands', 'flip.md'));

        const again = await both(['-v']);
        expect(again.code).toBe(0);
        expect(again.stdout).toBe('unchanged since the last run -- nothing to do\n');
        // Not "wrote nothing" -- it must not even LOOK.
        expect(again.stdout).not.toContain('.claude.json');
        expect(again.stdout).not.toContain('already linked');
    });

    it('--force ignores the stamp and finds every pass a fixed point', async () => {
        const r = await both(['-v', '--force']);
        expect(r.code).toBe(0);
        expect(r.stdout).not.toContain('nothing to do');
        expect(r.stdout).toContain(`unchanged ${join(root, 'nd', 'home', 'accts', 'one', 'commands', 'flip.md')}`);
        expect(r.stdout).toContain(`unchanged ${join(root, 'nd', 'home', 'accts', 'one', 'settings.json')}`);
        expect(r.stdout).toContain(`unchanged ${join(root, 'nd', 'home', 'accts', 'one', '.claude.json')}`);
        expect(r.stdout).toContain(`already linked ${join(root, 'nd', 'home', 'accts', 'one', 'skills')}`);
        expect(r.stdout).not.toContain('wrote ');
        // A fixed point writes no second backup.
        expect(readdirSync(join(root, 'nd', 'home', 'accts', 'one', 'drover-backups')).length).toBe(2);
    });

    it('a changed source reaches every account; an account that drifted is repaired alone', async () => {
        for (const twin of ['sh', 'nd'] as const) {
            const file = join(root, twin, 'home', 'default', '.claude.json');
            const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
            delete doc.mcpServers.pdf;
            doc.mcpServers.chatgpt = { command: 'node' };
            writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
        }
        const spread = await both(['-v']);
        expect(spread.stdout).toContain(`mirrored ${join(root, 'nd', 'home', 'accts', 'one', '.claude.json')}`);
        expect(spread.stdout).toContain(`mirrored ${join(root, 'nd', 'home', 'accts', 'two', '.claude.json')}`);
        // MIRROR, not union: a deletion in the source is a deletion everywhere.
        expect(Object.keys(ndJson('accts', 'one', '.claude.json').mcpServers as object).sort())
            .toEqual(['chatgpt', 'gitlab', 'huly', 'picky', 'serpapi']);

        // Now break ONE account: `claude mcp remove` writes this very file, and
        // somebody deleting a symlink is not hypothetical either.
        for (const twin of ['sh', 'nd'] as const) {
            const dir = join(root, twin, 'home', 'accts', 'one');
            const doc = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')) as Record<string, unknown>;
            delete doc.mcpServers;
            writeFileSync(join(dir, '.claude.json'), `${JSON.stringify(doc, null, 2)}\n`);
            rmSync(join(dir, 'skills'));
        }
        const repair = await both(['-v']);
        expect(repair.stdout).toContain(`mirrored ${join(root, 'nd', 'home', 'accts', 'one', '.claude.json')}`);
        expect(repair.stdout).toContain(`linked ${join(root, 'nd', 'home', 'accts', 'one', 'skills')}`);
        // ...and the account that did NOT drift was left alone.
        expect(repair.stdout).not.toContain(`mirrored ${join(root, 'nd', 'home', 'accts', 'two', '.claude.json')}`);
    });

    it('a file that does not parse is kept, and picked up when it is fixed', async () => {
        for (const twin of ['sh', 'nd'] as const) {
            writeFileSync(join(root, twin, 'home', 'accts', 'one', 'settings.json'), 'not json at all');
        }
        const kept = await both(['-v']);
        expect(kept.stdout).toContain(`kept ${join(root, 'nd', 'home', 'accts', 'one', 'settings.json')} (it does not parse -- refusing to rewrite it)`);
        expect(ndText('accts', 'one', 'settings.json')).toBe('not json at all');

        // KEPT is a decision, not a failure, so it stamps.
        const quiet = await both(['-v']);
        expect(quiet.stdout).toBe('unchanged since the last run -- nothing to do\n');

        for (const twin of ['sh', 'nd'] as const) {
            writeFileSync(join(root, twin, 'home', 'accts', 'one', 'settings.json'), '{"theme":"dark"}');
        }
        const fixed = await both(['-v']);
        expect(fixed.stdout).toContain(`merged ${join(root, 'nd', 'home', 'accts', 'one', 'settings.json')}`);
        const one = ndJson('accts', 'one', 'settings.json');
        expect(one.theme).toBe('dark');
        expect(Object.keys(one.hooks as object)).toEqual(['PreToolUse']);
    });

    it('a run that FAILED is not remembered as done', async () => {
        // A new account the registry names but whose directory cannot be made:
        // a FILE where the config dir should be is the cheapest way to say it,
        // and it is the same failure `mkdir -p` reports on a read-only parent.
        for (const twin of ['sh', 'nd'] as const) {
            const home = join(root, twin, 'home');
            writeFileSync(join(home, 'accts', 'blocked'), 'not a directory\n');
            const reg = join(home, 'accounts.json');
            const rows = JSON.parse(readFileSync(reg, 'utf8')) as Record<string, string>[];
            rows.push({ name: 'blocked', configDir: join(home, 'accts', 'blocked') });
            writeFileSync(reg, `${JSON.stringify(rows, null, 2)}\n`);
        }
        const failed = await both(['-v']);
        expect(failed.code).toBe(0);
        expect(failed.stdout).toContain(`skipped ${join(root, 'nd', 'home', 'accts', 'blocked')} (could not create commands/)`);
        // The stamp was NOT written, so the next run does the whole pass again
        // rather than reporting a state it never reached.
        const retry = await both(['-v']);
        expect(retry.stdout).not.toContain('nothing to do');
        expect(retry.stdout).toContain(`skipped ${join(root, 'nd', 'home', 'accts', 'blocked')} (could not create commands/)`);
    });

    it('a new account is synced on the start that finds it', async () => {
        for (const twin of ['sh', 'nd'] as const) {
            const home = join(root, twin, 'home');
            // Clear the blocked row from the previous case so this run is clean.
            rmSync(join(home, 'accts', 'blocked'));
            mkdirSync(join(home, 'accts', 'three'), { recursive: true });
            const reg = join(home, 'accounts.json');
            const rows = (JSON.parse(readFileSync(reg, 'utf8')) as Record<string, string>[])
                .filter((r) => r.name !== 'blocked');
            rows.push({ name: 'three', configDir: join(home, 'accts', 'three') });
            writeFileSync(reg, `${JSON.stringify(rows, null, 2)}\n`);
        }
        const r = await both(['-v']);
        expect(r.code).toBe(0);
        expect(existsSync(join(root, 'nd', 'home', 'accts', 'three', 'commands', 'flip.md'))).toBe(true);
        expect(readlinkSync(join(root, 'nd', 'home', 'accts', 'three', 'skills')))
            .toBe(join(root, 'nd', 'home', 'default', 'skills'));
        expect(Object.keys(ndJson('accts', 'three', '.claude.json').mcpServers as object).length).toBe(5);
        // And it settles: the run after it has nothing to say.
        const settled = await both(['-v']);
        expect(settled.stdout).toBe('unchanged since the last run -- nothing to do\n');
    });

    it('a fixture default tree with no opencode override writes no opencode config', async () => {
        // The line every case here stands behind: a run whose SOURCE is a tmpdir
        // fixture must not write fake servers into the real ~/.config/opencode.
        const r = await both(['-v', '--force'], { OPENCODE_CONFIG_DIR: undefined });
        expect(r.code).toBe(0);
        expect(r.stdout).toContain('.claude.json');
        expect(r.stdout).not.toContain('opencode');
    });

    it('the command files carry the paths the model has to be allowed to run', () => {
        const flip = ndText('accts', 'one', 'commands', 'flip.md');
        const todos = ndText('accts', 'one', 'commands', 'todos.md');
        expect(flip).toContain(`allowed-tools: Bash(${join(libexec, 'drover-flip-request')}:*)`);
        expect(flip).toContain('Flip status: !`');
        expect(flip).toContain('$ARGUMENTS');
        expect(todos).toContain(`allowed-tools: Bash(${join(libexec, 'drover-todos')}:*)`);
        expect(todos).toContain('managed by drover-sync-commands (DROVE-53)');
    });
});

describe('the verb table', () => {
    it('carries sync-commands, lazily', async () => {
        const { droverVerbs } = await import('./index');
        const row = droverVerbs.find((v) => v.name === 'sync-commands');
        expect(row).toBeDefined();
        expect(row?.summary).toContain("/flip in every account's Claude Code config dir");
    });
});
