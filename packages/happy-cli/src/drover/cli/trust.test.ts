/**
 * `drover trust` in node, measured against libexec/drover-trust (DROVE-315).
 *
 * THE GATE IS THE DIFFERENTIAL. Every case below builds the SAME fixture estate
 * twice — a fake $HOME, a state dir, a work tree, a registry — runs cattle-
 * drover's shell file over one copy and the node verb over the other, and
 * compares stdout, stderr, the exit code AND every resulting file. Not "similar
 * output": the same bytes in the same files with the same modes.
 *
 * TWO FIELDS ARE NORMALIZED, and only two, both clocks:
 *   - a backup's name carries `date -u +%Y%m%dT%H%M%SZ`, so two runs a second
 *     apart file the same copy under two names;
 *   - the stamp records each file's mtime, and the two arms wrote their own
 *     copies of the estate at different instants.
 * Everything else in the stamp — the header, every want and seen line, and each
 * file's SIZE, MODE and symlink target — is compared exactly, and the stamps are
 * then proved interoperable the only way that counts: the shell takes its
 * one-stat fast exit on a stamp node wrote, and node takes it on a stamp the
 * shell wrote.
 *
 * THIS IS A SECURITY VERB, so two of its properties are asserted rather than
 * assumed: it never prints anything it read out of a config (a seeded OAuth
 * address and access token must appear in no byte of stdout or stderr), and it
 * runs no subprocess at all — the probe handed in THROWS, and the module's own
 * source is read back and asserted to name no process API.
 *
 * WHAT THE SHELL DOES NOT HAVE, pinned so a future reader does not add it: no
 * `--json`, no revoke, and no argument table. `-f`/`--force` is the only flag;
 * every other word is the directory to trust, so an unknown argument is not an
 * error and exits 0 like everything else. The verb NEVER blocks a session.
 */

import { spawnSync } from 'node:child_process';
import {
    chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
    readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A throwaway HAPPY_HOME_DIR, pinned above every import (DROVE-336).
 *
 * A bench that did not set it once registered seventy-eight real sessions on
 * Clay's phone, because the fork's entry takes an unknown word to Claude and
 * Claude registers. This verb never reaches ~/.happy and this file never spawns
 * the entry; the pin is here because the leak came from this tree and nothing
 * in it said no.
 */
const { happyHome, realHappyHome } = await vi.hoisted(async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const realHappyHome = path.join(os.homedir(), '.happy');
    const happyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-happy-'));
    process.env.HAPPY_HOME_DIR = happyHome;
    process.env.HAPPY_SERVER_URL = 'http://127.0.0.1:1';
    return { happyHome, realHappyHome };
});

vi.mock('../../configuration', () => {
    throw new Error('trust.test: configuration was imported; this verb must not reach the session machinery');
});
vi.mock('../../api/api', () => {
    throw new Error('trust.test: api/api was imported; this verb must not reach the session machinery');
});

import { detectStatFmt, realTrustProbe, registryConfigDirs, run, statLine, trustedKeysOf, verifyConfig, type TrustProbe } from './trust';
import { droverVerbs } from './index';

type Env = Record<string, string | undefined>;

function happyHomeOf(env: Env): string {
    const raw = env.HAPPY_HOME_DIR;
    return raw ? raw.replace(/^~/, homedir()) : realHappyHome;
}

/** Refuse an environment whose HAPPY_HOME_DIR is the real one. Thrown, so it fails the file. */
function refuseRealHappyHome(env: Env, where: string): void {
    if (happyHomeOf(env) === realHappyHome) {
        throw new Error(
            `${where}: HAPPY_HOME_DIR resolves to the real ${realHappyHome} (it is ${env.HAPPY_HOME_DIR ?? 'unset'}). Refusing.`,
        );
    }
}

const REGISTRATION_FILES = ['access.key', 'daemon.state.json', 'daemon.state.json.lock', 'sessions.json', 'settings.json'];

beforeAll(() => {
    refuseRealHappyHome(process.env, 'trust.test');
});

afterAll(() => {
    refuseRealHappyHome(process.env, 'trust.test (afterAll)');
    expect(existsSync(happyHome) ? readdirSync(happyHome).filter((f) => REGISTRATION_FILES.includes(f)) : []).toEqual([]);
    expect(existsSync(happyHome) ? readdirSync(happyHome) : []).toEqual([]);
    rmSync(happyHome, { recursive: true, force: true });
});

// --- the shell arm ------------------------------------------------------------

const realRoot = join(homedir(), 'Projects', 'bitspur', 'cattle-drover');
const shellVerb = join(realRoot, 'libexec', 'drover-trust');
const haveTree = existsSync(shellVerb);

/**
 * jq, pinned to the real binary while the CWD is still this repo.
 *
 * asdf resolves a tool by walking UP from the CWD for a .tool-versions, and
 * every spawn below runs with its cwd inside a tmpdir — where the shim finds
 * nothing, drover-trust takes its `command -v jq` bail-out, writes nothing, and
 * every "the estates agree" assertion would pass for the wrong reason. The same
 * pin tests/trust.bats carries, for the same reason.
 */
const jqDir = (() => {
    const asdf = spawnSync('asdf', ['which', 'jq'], { encoding: 'utf8' });
    const p = (asdf.status === 0 ? asdf.stdout : spawnSync('sh', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout).trim();
    return p ? dirname(p) : '';
})();
const haveJq = jqDir !== '' && existsSync(join(jqDir, 'jq'));

/** A probe whose every member throws: a path that reached for the machine fails the test. */
const throwingProbe: TrustProbe = {
    spawn(command: string) {
        throw new Error(`trust.test: the verb spawned ${command}; it must run no subprocess`);
    },
};

// --- the fixture estate -------------------------------------------------------

interface Estate {
    root: string;
    home: string;
    state: string;
    work: string;
    reg: string;
    env: Env;
}

let roots: string[] = [];

/**
 * The shape tests/trust.bats builds: a fake home, a state dir that is NOT under
 * it (which is what sends the backups to $HOME/.local/state, and is the thing
 * the shell's backup-dir rule exists for), a work tree and a registry.
 */
function estate(seed?: (e: Estate) => void): Estate {
    const root = mkdtempSync(join(tmpdir(), 'drover-trust-test-'));
    roots.push(root);
    const e: Estate = {
        root,
        home: join(root, 'home'),
        state: join(root, 'state'),
        work: join(root, 'work'),
        reg: join(root, 'accounts.json'),
        env: {},
    };
    mkdirSync(join(e.home, '.claude'), { recursive: true });
    mkdirSync(e.work, { recursive: true });
    // No registry by default: the ambient pair alone is enough for most of
    // these, and an empty file is not valid JSON.
    writeFileSync(e.reg, '[]\n');
    e.env = {
        PATH: `${jqDir}:${process.env.PATH ?? ''}`,
        HOME: e.home,
        TMPDIR: join(root, 'tmp'),
        STATE_DIR: e.state,
        DROVER_ACCOUNTS: e.reg,
        DROVER_DIR: realRoot,
        DROVER_URL: 'http://127.0.0.1:1',
        HAPPY_HOME_DIR: happyHome,
        HAPPY_SERVER_URL: 'http://127.0.0.1:1',
        // The node arm sorts by code unit, which is `LC_ALL=C sort`. Pinned on
        // both arms so the union's ORDER is comparable as well as its content.
        LC_ALL: 'C',
    };
    mkdirSync(e.env.TMPDIR!, { recursive: true });
    seed?.(e);
    return e;
}

afterEach(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
    roots = [];
});

/** Two estates seeded identically: one for the shell, one for node. */
function pair(seed?: (e: Estate) => void): [Estate, Estate] {
    return [estate(seed), estate(seed)];
}

interface Ran {
    code: number | null;
    out: string;
    err: string;
}

function shell(e: Estate, args: string[], cwd?: string): Ran {
    refuseRealHappyHome(e.env, 'the shell verb spawn');
    const r = spawnSync(shellVerb, args, {
        env: e.env as NodeJS.ProcessEnv,
        cwd: cwd ?? realpathSync(e.work),
        encoding: 'utf8',
    });
    return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

async function node(e: Estate, args: string[], cwd?: string): Promise<Ran> {
    refuseRealHappyHome(e.env, 'the node verb run');
    refuseRealHappyHome(process.env, 'the node verb run (ambient)');
    const out: string[] = [];
    const err: string[] = [];
    const so = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => (out.push(String(c)), true));
    const se = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => (err.push(String(c)), true));
    try {
        const code = await run(args, {
            env: e.env,
            home: e.home,
            cwd: cwd ?? realpathSync(e.work),
            probe: throwingProbe,
        });
        return { code, out: out.join(''), err: err.join('') };
    } finally {
        so.mockRestore();
        se.mockRestore();
    }
}

// --- comparing two estates ----------------------------------------------------

const backupStamp = /\.\d{8}T\d{6}Z(-\d+)?\.bak$/;

/**
 * A backup's name carries a UTC second, so two runs a second apart file the
 * same copy under two names — and it carries the FLATTENED absolute path of the
 * file it copied, which is each estate's own mkdtemp root. Both are replaced;
 * everything else in the name, including which file it is a copy of, stands.
 */
function normalizeName(rel: string, flat: string[]): string {
    let out = rel.replace(backupStamp, '.<STAMP>.bak');
    for (const f of flat) out = out.split(f).join('<ROOT>');
    return out;
}

/**
 * The stamp's mtime column, blanked. The two arms wrote their own copies of the
 * estate at different instants; the SIZE, MODE and link target of every line,
 * and every header/want/seen line, are compared as they are.
 */
function normalizeStamp(text: string): string {
    return text.split('\n').map((line) => {
        if (!line.startsWith('/')) return line;
        const f = line.split('\t');
        if (f.length < 3) return line;
        f[1] = '<mtime>';
        return f.join('\t');
    }).join('\n');
}

interface FileShot {
    mode: number;
    body: string;
}

/** `drover_config_backup_name`: the leading slash gone, every other slash a dash. */
function flatten(path: string): string {
    return path.replace(/^\//, '').split('/').join('-');
}

/** Every file under a root, keyed by its path relative to the root. */
function shoot(root: string, home: string, state: string): Map<string, FileShot> {
    const out = new Map<string, FileShot>();
    // The estate's own absolute paths, in both spellings macOS gives them
    // (/var and /private/var), so a path is comparable between the two copies.
    const real = realpathSync(root);
    const roots = real === root ? [root] : [real, root];
    const flat = roots.map(flatten);
    const walk = (dir: string): void => {
        let entries: string[];
        try {
            entries = readdirSync(dir);
        } catch {
            return;
        }
        for (const name of entries.sort()) {
            const p = join(dir, name);
            const st = lstatSync(p);
            if (st.isDirectory()) {
                walk(p);
                continue;
            }
            const rel = normalizeName(relative(root, p), flat);
            let body: string;
            try {
                body = readFileSync(p, 'utf8');
            } catch {
                body = '<unreadable>';
            }
            if (rel.endsWith('trust.stamp')) body = normalizeStamp(body);
            for (const r of roots) body = body.split(r).join('<ROOT>');
            for (const f of flat) body = body.split(f).join('<ROOT>');
            body = body.split(home).join('$HOME').split(state).join('$STATE');
            out.set(rel, { mode: st.mode & 0o777, body });
        }
    };
    walk(root);
    return out;
}

function shotOf(e: Estate): Map<string, FileShot> {
    return shoot(e.root, e.home, e.state);
}

/** Run both arms on identically seeded estates and assert they agree on everything. */
async function agree(
    seed: ((e: Estate) => void) | undefined,
    args: string[],
    what: string,
    tweak?: (e: Estate) => void,
): Promise<{ s: Ran; n: Ran; se: Estate; ne: Estate }> {
    const [se, ne] = pair(seed);
    tweak?.(se);
    tweak?.(ne);
    const s = shell(se, args);
    const n = await node(ne, args);
    expect(n.code, `${what}: exit code`).toBe(s.code);
    expect(n.out, `${what}: stdout`).toBe(s.out);
    expect(n.err, `${what}: stderr`).toBe(s.err);
    const sh = shotOf(se);
    const nh = shotOf(ne);
    expect([...nh.keys()].sort(), `${what}: the files that exist`).toEqual([...sh.keys()].sort());
    for (const [k, v] of sh) {
        expect(nh.get(k)?.body, `${what}: ${k} content`).toBe(v.body);
        expect(nh.get(k)?.mode, `${what}: ${k} mode`).toBe(v.mode);
    }
    return { s, n, se, ne };
}

// --- the seeds, transcribed from tests/trust.bats -----------------------------

const trusted = (file: string, dir: string): unknown => {
    const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, Record<string, unknown>>>;
    return doc.projects?.[realpathSync(dir)]?.hasTrustDialogAccepted ?? false;
};

const docOf = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;

/** Two accounts plus the ambient one, each with its own ledger. */
function threeAccounts(e: Estate): void {
    mkdirSync(join(e.home, 'accts', 'one'), { recursive: true });
    mkdirSync(join(e.home, 'accts', 'two'), { recursive: true });
    mkdirSync(join(e.work, 'a'), { recursive: true });
    mkdirSync(join(e.work, 'b'), { recursive: true });
    writeFileSync(e.reg, JSON.stringify([
        { name: 'main', configDir: '~/.claude' },
        { name: 'one', configDir: join(e.home, 'accts', 'one') },
        { name: 'two', configDir: join(e.home, 'accts', 'two') },
    ]) + '\n');
    writeFileSync(join(e.home, '.claude.json'), JSON.stringify({
        projects: { [realpathSync(join(e.work, 'a'))]: { hasTrustDialogAccepted: true } },
    }, null, 2) + '\n');
    writeFileSync(join(e.home, 'accts', 'one', '.claude.json'), JSON.stringify({
        projects: { [realpathSync(join(e.work, 'b'))]: { hasTrustDialogAccepted: true } },
    }, null, 2) + '\n');
    writeFileSync(join(e.home, 'accts', 'two', '.claude.json'), '{}\n');
}

/** Exactly what `claude auth login` leaves behind: an address, no wizard. */
function freshAccount(e: Estate): void {
    mkdirSync(join(e.home, '.claude-accounts', 'fresh'), { recursive: true });
    writeFileSync(
        join(e.home, '.claude-accounts', 'fresh', '.claude.json'),
        '{"oauthAccount":{"emailAddress":"fresh@example.com"}}\n',
    );
    writeFileSync(e.reg, '[{"name":"fresh","configDir":"~/.claude-accounts/fresh"}]\n');
}

// --- what the table says ------------------------------------------------------

describe('the verb is registered, lazily', () => {
    it('has one row in droverVerbs, loaded through a dynamic import', () => {
        const row = droverVerbs.find((v) => v.name === 'trust');
        expect(row, 'droverVerbs has no trust row').toBeTruthy();
        expect(row!.summary).toContain('trust');
        expect(typeof row!.load).toBe('function');
    });

    it('the row really loads this module', async () => {
        const mod = await droverVerbs.find((v) => v.name === 'trust')!.load();
        expect(mod.run).toBe(run);
    });
});

// --- the pure halves ----------------------------------------------------------

describe('the jq filters, transcribed', () => {
    it('only an EXPLICIT true is a trust source; false and absent are not', () => {
        // Measured on 2.1.252: answering "No, exit" writes NOTHING, so `false`
        // on disk is the default on an entry made for another reason and never
        // a recorded refusal. Reading it as a "no" would keep re-asking a
        // question already answered yes somewhere else.
        expect(trustedKeysOf({
            projects: {
                '/yes': { hasTrustDialogAccepted: true },
                '/no': { hasTrustDialogAccepted: false },
                '/quoted': { hasTrustDialogAccepted: 'true' },
                '/silent': {},
            },
        })).toEqual(['/yes']);
    });

    it('a projects that is not an object is jq erroring, which is a file to skip', () => {
        expect(trustedKeysOf({ projects: 'nope' })).toBeNull();
        expect(trustedKeysOf({ projects: { '/x': 'nope' } })).toBeNull();
        // null and false both fall through the `//`, to the empty object.
        expect(trustedKeysOf({ projects: null })).toEqual([]);
        expect(trustedKeysOf({ projects: false })).toEqual([]);
        expect(trustedKeysOf(null)).toEqual([]);
    });

    it('the stamp verify wants onboarding, every want, and nothing outside seen', () => {
        const doc = { hasCompletedOnboarding: true, projects: { '/a': { hasTrustDialogAccepted: true } } };
        expect(verifyConfig(doc, ['/a'], ['/a', '/b'])).toBe(true);
        // A want it no longer holds: the estate drifted, do the full pass.
        expect(verifyConfig(doc, ['/a', '/b'], ['/a', '/b'])).toBe(false);
        // A key outside seen is a human's fresh "yes" and MUST reach the other
        // accounts, so it fails the verify and takes the full pass.
        expect(verifyConfig(doc, ['/a'], [])).toBe(false);
        // Not onboarded is not clean either.
        expect(verifyConfig({ projects: {} }, [], [])).toBe(false);
    });

    it('the registry read is jq: array elements, object values, and a scalar row aborts it', () => {
        expect(registryConfigDirs([{ configDir: 'a' }, { name: 'x' }, { configDir: 'b' }])).toEqual(['a', 'b']);
        expect(registryConfigDirs({ one: { configDir: 'a' } })).toEqual(['a']);
        // `.[]?.configDir` on a scalar row errors, and jq aborts the whole
        // program — the registry goes unread rather than half-read.
        expect(registryConfigDirs([{ configDir: 'a' }, 7])).toEqual([]);
        expect(registryConfigDirs('nope')).toEqual([]);
    });
});

describe('the stat fingerprint', () => {
    it('speaks the format the platform stat(1) speaks', () => {
        expect(detectStatFmt('darwin')).toBe('bsd');
        expect(detectStatFmt('linux')).toBe('gnu');
        expect(detectStatFmt('freebsd')).toBe('bsd');
    });

    it.skipIf(process.platform !== 'darwin')('matches BSD stat -f field for field', () => {
        const e = estate();
        const f = join(e.work, 'a.txt');
        writeFileSync(f, 'hi\n');
        chmodSync(f, 0o600);
        const s = spawnSync('stat', ['-f', '%N\t%m\t%z\t%p\t%Y', f], { encoding: 'utf8' });
        expect(s.status).toBe(0);
        expect(statLine(f, 'bsd')).toBe(s.stdout.replace(/\n$/, ''));
    });
});

// --- the differential ---------------------------------------------------------

describe.skipIf(!haveTree || !haveJq)('drover trust — the shell file and the node verb, byte for byte', () => {
    it('--help and -h print the shell heredoc exactly', async () => {
        for (const args of [['--help'], ['-h']]) {
            const { s, n } = await agree(undefined, args, args[0]);
            // Not a tautology of two empty answers: the help has to name the
            // three dialogs and the switch that turns the whole thing off.
            expect(n.out).toContain('drover trust [dir]');
            expect(n.out).toContain('bypass');
            expect(n.out).toContain('DROVER_SKIP_PERMISSIONS=0');
            expect(n.out).toContain('DROVER_TRUST_MIRROR=0');
            expect(s.out.length).toBeGreaterThan(1000);
        }
    });

    it('grants trust in a fresh directory: the config, the settings, and the stamp', async () => {
        const { se, ne } = await agree(undefined, [], 'a bare run in $PWD');
        for (const e of [se, ne]) {
            expect(trusted(join(e.home, '.claude.json'), e.work), 'the trust key landed').toBe(true);
            expect(docOf(join(e.home, '.claude.json')).hasCompletedOnboarding).toBe(true);
            expect(docOf(join(e.home, '.claude', 'settings.json')).skipDangerousModePermissionPrompt).toBe(true);
            // Trust is per-directory and lives in .claude.json; settings.json
            // holds the account-wide bypass key. Crossing them stamps files
            // nothing reads.
            expect(Object.keys(docOf(join(e.home, '.claude', 'settings.json')))).toEqual(['skipDangerousModePermissionPrompt']);
            expect(existsSync(join(e.state, 'trust.stamp'))).toBe(true);
        }
    });

    it('an explicitly empty argument means no project: account keys stamped, nothing trusted', async () => {
        const { se } = await agree(freshAccount, [''], 'trust ""');
        const cfg = join(se.home, '.claude-accounts', 'fresh', '.claude.json');
        expect(docOf(cfg).hasCompletedOnboarding).toBe(true);
        // The login it already had survives the stamp.
        expect((docOf(cfg).oauthAccount as Record<string, string>).emailAddress).toBe('fresh@example.com');
        expect(Object.keys((docOf(cfg).projects ?? {}) as object)).toEqual([]);
    });

    it('mirrors the union across every account, in both directions', async () => {
        const { se, ne } = await agree(threeAccounts, [''], 'the union');
        for (const e of [se, ne]) {
            const two = join(e.home, 'accts', 'two', '.claude.json');
            expect(trusted(two, join(e.work, 'a'))).toBe(true);
            expect(trusted(two, join(e.work, 'b'))).toBe(true);
            // And it travels in both directions, not just outward from default.
            expect(trusted(join(e.home, '.claude.json'), join(e.work, 'b'))).toBe(true);
            expect(trusted(join(e.home, 'accts', 'one', '.claude.json'), join(e.work, 'a'))).toBe(true);
        }
    });

    it('never mirrors a directory nobody trusted, one that is gone, or $HOME', async () => {
        const seed = (e: Estate): void => {
            threeAccounts(e);
            mkdirSync(join(e.work, 'never'), { recursive: true });
            const cfg = join(e.home, '.claude.json');
            const doc = docOf(cfg) as { projects: Record<string, unknown> };
            doc.projects[join(e.work, 'gone-with-the-worktree')] = { hasTrustDialogAccepted: true };
            doc.projects[realpathSync(e.home)] = { hasTrustDialogAccepted: true };
            writeFileSync(cfg, JSON.stringify(doc, null, 2) + '\n');
        };
        const { se, ne } = await agree(seed, [''], 'the union guards');
        for (const e of [se, ne]) {
            const two = docOf(join(e.home, 'accts', 'two', '.claude.json')).projects as Record<string, unknown>;
            expect(Object.keys(two)).not.toContain(realpathSync(join(e.work, 'never')));
            expect(Object.keys(two)).not.toContain(join(e.work, 'gone-with-the-worktree'));
            expect(Object.keys(two)).not.toContain(realpathSync(e.home));
        }
    });

    it('fills in an explicit false, because a refusal is never written to disk', async () => {
        const seed = (e: Estate): void => {
            threeAccounts(e);
            const cfg = join(e.home, 'accts', 'two', '.claude.json');
            writeFileSync(cfg, JSON.stringify({
                projects: { [realpathSync(join(e.work, 'a'))]: { hasTrustDialogAccepted: false } },
            }, null, 2) + '\n');
        };
        const { se } = await agree(seed, [''], 'an explicit false');
        expect(trusted(join(se.home, 'accts', 'two', '.claude.json'), join(se.work, 'a'))).toBe(true);
    });

    it('$HOME as the directory drops the trust stamp and keeps the bypass one', async () => {
        // Claude Code will not persist home-directory trust, so that stamp drops
        // out — but the bypass dialog is not per-directory and must not drop
        // with it. Before the fix the whole script exited here.
        const [se, ne] = pair();
        const s = shell(se, [se.home]);
        const n = await node(ne, [ne.home]);
        expect(n.code).toBe(s.code);
        expect(n.out).toBe(s.out);
        expect(n.err).toBe(s.err);
        for (const e of [se, ne]) {
            expect(docOf(join(e.home, '.claude', 'settings.json')).skipDangerousModePermissionPrompt).toBe(true);
            expect(Object.keys((docOf(join(e.home, '.claude.json')).projects ?? {}) as object)).toEqual([]);
        }
    });

    it('refuses a relative configDir out loud, and writes nothing beside the cwd', async () => {
        const seed = (e: Estate): void => {
            writeFileSync(e.reg, '[{"name":"odd","configDir":"rel/path"}]\n');
            mkdirSync(join(e.work, 'rel', 'path'), { recursive: true });
        };
        const { s, n, se } = await agree(seed, [], 'a relative configDir');
        expect(n.err).toContain("drover-trust: skipping configDir 'rel/path' — not an absolute path");
        expect(n.err).toBe(s.err);
        expect(n.code).toBe(0);
        expect(existsSync(join(se.work, 'rel', 'path', '.claude.json'))).toBe(false);
        expect(existsSync(join(se.work, 'rel', 'path', 'settings.json'))).toBe(false);
    });

    it("a configDir spelled 'default' never writes into the working directory", async () => {
        const seed = (e: Estate): void => {
            writeFileSync(e.reg, '[{"name":"main","configDir":"default"}]\n');
            mkdirSync(join(e.work, 'default'), { recursive: true });
        };
        const { se } = await agree(seed, [], "the 'default' spelling");
        expect(existsSync(join(se.work, 'default', '.claude.json'))).toBe(false);
        expect(existsSync(join(se.work, 'default', 'settings.json'))).toBe(false);
        expect(trusted(join(se.home, '.claude.json'), se.work)).toBe(true);
    });

    it('the ~/.claude spelling lands on the ambient pair, never ~/.claude/.claude.json', async () => {
        const seed = (e: Estate): void => {
            writeFileSync(e.reg, '[{"name":"main","configDir":"~/.claude"}]\n');
        };
        const { se } = await agree(seed, [], 'the ~/.claude spelling');
        expect(existsSync(join(se.home, '.claude', '.claude.json'))).toBe(false);
        expect(trusted(join(se.home, '.claude.json'), se.work)).toBe(true);
    });

    it('never invents a config dir for an account that is not installed', async () => {
        const seed = (e: Estate): void => {
            writeFileSync(e.reg, `[{"name":"ghost","configDir":"${join(e.home, 'nowhere')}"}]\n`);
        };
        const { se } = await agree(seed, [], 'a ghost account');
        expect(existsSync(join(se.home, 'nowhere'))).toBe(false);
    });

    it('a config that is not valid JSON is left exactly as found, and is not fatal', async () => {
        const seed = (e: Estate): void => {
            threeAccounts(e);
            writeFileSync(join(e.home, 'accts', 'one', '.claude.json'), 'NOT JSON\n');
            writeFileSync(join(e.home, '.claude', 'settings.json'), 'not json at all\n');
        };
        const { n, se } = await agree(seed, [''], 'a corrupt config');
        expect(n.code).toBe(0);
        expect(readFileSync(join(se.home, 'accts', 'one', '.claude.json'), 'utf8')).toBe('NOT JSON\n');
        expect(readFileSync(join(se.home, '.claude', 'settings.json'), 'utf8')).toBe('not json at all\n');
        // And the union survived it: the account listed after the corrupt one
        // still got everything.
        expect(trusted(join(se.home, 'accts', 'two', '.claude.json'), join(se.work, 'a'))).toBe(true);
    });

    it('DROVER_SKIP_PERMISSIONS=0 writes nothing at all', async () => {
        const { se } = await agree(undefined, [], 'the switch', (e) => {
            e.env.DROVER_SKIP_PERMISSIONS = '0';
        });
        expect(existsSync(join(se.home, '.claude.json'))).toBe(false);
        expect(existsSync(join(se.home, '.claude', 'settings.json'))).toBe(false);
        expect(existsSync(join(se.state, 'trust.stamp'))).toBe(false);
    });

    it('DROVER_DRY_RUN writes nothing (DROVE-322)', async () => {
        // bin/drover calls this on the session-start path BEFORE the guard that
        // stops a dry run launching the CLI, and proving dispatch is what a dry
        // run is FOR — so without this the whole bats suite stamped every real
        // config on the way past.
        const { se } = await agree(threeAccounts, [], 'a dry run', (e) => {
            e.env.DROVER_DRY_RUN = '1';
        });
        expect(docOf(join(se.home, '.claude.json')).hasCompletedOnboarding).toBeUndefined();
        expect(existsSync(join(se.state, 'trust.stamp'))).toBe(false);
    });

    it('DROVER_TRUST_MIRROR=0 leaves every ledger alone but still settles the dialogs', async () => {
        const { se, ne } = await agree(threeAccounts, [''], 'the mirror off', (e) => {
            e.env.DROVER_TRUST_MIRROR = '0';
        });
        for (const e of [se, ne]) {
            const two = join(e.home, 'accts', 'two', '.claude.json');
            expect(trusted(two, join(e.work, 'a'))).toBe(false);
            expect(docOf(two).hasCompletedOnboarding).toBe(true);
        }
    });

    it('DROVER_TRUST_VERBOSE says how many files, and never what is in them', async () => {
        const { n, s } = await agree(threeAccounts, [''], 'verbose', (e) => {
            e.env.DROVER_TRUST_VERBOSE = '1';
        });
        expect(n.err).toBe(s.err);
        expect(n.err).toMatch(/^drover: pre-accepted the trust, bypass and first-run dialogs in \d+ file\(s\)\n$/);
    });

    it('an EMPTY switch means the default, not the empty string', async () => {
        // `${DROVER_TRUST_MIRROR:-1}` and `${DROVER_TRUST_STAMP:-...}` fall back
        // on empty as well as unset. A reader that took `DROVER_TRUST_MIRROR=`
        // literally would silently turn the mirror off, and one that took an
        // empty DROVER_TRUST_STAMP literally would write its stamp beside the
        // cwd instead of in the state dir.
        const { se, ne } = await agree(threeAccounts, [''], 'empty switches', (e) => {
            e.env.DROVER_TRUST_MIRROR = '';
            e.env.DROVER_TRUST_STAMP = '';
        });
        for (const e of [se, ne]) {
            expect(trusted(join(e.home, 'accts', 'two', '.claude.json'), join(e.work, 'a')), 'the mirror ran').toBe(true);
            expect(existsSync(join(e.state, 'trust.stamp')), 'the stamp landed in the state dir').toBe(true);
        }
    });

    it('agrees on every argument the shell has no table for', async () => {
        // There is no argument validation in the shell file: `-f`/`--force` is
        // the only flag and every other word is the directory to trust, so an
        // unknown argument is a directory that does not exist and exits 0. A
        // node arm that invented an exit 2 here would refuse a session start
        // the shell allowed.
        for (const args of [['--nope'], ['-x'], ['-f'], ['-f', ''], ['--force', ''], [''], ['/definitely/not/here']]) {
            const { n } = await agree(undefined, args, `args ${JSON.stringify(args)}`);
            expect(n.code, JSON.stringify(args)).toBe(0);
        }
    });

    it('has no --json and no revoke: both are the directory, and both exit 0', async () => {
        for (const args of [['--json'], ['revoke'], ['--revoke', 'x']]) {
            const { n } = await agree(undefined, args, `args ${JSON.stringify(args)}`);
            expect(n.code).toBe(0);
            expect(n.out, 'nothing on stdout but --help').toBe('');
        }
    });
});

// --- the stamp (DROVE-287), and the two arms sharing it ------------------------

describe.skipIf(!haveTree || !haveJq)('the stamp', () => {
    it('a second run with nothing changed writes nothing, on both arms', async () => {
        const [se, ne] = pair(threeAccounts);
        shell(se, ['']);
        await node(ne, ['']);
        const sBefore = shotOf(se);
        const nBefore = shotOf(ne);
        const s2 = shell(se, ['']);
        const n2 = await node(ne, ['']);
        expect(s2.code).toBe(0);
        expect(n2.code).toBe(0);
        expect([...shotOf(se)]).toEqual([...sBefore]);
        expect([...shotOf(ne)]).toEqual([...nBefore]);
    });

    it("the node arm takes the shell's stamp, and the shell takes the node arm's", async () => {
        // The two arms share $STATE_DIR/trust.stamp while bin/drover can still
        // call either, so a stamp one wrote has to be a stamp the other accepts
        // as clean — otherwise every alternation pays the full pass, or worse,
        // refreshes a stamp that omits what the other fingerprints.
        const [se, ne] = pair(threeAccounts);
        shell(se, ['']);
        const afterShell = shotOf(se);
        const n = await node(se, ['']);
        expect(n.code).toBe(0);
        expect([...shotOf(se)], 'node rewrote something the shell had settled').toEqual([...afterShell]);

        await node(ne, ['']);
        const afterNode = shotOf(ne);
        const s = shell(ne, ['']);
        expect(s.code).toBe(0);
        expect([...shotOf(ne)], 'the shell rewrote something node had settled').toEqual([...afterNode]);
    });

    it('a directory already in the union takes the same fast exit', async () => {
        const [se, ne] = pair(threeAccounts);
        shell(se, ['']);
        await node(ne, ['']);
        const before = shotOf(ne);
        const n = await node(ne, [join(ne.work, 'a')]);
        expect(n.code).toBe(0);
        expect([...shotOf(ne)]).toEqual([...before]);
    });

    it("claude's own churn in one config is verified, not re-walked, and both arms agree", async () => {
        const churn = (e: Estate): void => {
            const cfg = join(e.home, 'accts', 'one', '.claude.json');
            const doc = docOf(cfg);
            doc.history = ['noise'];
            writeFileSync(cfg, JSON.stringify(doc, null, 2) + '\n');
        };
        const [se, ne] = pair(threeAccounts);
        shell(se, ['']);
        await node(ne, ['']);
        churn(se);
        churn(ne);
        const s = shell(se, ['']);
        const n = await node(ne, ['']);
        expect(n.code).toBe(s.code);
        expect(n.out).toBe(s.out);
        expect(n.err).toBe(s.err);
        const sh = shotOf(se);
        const nh = shotOf(ne);
        expect([...nh.keys()].sort()).toEqual([...sh.keys()].sort());
        for (const [k, v] of sh) expect(nh.get(k)?.body, k).toBe(v.body);
        // The churn was history noise, so the config keeps it and nothing else moved.
        expect(docOf(join(ne.home, 'accts', 'one', '.claude.json')).history).toEqual(['noise']);
    });

    it('a fresh trust on account A still reaches account B on the next start', async () => {
        // The acceptance criterion. A human answers the trust dialog on one
        // account; the stamp must read that as a miss, not as noise.
        const answerYes = (e: Estate): void => {
            mkdirSync(join(e.work, 'new'), { recursive: true });
            const cfg = join(e.home, 'accts', 'one', '.claude.json');
            const doc = docOf(cfg) as { projects: Record<string, unknown> };
            doc.projects[realpathSync(join(e.work, 'new'))] = { hasTrustDialogAccepted: true };
            writeFileSync(cfg, JSON.stringify(doc, null, 2) + '\n');
        };
        const [se, ne] = pair(threeAccounts);
        shell(se, ['']);
        await node(ne, ['']);
        answerYes(se);
        answerYes(ne);
        shell(se, ['']);
        await node(ne, ['']);
        for (const e of [se, ne]) {
            expect(trusted(join(e.home, 'accts', 'two', '.claude.json'), join(e.work, 'new'))).toBe(true);
            expect(trusted(join(e.home, '.claude.json'), join(e.work, 'new'))).toBe(true);
        }
    });

    it('a run that FAILED a write is not remembered as done', async () => {
        const [se, ne] = pair(threeAccounts);
        shell(se, ['']);
        await node(ne, ['']);
        for (const e of [se, ne]) {
            mkdirSync(join(e.work, 'new'), { recursive: true });
            const cfg = join(e.home, 'accts', 'one', '.claude.json');
            const doc = docOf(cfg) as { projects: Record<string, unknown> };
            doc.projects[realpathSync(join(e.work, 'new'))] = { hasTrustDialogAccepted: true };
            writeFileSync(cfg, JSON.stringify(doc, null, 2) + '\n');
            chmodSync(join(e.home, 'accts', 'two'), 0o500);
        }
        shell(se, ['']);
        const n = await node(ne, ['']);
        expect(n.code).toBe(0);
        for (const e of [se, ne]) {
            expect(trusted(join(e.home, '.claude.json'), join(e.work, 'new'))).toBe(true);
            expect(trusted(join(e.home, 'accts', 'two', '.claude.json'), join(e.work, 'new'))).toBe(false);
            chmodSync(join(e.home, 'accts', 'two'), 0o700);
        }
        // Without the fail check this run would take the fast exit and account
        // two would stay a dialog forever.
        shell(se, ['']);
        await node(ne, ['']);
        for (const e of [se, ne]) {
            expect(trusted(join(e.home, 'accts', 'two', '.claude.json'), join(e.work, 'new'))).toBe(true);
        }
    });

    it('switching the mirror off and back on is never remembered as done', async () => {
        const [se, ne] = pair(threeAccounts);
        se.env.DROVER_TRUST_MIRROR = '0';
        ne.env.DROVER_TRUST_MIRROR = '0';
        shell(se, ['']);
        await node(ne, ['']);
        delete se.env.DROVER_TRUST_MIRROR;
        delete ne.env.DROVER_TRUST_MIRROR;
        shell(se, ['']);
        await node(ne, ['']);
        for (const e of [se, ne]) {
            expect(trusted(join(e.home, 'accts', 'two', '.claude.json'), join(e.work, 'a'))).toBe(true);
        }
    });

    it('garbage in the stamp file falls back to the full pass', async () => {
        const seed = (e: Estate): void => {
            threeAccounts(e);
            mkdirSync(e.state, { recursive: true });
            writeFileSync(join(e.state, 'trust.stamp'), 'not a stamp at all\n');
        };
        const { se } = await agree(seed, [''], 'a garbage stamp');
        expect(trusted(join(se.home, 'accts', 'two', '.claude.json'), join(se.work, 'a'))).toBe(true);
    });

    it('a config that stops parsing forces the full pass, and the union survives it', async () => {
        const [se, ne] = pair(threeAccounts);
        shell(se, ['']);
        await node(ne, ['']);
        for (const e of [se, ne]) {
            writeFileSync(join(e.home, 'accts', 'one', '.claude.json'), 'NOT JSON\n');
            mkdirSync(join(e.work, 'new'), { recursive: true });
            const cfg = join(e.home, '.claude.json');
            const doc = docOf(cfg) as { projects: Record<string, unknown> };
            doc.projects[realpathSync(join(e.work, 'new'))] = { hasTrustDialogAccepted: true };
            writeFileSync(cfg, JSON.stringify(doc, null, 2) + '\n');
        }
        shell(se, ['']);
        await node(ne, ['']);
        for (const e of [se, ne]) {
            expect(trusted(join(e.home, 'accts', 'two', '.claude.json'), join(e.work, 'new'))).toBe(true);
            expect(readFileSync(join(e.home, 'accts', 'one', '.claude.json'), 'utf8')).toBe('NOT JSON\n');
        }
    });

    it('-f ignores the stamp and does the full pass now', async () => {
        const [se, ne] = pair(threeAccounts);
        shell(se, ['']);
        await node(ne, ['']);
        // Take the union away from one account behind the stamp's back; only a
        // forced full pass can put it back.
        for (const e of [se, ne]) {
            writeFileSync(join(e.home, 'accts', 'two', '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }, null, 2) + '\n');
        }
        shell(se, ['-f', '']);
        await node(ne, ['-f', '']);
        for (const e of [se, ne]) {
            expect(trusted(join(e.home, 'accts', 'two', '.claude.json'), join(e.work, 'a'))).toBe(true);
        }
    });
});

// --- it is a security verb ----------------------------------------------------

describe('nothing it reads reaches the screen', () => {
    it.skipIf(!haveTree || !haveJq)('a seeded credential appears in no byte of stdout or stderr', async () => {
        const secret = 'sk-ant-oat01-NOT-A-REAL-TOKEN-0000';
        const address = 'clay@example.invalid';
        const seed = (e: Estate): void => {
            threeAccounts(e);
            const cfg = join(e.home, 'accts', 'one', '.claude.json');
            const doc = docOf(cfg);
            doc.oauthAccount = { emailAddress: address, accessToken: secret };
            writeFileSync(cfg, JSON.stringify(doc, null, 2) + '\n');
        };
        const { s, n, se } = await agree(seed, [''], 'a config holding a credential', (e) => {
            e.env.DROVER_TRUST_VERBOSE = '1';
        });
        for (const text of [s.out, s.err, n.out, n.err]) {
            expect(text).not.toContain(secret);
            expect(text).not.toContain(address);
        }
        // And the credential survived every rewrite, which is the other half:
        // the one way this could be worse than the dialog is losing the login.
        const after = docOf(join(se.home, 'accts', 'one', '.claude.json')).oauthAccount as Record<string, string>;
        expect(after.accessToken).toBe(secret);
        expect(after.emailAddress).toBe(address);
    });
});

describe('it runs no subprocess', () => {
    it('completes with a probe whose every member throws', async () => {
        // The double is the assertion: a code path that reached for Clay's real
        // machine fails the test rather than measuring it.
        const e = estate(threeAccounts);
        const code = await run([''], { env: e.env, home: e.home, cwd: e.work, probe: throwingProbe });
        expect(code).toBe(0);
        expect(() => realTrustProbe.spawn('ps', [])).toThrow();
    });

    it('the module names no process API at all', () => {
        const src = readFileSync(fileURLToPath(new URL('./trust.ts', import.meta.url)), 'utf8');
        const body = src.slice(src.indexOf('\nimport {'));
        for (const banned of ['child_process', 'spawnSync', 'execFileSync', 'execSync']) {
            expect(body.includes(banned), `trust.ts names ${banned}`).toBe(false);
        }
    });
});

// --- and never a real home ----------------------------------------------------

describe('the fence', () => {
    it('every estate points HAPPY_HOME_DIR at the throwaway, never ~/.happy', () => {
        const e = estate();
        expect(() => refuseRealHappyHome(e.env, 'fence')).not.toThrow();
        expect(() => refuseRealHappyHome({ HAPPY_HOME_DIR: undefined }, 'fence')).toThrow(/Refusing/);
        expect(happyHomeOf(process.env)).toBe(happyHome);
    });

    it('and the pinned happy home stays empty', () => {
        expect(existsSync(happyHome) ? readdirSync(happyHome) : []).toEqual([]);
        expect(statSync(happyHome).isDirectory()).toBe(true);
    });
});
