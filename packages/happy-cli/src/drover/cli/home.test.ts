/**
 * `drover home` — the read half, against cattle-drover's own shell verb
 * (DROVE-315 wave 4, DROVE-309).
 *
 * THE GATE IS THE DIFFERENTIAL. One fixture HOME, four shapes of it — fresh,
 * all-legacy, all-migrated, and the half-migrated tree that carries every
 * blocked state at once — and for each shape the SHELL verb
 * (cattle-drover/libexec/drover-home) and this node port run over the SAME tree
 * with the SAME environment, and their stdout, stderr and exit code are
 * compared byte for byte. Every read subcommand and every argument error is in
 * that comparison.
 *
 * AND THE SAFETY PROPERTY, ASSERTED DIRECTLY. `migrate` and `rollback` move
 * Clay's real home and have never been run there; the whole reason this port is
 * scoped to `status` and `plan` is that a rewrite must not be what performs
 * that move the first time. So every node run in this file is bracketed by a
 * recursive listing of the fixture — type, symlink target, sha256 of every file
 * — and the listing after must equal the listing before. A read verb that moved
 * a file fails here rather than on Clay's machine.
 *
 * Nothing here runs a migration, in either language: no test invokes the shell
 * verb with migrate, verify or rollback, and the node verb refuses all three.
 * Every path is inside a mkdtemp.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { type Dirent, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
    HOME_WRITE_STAYS_IN_SHELL,
    type HomeCtx,
    type HomeProbe,
    blockedStates,
    defaultHomeProbe,
    homeCanon,
    homeIsReal,
    homeMoverState,
    homeMovers,
    homeRealHome,
    homeStayers,
    homeTilde,
    homeWriters,
    moverStates,
    run,
    summary,
    writeSubcommands,
    writersFromLsof,
} from './home';
import { droverVerbs } from './index';

/**
 * A throwaway HAPPY_HOME_DIR, pinned above every import (DROVE-336).
 *
 * A bench that did not set it once registered seventy-eight real sessions on
 * Clay's phone, because an unknown word taken to the fork's entry reaches
 * Claude and Claude registers. This verb never goes near ~/.happy — it reads
 * directory shapes and prints them — but it does spawn a shell, and a spawn
 * from this tree is exactly what leaked. This says no.
 */
const { happyHome, realHappyHome } = await vi.hoisted(async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const realHappyHome = path.join(os.homedir(), '.happy');
    const happyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'home-happy-'));
    process.env.HAPPY_HOME_DIR = happyHome;
    process.env.HAPPY_SERVER_URL = 'http://127.0.0.1:1';
    return { happyHome, realHappyHome };
});

vi.mock('../../configuration', () => {
    throw new Error('home.test: configuration was imported; this verb must not reach the session machinery');
});
vi.mock('../../api/api', () => {
    throw new Error('home.test: api/api was imported; this verb must not reach the session machinery');
});

type Env = Record<string, string | undefined>;

function happyHomeOf(env: Env): string {
    const raw = env.HAPPY_HOME_DIR;
    return raw ? resolve(raw.replace(/^~/, homedir())) : resolve(realHappyHome);
}

/** Refuse an environment whose HAPPY_HOME_DIR is the real one. Thrown, so it fails the file. */
function refuseRealHappyHome(env: Env, where: string): void {
    if (happyHomeOf(env) === resolve(realHappyHome)) {
        throw new Error(
            `${where}: HAPPY_HOME_DIR resolves to the real ${realHappyHome} (it is ${env.HAPPY_HOME_DIR ?? 'unset'}). Refusing.`,
        );
    }
}

beforeAll(() => {
    refuseRealHappyHome(process.env, 'home.test');
});

afterAll(() => {
    refuseRealHappyHome(process.env, 'home.test (afterAll)');
    expect(existsSync(happyHome) ? readdirSync(happyHome) : []).toEqual([]);
    rmSync(happyHome, { recursive: true, force: true });
    for (const f of fixtures) rmSync(f, { recursive: true, force: true });
});

// --- the shell verb under test ------------------------------------------------

const realRoot = process.env.DROVER_DIR || join(homedir(), 'Projects', 'bitspur', 'cattle-drover');
const shellVerb = join(realRoot, 'libexec', 'drover-home');
const haveShell = existsSync(shellVerb) && existsSync(join(realRoot, 'lib', 'drover-home.sh'));

// --- fixtures -----------------------------------------------------------------

const fixtures: string[] = [];

function seed(path: string, body: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${body}\n`);
}

/** The four harness-owned stayers, plus the cross-tree link into a mover. */
function seedStayers(fix: string): void {
    seed(join(fix, '.claude', 'settings.json'), '{"stays":true}');
    seed(join(fix, '.claude', 'todos', 't.json'), '[]');
    seed(join(fix, '.claude.json'), '{"global":true}');
    seed(join(fix, '.cursor', 'mcp.json'), '{"cursor":true}');
    seed(join(fix, '.codex', 'config.toml'), 'model = "x"');
}

function newFixture(name: string): string {
    const fix = mkdtempSync(join(tmpdir(), `home-${name}-`));
    fixtures.push(fix);
    seed(join(fix, 'accounts.json'), '[{ "name": "one", "configDir": "~/.claude-accounts/account-1" }]');
    return fix;
}

/** Nothing drover owns exists yet: every mover absent, the summary `fresh`. */
function freshTree(): string {
    const fix = newFixture('fresh');
    seedStayers(fix);
    return fix;
}

/** All six movers are real directories at their old paths: `legacy (6 to move)`. */
function legacyTree(): string {
    const fix = newFixture('legacy');
    seedStayers(fix);
    seed(join(fix, '.happy', 'access.key'), 'ACCESSKEYBYTES');
    seed(join(fix, '.happy', 'sessions.json'), '{"sessions":[{"id":"s1"}]}');
    seed(join(fix, '.shotgun', 'mcp.json'), '{"mcpServers":{}}');
    seed(join(fix, '.shotgun', '.git', 'HEAD'), 'ref: refs/heads/main');
    for (const a of ['account-1', 'account-2', 'alt']) {
        seed(join(fix, '.claude-accounts', a, '.claude.json'), `{"account":"${a}"}`);
    }
    seed(join(fix, '.claude-shared', 'projects', 'proj-a', 'session.jsonl'), '{"e":1}');
    symlinkSync(join(fix, '.claude-shared', 'projects'), join(fix, '.claude', 'projects'));
    seed(join(fix, '.rulesync', 'mcp.json'), '{"from":"shotgun"}');
    seed(join(fix, '.local', 'state', 'cattle-drover', 'events.jsonl'), '{"pending":true}');
    return fix;
}

/**
 * What the tree looks like after a migration: the bytes under ~/.drover, a
 * compat symlink at every old path, and a migration record with a `latest`.
 * Built by hand — this file never runs a migration to get here.
 */
function migratedTree(): string {
    const fix = newFixture('migrated');
    seedStayers(fix);
    const drover = join(fix, '.drover');
    const pairs: [string, string][] = [
        [join(fix, '.happy'), join(drover, 'happy')],
        [join(fix, '.shotgun'), join(drover, 'shotgun')],
        [join(fix, '.claude-accounts'), join(drover, 'claude-accounts')],
        [join(fix, '.claude-shared'), join(drover, 'claude-shared')],
        [join(fix, '.rulesync'), join(drover, 'rulesync')],
        [join(fix, '.local', 'state', 'cattle-drover'), join(drover, 'state')],
    ];
    for (const [old, next] of pairs) {
        seed(join(next, 'payload'), `bytes for ${next}`);
        mkdirSync(dirname(old), { recursive: true });
        symlinkSync(next, old);
    }
    const snap = join(drover, 'migrate', '20260901T101112Z');
    seed(join(snap, 'status'), 'verified');
    symlinkSync(snap, join(drover, 'migrate', 'latest'));
    return fix;
}

/**
 * The tree a status/plan reader earns its keep on: one of every state at once.
 * happy migrated, shotgun legacy, claude-accounts a conflict, claude-shared a
 * foreign link, rulesync absent, state new-only — plus a migration record whose
 * status says the last run failed.
 */
function halfTree(): string {
    const fix = newFixture('half');
    seedStayers(fix);
    const drover = join(fix, '.drover');

    seed(join(drover, 'happy', 'access.key'), 'ACCESSKEYBYTES');
    symlinkSync(join(drover, 'happy'), join(fix, '.happy'));

    seed(join(fix, '.shotgun', 'mcp.json'), '{"mcpServers":{}}');

    seed(join(fix, '.claude-accounts', 'account-1', '.claude.json'), '{"account":"account-1"}');
    seed(join(drover, 'claude-accounts', 'account-1', '.claude.json'), '{"account":"account-1"}');

    seed(join(fix, 'elsewhere', 'shared', 'keep'), 'not ours');
    symlinkSync(join(fix, 'elsewhere', 'shared'), join(fix, '.claude-shared'));

    seed(join(drover, 'state', 'events.jsonl'), '{"pending":true}');

    const snap = join(drover, 'migrate', '20260901T090807Z');
    seed(join(snap, 'status'), 'verify-failed');
    symlinkSync(snap, join(drover, 'migrate', 'latest'));
    return fix;
}

// --- the safety property ------------------------------------------------------

/** Type, symlink target and sha256 of every file under a tree, sorted. */
function treeListing(root: string): string {
    const out: string[] = [];
    const walk = (dir: string, rel: string): void => {
        let entries: Dirent[];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
            const p = join(dir, e.name);
            const r = rel === '' ? e.name : `${rel}/${e.name}`;
            if (e.isSymbolicLink()) {
                out.push(`L ${r} -> ${readlinkSync(p)}`);
            } else if (e.isDirectory()) {
                out.push(`D ${r}`);
                walk(p, r);
            } else {
                out.push(`F ${r} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
            }
        }
    };
    walk(root, '');
    return out.join('\n');
}

// --- environments and runners -------------------------------------------------

function fixtureEnv(fix: string, extra: Env = {}): Env {
    return {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        HOME: fix,
        HAPPY_HOME_DIR: process.env.HAPPY_HOME_DIR,
        DROVER_HOME: join(fix, '.drover'),
        DROVER_ACCOUNTS: join(fix, 'accounts.json'),
        DROVER_HOME_WRITERS_PROBE: 'true',
        ...extra,
    };
}

function definedOnly(env: Env): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
    return out;
}

/**
 * The probe the tests hand in. `du` and the suite's own writers command are the
 * real ones — they are what the shell arm runs too, on the same fixture. Every
 * member that would reach Clay's actual machine THROWS, so a read path that
 * asked lsof or launchctl anything fails the test instead of measuring the box.
 */
function fenceProbe(env: Env): HomeProbe {
    const real = defaultHomeProbe(env);
    const refuse = (what: string) => (): never => {
        throw new Error(`home.test: the verb probed ${what}; a status/plan read must not reach the real machine`);
    };
    return {
        duSh: (p: string) => real.duSh(p),
        writersProbe: (c: string) => real.writersProbe(c),
        launchctlPresent: refuse('launchctl'),
        launchctlLoaded: refuse('launchctl print'),
        lsofPresent: refuse('lsof'),
        lsof: refuse('lsof'),
    };
}

function nodeCtx(env: Env, fix: string): HomeCtx {
    return { env, home: fix, realHome: homeRealHome(process.env, homedir()), probe: fenceProbe(env) };
}

interface Captured {
    code: number;
    out: string;
    err: string;
}

/** The node verb, in process, with the fixture tree pinned before and after. */
async function node(args: string[], env: Env, fix: string): Promise<Captured> {
    refuseRealHappyHome(process.env, 'the node run');
    const before = treeListing(fix);
    const out: string[] = [];
    const err: string[] = [];
    const so = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => (out.push(String(c)), true));
    const se = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => (err.push(String(c)), true));
    let code: number;
    try {
        code = await run(args, nodeCtx(env, fix));
    } finally {
        so.mockRestore();
        se.mockRestore();
    }
    // The whole reason this port stops at the read verbs.
    expect(treeListing(fix), `the node verb changed the fixture running: home ${args.join(' ')}`).toBe(before);
    return { code, out: out.join(''), err: err.join('') };
}

/** The shell verb, spawned on the same tree with the same environment. */
function shell(args: string[], env: Env): Captured {
    refuseRealHappyHome(env, 'the shell spawn');
    for (const a of args) {
        if (writeSubcommands.includes(a)) throw new Error(`home.test: refusing to spawn the shell verb with '${a}'`);
    }
    const r = spawnSync(shellVerb, args, { env: definedOnly(env), encoding: 'utf8' });
    return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/** Every read invocation the two arms must agree on, byte for byte. */
const readInvocations: string[][] = [
    [],
    ['status'],
    ['plan'],
    ['--help'],
    ['-h'],
    ['help'],
    ['status', 'ignored-extra'],
    ['nope'],
    ['--nope'],
    ['Status'],
];

// --- the differential ---------------------------------------------------------

describe.skipIf(!haveShell)('drover home — byte for byte against libexec/drover-home', () => {
    const shapes: [string, () => string][] = [
        ['a fresh machine', freshTree],
        ['an all-legacy tree', legacyTree],
        ['a migrated tree', migratedTree],
        ['a half-migrated tree, every blocked state at once', halfTree],
    ];

    for (const [what, build] of shapes) {
        it(`agrees on ${what}`, async () => {
            const fix = build();
            const env = fixtureEnv(fix);
            for (const args of readInvocations) {
                const s = shell(args, env);
                const n = await node(args, env, fix);
                const where = `${what}: home ${args.join(' ')}`;
                expect(n.out, where).toBe(s.out);
                expect(n.err, where).toBe(s.err);
                expect(n.code, where).toBe(s.code);
            }
        });
    }

    it('agrees when a writer holds a mover open, on the count and on the plan block', async () => {
        const fix = legacyTree();
        const probe = `printf '4242\\tnode\\t${join(fix, '.happy', 'sessions.json')}\\n5150\\tclaude\\t${join(fix, '.shotgun', 'mcp.json')}\\n'`;
        const env = fixtureEnv(fix, { DROVER_HOME_WRITERS_PROBE: probe });
        for (const args of [['status'], ['plan']]) {
            const s = shell(args, env);
            const n = await node(args, env, fix);
            expect(n.out, args.join(' ')).toBe(s.out);
            expect(n.err, args.join(' ')).toBe(s.err);
            expect(n.code, args.join(' ')).toBe(s.code);
        }
        // Not a tautology of two empty answers.
        const n = await node(['status'], env, fix);
        expect(n.out).toContain('  writers            2 open (drover home plan lists them)');
        const p = await node(['plan'], env, fix);
        expect(p.out).toContain('  4242     node                     ');
        expect(p.out).toContain('  5150     claude                   ');
    });

    it('agrees when STATE_DIR was inherited from a pre-move shell', async () => {
        // bin/drover exports STATE_DIR into every session it starts, so a shell
        // inside one carries the pre-move spelling after the move has happened.
        const fix = halfTree();
        const env = fixtureEnv(fix, { STATE_DIR: join(fix, '.local', 'state', 'cattle-drover') });
        const s = shell(['status'], env);
        const n = await node(['status'], env, fix);
        expect(n.out).toBe(s.out);
        expect(n.err).toBe(s.err);
        expect(n.code).toBe(s.code);
        expect(n.out).toContain('(inherited from this shell; a fresh shell resolves ~/.drover/state)');
    });
});

// --- what the agreement is an agreement ABOUT ---------------------------------

describe.skipIf(!haveShell)('drover home — the sentences that must really be there', () => {
    it('status names every mover, the summary, the env it resolves, writers and the last run', async () => {
        const fix = legacyTree();
        const env = fixtureEnv(fix);
        const n = await node(['status'], env, fix);
        expect(n.code).toBe(0);
        expect(n.out).toContain('legacy (6 to move)');
        for (const tag of ['happy', 'shotgun', 'claude-accounts', 'claude-shared', 'rulesync', 'state']) {
            expect(n.out, tag).toMatch(new RegExp(`^  ${tag} +legacy +`, 'm'));
        }
        expect(n.out).toContain('  STATE_DIR          ~/.local/state/cattle-drover');
        expect(n.out).toContain('  DROVER_HAPPY_HOME  ~/.happy');
        expect(n.out).toContain('  writers            none (a move could run now)');
        expect(n.out).toContain('  last run           none');
        expect(existsSync(join(fix, '.drover'))).toBe(false);
    });

    it('status on the half tree names each state, the BLOCKED block and the failed run', async () => {
        const fix = halfTree();
        const n = await node(['status'], fixtureEnv(fix), fix);
        expect(n.out).toContain('partial (1 of 5 migrated)');
        expect(n.out).toMatch(/^  happy +migrated /m);
        expect(n.out).toMatch(/^  shotgun +legacy /m);
        expect(n.out).toMatch(/^  claude-accounts +conflict /m);
        expect(n.out).toMatch(/^  claude-shared +foreign-link /m);
        expect(n.out).toMatch(/^  rulesync +absent /m);
        expect(n.out).toMatch(/^  state +new-only /m);
        expect(n.out).toContain('  BLOCKED: a move cannot touch these until they are sorted by hand:');
        expect(n.out).toContain('    claude-accounts is conflict (');
        expect(n.out).toContain('  last run           20260901T090807Z verify-failed');
    });

    it('plan names the moves with their sizes, the stayers, the gates and the sequence', async () => {
        const fix = legacyTree();
        const n = await node(['plan'], fixtureEnv(fix), fix);
        expect(n.code).toBe(0);
        expect(n.out).toContain('drover home plan — what `drover home migrate` would do. Nothing is touched.');
        expect(n.out).toMatch(/^ {2}~\/\.happy {23}\s+\S+ {2}-> ~\/\.drover\/happy$/m);
        expect(n.out).toContain('-> ~/.drover/state');
        expect(n.out).toContain('NEVER MOVED  ~/.claude  ~/.claude.json  ~/.cursor  ~/.codex  ');
        expect(n.out).toContain('  (Keychain and auth probes run only on the login user\'s real home)');
        expect(n.out).toContain('  none');
        expect(n.out).toContain('  1. make unlaunchd');
        expect(n.out).toContain('  3. DROVER_MIGRATE_ALLOW=1 drover home migrate');
        expect(n.out).toContain('STATE_DIR=~/.drover/state and bootstrap');
        expect(n.out).toContain('rollback at any point:  make unlaunchd; DROVER_MIGRATE_ALLOW=1 drover home rollback');
    });

    it('plan on the migrated tree says (already), and on the half tree says BLOCKED and (absent, skipped)', async () => {
        const migrated = migratedTree();
        const m = await node(['plan'], fixtureEnv(migrated), migrated);
        expect(m.out).toContain('~/.drover/happy (already)');
        const half = halfTree();
        const h = await node(['plan'], fixtureEnv(half), half);
        expect(h.out).toContain('BLOCKED: conflict');
        expect(h.out).toContain('BLOCKED: foreign-link');
        expect(h.out).toContain('BLOCKED: new-only');
        expect(h.out).toContain('(absent, skipped)');
    });

    it('--help is the shell heredoc, on stdout, exit 0', async () => {
        const fix = freshTree();
        const n = await node(['--help'], fixtureEnv(fix), fix);
        expect(n.code).toBe(0);
        expect(n.err).toBe('');
        expect(n.out.startsWith('drover home — one ~/.drover for everything drover owns.\n')).toBe(true);
        expect(n.out).toContain('  ~/.claude-accounts             -> ~/.drover/claude-accounts   (symlink is permanent: the');
        expect(n.out).toContain('  DROVER_HOME_WRITERS_PROBE    a command whose stdout replaces the writer scan');
        expect(n.out).toContain('See docs/drover-home-migration.md for the runbook and the hazards.\n');
    });

    it('an unknown subcommand is 2, by name, on stderr', async () => {
        const fix = freshTree();
        const n = await node(['nope'], fixtureEnv(fix), fix);
        expect(n.code).toBe(2);
        expect(n.out).toBe('');
        expect(n.err).toBe("drover home: unknown subcommand 'nope' (status, plan, migrate, verify, rollback; --help)\n");
    });
});

// --- the write half, which is not here ----------------------------------------

describe('drover home — migrate, verify and rollback stay in POSIX sh', () => {
    it('refuses each of them, says where the work lives, and moves nothing', async () => {
        const fix = halfTree();
        const env = fixtureEnv(fix);
        for (const sub of writeSubcommands) {
            const n = await node([sub], env, fix);
            expect(n.code, sub).toBe(HOME_WRITE_STAYS_IN_SHELL);
            expect(n.out, sub).toBe('');
            expect(n.err, sub).toContain(`drover home: ${sub} is not in the node port`);
            expect(n.err, sub).toContain('cattle-drover/libexec/drover-home');
        }
        // node() has already compared the tree before and after each run; this
        // says the same thing in the shape a reader will look for.
        expect(existsSync(join(fix, '.shotgun', 'mcp.json'))).toBe(true);
        expect(existsSync(join(fix, '.drover', 'shotgun'))).toBe(false);
        expect(readlinkSync(join(fix, '.happy'))).toBe(join(fix, '.drover', 'happy'));
    });

    it('--no-rollback is not a flag this port knows, because migrate is not here', async () => {
        const fix = freshTree();
        const n = await node(['migrate', '--no-rollback'], fixtureEnv(fix), fix);
        expect(n.code).toBe(HOME_WRITE_STAYS_IN_SHELL);
        expect(n.err).toContain('migrate is not in the node port');
    });
});

// --- the pin itself -----------------------------------------------------------

describe('drover home — the unchanged-tree assertion is worth something', () => {
    it('notices a rewritten file, a new file, a deletion and a relink', () => {
        const fix = freshTree();
        const before = treeListing(fix);
        expect(before).toContain('F .claude.json ');

        writeFileSync(join(fix, '.claude.json'), '{"global":false}\n');
        expect(treeListing(fix)).not.toBe(before);
        writeFileSync(join(fix, '.claude.json'), '{"global":true}\n');
        expect(treeListing(fix)).toBe(before);

        writeFileSync(join(fix, '.cursor', 'new-file'), 'x\n');
        expect(treeListing(fix)).not.toBe(before);
        rmSync(join(fix, '.cursor', 'new-file'));
        expect(treeListing(fix)).toBe(before);

        rmSync(join(fix, '.codex'), { recursive: true });
        expect(treeListing(fix)).not.toBe(before);
        seed(join(fix, '.codex', 'config.toml'), 'model = "x"');
        expect(treeListing(fix)).toBe(before);

        // A relink is what a migration does, and it is the one a listing that
        // followed symlinks would miss entirely.
        symlinkSync(join(fix, '.claude'), join(fix, '.link'));
        const withLink = treeListing(fix);
        expect(withLink).toContain(`L .link -> ${join(fix, '.claude')}`);
        rmSync(join(fix, '.link'));
        symlinkSync(join(fix, '.cursor'), join(fix, '.link'));
        expect(treeListing(fix)).not.toBe(withLink);
    });
});

// --- the probe fence ----------------------------------------------------------

describe('drover home — the machine sits behind one probe', () => {
    it('the writer scan reaches lsof only through the probe, so a double can refuse it', () => {
        const fix = freshTree();
        // No DROVER_HOME_WRITERS_PROBE: the real scan. On a fixture home the
        // launchd branch is skipped (it is not the login user's home), so lsof
        // is the first thing asked, and the double says no.
        const env = fixtureEnv(fix, { DROVER_HOME_WRITERS_PROBE: undefined });
        expect(() => homeWriters(nodeCtx(env, fix))).toThrow(/probed lsof/);
    });

    it('the injected probe replaces the whole scan, exactly as the shell says it does', () => {
        const fix = freshTree();
        const env = fixtureEnv(fix, { DROVER_HOME_WRITERS_PROBE: "printf '1\\tsh\\t/x\\n'" });
        expect(homeWriters(nodeCtx(env, fix))).toBe('1\tsh\t/x\n');
    });

    it('the lsof filter matches a mover exactly and by prefix, and nothing else', () => {
        const stream = 'p1\ncnode\nn/h/.happy\nn/h/.happyish/x\nn/h/.happy/logs/a\np2\nccode\nn/elsewhere\n';
        expect(writersFromLsof(stream, ['/h/.happy'])).toBe('1\tnode\t/h/.happy\n1\tnode\t/h/.happy/logs/a\n');
        expect(writersFromLsof(stream, [''])).toBe('');
    });
});

// --- the pieces, one to one with lib/drover-home.sh ---------------------------

describe('drover home — the engine helpers, transcribed', () => {
    it('home_movers is the six pairs, in the shell order, tagged by basename', () => {
        const m = homeMovers('/h', '/h/.drover');
        expect(m.map((x) => `${x.old}|${x.next}`)).toEqual([
            '/h/.happy|/h/.drover/happy',
            '/h/.shotgun|/h/.drover/shotgun',
            '/h/.claude-accounts|/h/.drover/claude-accounts',
            '/h/.claude-shared|/h/.drover/claude-shared',
            '/h/.rulesync|/h/.drover/rulesync',
            '/h/.local/state/cattle-drover|/h/.drover/state',
        ]);
        expect(m.map((x) => x.tag)).toEqual(['happy', 'shotgun', 'claude-accounts', 'claude-shared', 'rulesync', 'state']);
    });

    it('home_stayers is the four the harnesses read themselves', () => {
        expect(homeStayers('/h')).toEqual(['/h/.claude', '/h/.claude.json', '/h/.cursor', '/h/.codex']);
    });

    it('home_tilde is ~ for the home itself, ~/x under it, verbatim elsewhere', () => {
        expect(homeTilde('/h', '/h')).toBe('~');
        expect(homeTilde('/h/.happy', '/h')).toBe('~/.happy');
        expect(homeTilde('/other/x', '/h')).toBe('/other/x');
        // Not a prefix match on the string: /home2 is not under /h.
        expect(homeTilde('/h2/.happy', '/h')).toBe('/h2/.happy');
    });

    it('home_mover_state names all six states', () => {
        const fix = halfTree();
        const d = join(fix, '.drover');
        expect(homeMoverState(join(fix, '.happy'), join(d, 'happy'))).toBe('migrated');
        expect(homeMoverState(join(fix, '.shotgun'), join(d, 'shotgun'))).toBe('legacy');
        expect(homeMoverState(join(fix, '.claude-accounts'), join(d, 'claude-accounts'))).toBe('conflict');
        expect(homeMoverState(join(fix, '.claude-shared'), join(d, 'claude-shared'))).toBe('foreign-link');
        expect(homeMoverState(join(fix, '.rulesync'), join(d, 'rulesync'))).toBe('absent');
        expect(homeMoverState(join(fix, '.local', 'state', 'cattle-drover'), join(d, 'state'))).toBe('new-only');
    });

    it('summary counts absent out of the total, so a fresh machine is `fresh`', () => {
        const fresh = freshTree();
        expect(summary(moverStates(nodeCtx(fixtureEnv(fresh), fresh)))).toBe('fresh');
        const legacy = legacyTree();
        expect(summary(moverStates(nodeCtx(fixtureEnv(legacy), legacy)))).toBe('legacy (6 to move)');
        const migrated = migratedTree();
        expect(summary(moverStates(nodeCtx(fixtureEnv(migrated), migrated)))).toBe('migrated (6 of 6)');
        const half = halfTree();
        const states = moverStates(nodeCtx(fixtureEnv(half), half));
        expect(summary(states)).toBe('partial (1 of 5 migrated)');
        expect(blockedStates(states).map((s) => `${s.tag}:${s.state}`))
            .toEqual(['claude-accounts:conflict', 'claude-shared:foreign-link', 'state:new-only']);
    });

    it('home_is_real is false for a fixture home and true for the login user\'s own', () => {
        const fix = freshTree();
        const real = homeRealHome(process.env, homedir());
        expect(homeIsReal(fix, real)).toBe(false);
        expect(homeIsReal(real, real)).toBe(true);
        // And it compares canonical paths: macOS spells a temp dir two ways.
        expect(homeIsReal(fix, homeCanon(fix))).toBe(true);
    });
});

describe('the verb table', () => {
    it('carries home, lazily', () => {
        const row = droverVerbs.find((v) => v.name === 'home');
        expect(row).toBeDefined();
        expect(row?.summary).toContain('~/.drover');
        expect(row?.summary).toContain('stay in libexec/drover-home');
    });
});
