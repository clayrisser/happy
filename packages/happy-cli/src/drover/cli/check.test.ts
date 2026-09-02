/**
 * The vitest twin of cattle-drover/tests/check.bats (DROVE-315).
 *
 * check.bats is the spec for `drover check` and it stays green until the shell
 * file leaves. Eleven of its eighteen tests exercise the CHECKER and are here,
 * one for one, on the same fixtures: the four DROVE-261 lines spliced back into
 * the real libexec/drover-account, a prose-only line the loadtime probe cannot
 * see, the heredoc files the ticket names by hand, indented code in a body, a
 * python script, and the real tree — which must be clean, because this is the
 * tripwire bin/drover runs before it dispatches anything.
 *
 * The other seven assert `bin/drover`: that it calls the checker before the
 * dispatch case, that DROVER_SKIP_CHECK bypasses it, that statusline is exempt,
 * that a missing checker is skipped rather than fatal, plus the `sh -n` sweep
 * over the repo and its canary. None of those is this verb's behaviour and none
 * of them changes when the checker is written in node, so they stay in the bats
 * suite, which still runs the shell wrapper.
 *
 * On top of the bats, one differential describe runs the SHELL verb and the
 * node verb on the same trees and the same arguments and compares stdout,
 * stderr and exit code byte for byte, so the port cannot drift a character from
 * what refused Clay's broken tree before it.
 *
 * Nothing here reaches ~/.happy. The verb reads scripts and writes lines; it
 * has no bus, no store and no server. The pin below is applied anyway, because
 * the one thing this file does spawn is a shell, and a spawn from this tree is
 * exactly what leaked 255 sessions onto Clay's phone once already.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { checkText, defaultFiles, isShellScript, run } from './check';
import { droverVerbs, runDroverVerb } from './index';

/**
 * A throwaway HAPPY_HOME_DIR, pinned above every import (DROVE-336).
 *
 * On 2026-09-01 the startup benchmarks for this port spawned the built entry
 * against a base that predated DROVE-314, where the run went on into
 * authAndEnsureDaemon() and runClaude(). No bench had set HAPPY_HOME_DIR, so
 * each spawn read the real ~/.happy/access.key and registered a real session
 * with the real daemon: seventy-eight of them from this worktree, on Clay's
 * phone. This verb never touches ~/.happy and this file never spawns the entry,
 * but the leak came from the same tree and nothing in it said no. This does.
 */
const { happyHome, realHappyHome } = await vi.hoisted(async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const realHappyHome = path.join(os.homedir(), '.happy');
    const happyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'check-happy-'));
    process.env.HAPPY_HOME_DIR = happyHome;
    return { happyHome, realHappyHome };
});

// The modules a session registration goes through. The verb imports none of
// them; a factory that throws turns a future import into a failure of this
// whole file at load, instead of a test that quietly reads ~/.happy.
vi.mock('../../configuration', () => {
    throw new Error('check.test: configuration (the ~/.happy reader) was imported; the verb must not reach the session machinery');
});
vi.mock('../../persistence', () => {
    throw new Error('check.test: persistence (access.key, settings) was imported; the verb must not reach the session machinery');
});
vi.mock('../../api/api', () => {
    throw new Error('check.test: api/api (session registration) was imported; the verb must not reach the session machinery');
});
vi.mock('../../claude/runClaude', () => {
    throw new Error('check.test: claude/runClaude was imported; the verb must not reach the session machinery');
});

type Env = Record<string, string | undefined>;

/** Where HAPPY_HOME_DIR points, read the way configuration.ts reads it: unset is ~/.happy, a leading ~ is home. */
function happyHomeOf(env: Env): string {
    const raw = env.HAPPY_HOME_DIR;
    return raw ? resolve(raw.replace(/^~/, homedir())) : resolve(realHappyHome);
}

/** Refuse an environment whose HAPPY_HOME_DIR is the real one. Thrown so it fails the file, not one test. */
function refuseRealHappyHome(env: Env, where: string): void {
    if (happyHomeOf(env) === resolve(realHappyHome)) {
        throw new Error(
            `${where}: HAPPY_HOME_DIR resolves to the real ${realHappyHome} (it is ${env.HAPPY_HOME_DIR ?? 'unset'}). `
            + 'Anything that reached the entry from here would register sessions on the real daemon. Refusing.',
        );
    }
}

const REGISTRATION_FILES = ['access.key', 'daemon.state.json', 'daemon.state.json.lock', 'sessions.json', 'settings.json'];

beforeAll(() => {
    refuseRealHappyHome(process.env, 'check.test');
    if (happyHomeOf(process.env) !== happyHome) {
        throw new Error(`check.test: HAPPY_HOME_DIR moved off the pin (it is ${process.env.HAPPY_HOME_DIR}); refusing to run`);
    }
});

afterAll(() => {
    refuseRealHappyHome(process.env, 'check.test (afterAll)');
    expect(existsSync(happyHome) ? readdirSync(happyHome).filter((f) => REGISTRATION_FILES.includes(f)) : []).toEqual([]);
    expect(existsSync(happyHome) ? readdirSync(happyHome) : []).toEqual([]);
    rmSync(happyHome, { recursive: true, force: true });
});

// --- the real cattle-drover checkout, which is the tree under test -----------

/** The checkout `droverEnv().droverDir` names by default, and the one the shell verb reads from its own dirname. */
const realRoot = join(homedir(), 'Projects', 'bitspur', 'cattle-drover');
const shellVerb = join(realRoot, 'libexec', 'drover-check');
const haveTree = existsSync(join(realRoot, 'libexec', 'drover-account'));

interface Captured {
    code: number;
    out: string;
    err: string;
}

/** Run the verb in process, with its stdout and stderr caught rather than printed. */
async function capture(args: string[], env: Env = {}, home: string = homedir()): Promise<Captured> {
    refuseRealHappyHome(process.env, 'capture');
    const out: string[] = [];
    const err: string[] = [];
    const so = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => (out.push(String(c)), true));
    const se = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => (err.push(String(c)), true));
    try {
        const code = await run(args, { env, home });
        return { code, out: out.join(''), err: err.join('') };
    } finally {
        so.mockRestore();
        se.mockRestore();
    }
}

let work: string;

beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'check-'));
});

afterEach(() => {
    rmSync(work, { recursive: true, force: true });
});

/**
 * The four lines exactly as DROVE-261 records them, spliced back into the real
 * drover-account after its "account add" line. Indentation is load-bearing: a
 * doc line that loses its `#` keeps the indentation it had, which is what makes
 * it land INSIDE the header block instead of ending it.
 */
function revertedTypo(into: string = join(work, 'drover-account')): string {
    const src = readFileSync(join(realRoot, 'libexec', 'drover-account'), 'utf8').split('\n');
    const spliced = [
        ...src.slice(0, 16),
        '  drover account login --harness cursor [name]',
        '                                     add a CURSOR subscription instead. It',
        '                                     carries a token, not a config dir, and is',
        '                                     run with `drover cursor --account <name>`.',
        ...src.slice(16),
    ];
    writeFileSync(into, spliced.join('\n'));
    return into;
}

/** One header line that is prose only — no command, nothing a shimmed binary would notice. */
function proseOnly(into: string = join(work, 'prose')): string {
    const src = readFileSync(join(realRoot, 'libexec', 'drover-account'), 'utf8').split('\n');
    writeFileSync(into, [
        ...src.slice(0, 16),
        '                                     carries a token, not a config dir, and is',
        ...src.slice(16),
    ].join('\n'));
    return into;
}

/**
 * A throwaway tree: the real scripts under a directory of this test's own, so
 * a run against the DEFAULT list never reads the checkout Clay is working in.
 */
function fakeTree(): string {
    const tree = join(work, 'tree');
    for (const d of ['bin', 'libexec', 'lib', 'etc', 'adapters', 'clients']) mkdirSync(join(tree, d), { recursive: true });
    const copy = (from: string, to: string, suffix?: string): void => {
        for (const n of readdirSync(from)) {
            if (n.startsWith('.')) continue;
            if (suffix !== undefined && !n.endsWith(suffix)) continue;
            const src = join(from, n);
            try {
                // The mode matters: the differential spawns the copy.
                writeFileSync(join(to, n), readFileSync(src), { mode: 0o755 });
                chmodSync(join(to, n), 0o755);
            } catch {
                // A directory under libexec/ is not a script; the glob's
                // `[ -f ]` skipped it too.
            }
        }
    };
    writeFileSync(join(tree, 'bin', 'drover'), readFileSync(join(realRoot, 'bin', 'drover')), { mode: 0o755 });
    writeFileSync(join(tree, 'etc', 'drover.env'), readFileSync(join(realRoot, 'etc', 'drover.env')));
    copy(join(realRoot, 'libexec'), join(tree, 'libexec'));
    copy(join(realRoot, 'lib'), join(tree, 'lib'), '.sh');
    copy(join(realRoot, 'adapters'), join(tree, 'adapters'), '.sh');
    copy(join(realRoot, 'clients'), join(tree, 'clients'), '.sh');
    return tree;
}

/** An env pinned at one tree, with a STATE_DIR that holds no local.env to override it. */
function treeEnv(root: string): Env {
    return { DROVER_DIR: root, STATE_DIR: join(work, 'state') };
}

describe.skipIf(!haveTree)('drover check — the header rule (check.bats, on the same fixtures)', () => {
    it('REJECTS the reverted DROVE-261 typo, and names the line that ran', async () => {
        const f = revertedTypo();
        const r = await capture([f]);
        expect(r.code).toBe(1);
        // It must name the line, not just fail: line 17 is the one that ran.
        expect(r.err).toContain(`${f}:17:`);
        expect(r.err).toContain('RUNS at load');
    });

    it('names every line of the block, not only the first', async () => {
        const f = revertedTypo();
        const r = await capture([f]);
        expect(r.code).toBe(1);
        expect(r.err).toContain(`${f}:18:`);
        expect(r.err).toContain(`${f}:19:`);
        // Line 20 carries live backticks -- command substitution, a second hazard.
        expect(r.err).toContain(`${f}:20:`);
    });

    it('prints the offending line under its own complaint, indented four spaces', async () => {
        // Tightened past the bats' substring: the pair of lines, exactly.
        const f = revertedTypo();
        const r = await capture([f]);
        expect(r.err.split('\n').slice(0, 2)).toEqual([
            `${f}:17: header comment lost its leading #, so this line RUNS at load`,
            '      drover account login --harness cursor [name]',
        ]);
    });

    it('sh -n PASSES on that same file, which is why the check exists', () => {
        const f = revertedTypo();
        const sh = spawnSync('sh', ['-n', f], { encoding: 'utf8' });
        expect(sh.status).toBe(0);
    });

    it('catches a prose-only header line, which the loadtime probe misses', async () => {
        // Not a shimmed binary, so nothing the probe watches for is reached.
        const f = proseOnly();
        expect(spawnSync('sh', ['-n', f], { encoding: 'utf8' }).status).toBe(0);
        const r = await capture([f]);
        expect(r.code).toBe(1);
        expect(r.err).toContain(`${f}:17:`);
    });

    it('the real tree is clean', async () => {
        // The live tripwire. bin/drover runs this before every dispatch, so a
        // red here is a drover that will not start.
        const r = await capture([], { DROVER_DIR: realRoot, STATE_DIR: join(work, 'state') });
        expect(r.err).toBe('');
        expect(r.code).toBe(0);
        expect(r.out).toBe('drover check: headers clean\n');
    });

    it('the real tree\'s default list is the five globs, in tree order', async () => {
        // Tightened: the bats only asserts the verdict. The list is the other
        // half of the rule -- a glob that quietly stopped matching would keep
        // this green forever.
        const files = defaultFiles(realRoot);
        expect(files.length).toBeGreaterThan(20);
        expect(files).toContain(join(realRoot, 'bin', 'drover'));
        expect(files).toContain(join(realRoot, 'libexec', 'drover-account'));
        expect(files.every((f) => existsSync(f))).toBe(true);
        // lib/, adapters/ and clients/ contribute .sh only.
        for (const dir of ['lib', 'adapters', 'clients']) {
            for (const f of files.filter((p) => p.startsWith(join(realRoot, dir) + '/'))) {
                expect(f.endsWith('.sh'), f).toBe(true);
            }
        }
    });

    it('heredoc prose is not a false positive', async () => {
        // The ticket names these by hand: their `<<'EOF'` / `<<'HELPTEXT'`
        // bodies hold prose that looks exactly like a broken header line. A
        // check that flagged them would be switched off within a day.
        const r = await capture([
            join(realRoot, 'libexec', 'drover-accounts'),
            join(realRoot, 'libexec', 'drover-cursor'),
            join(realRoot, 'libexec', 'drover-cursor-login'),
            join(realRoot, 'libexec', 'drover-sync-commands'),
        ]);
        expect(r.err).toBe('');
        expect(r.code).toBe(0);
    });
});

describe('drover check — the header rule on hand-written files', () => {
    it('a comment block that is entirely intact passes', async () => {
        const f = join(work, 'ok');
        writeFileSync(f, '#!/bin/sh\n# one\n#   indented doc\n#\n# two\nset -e\necho hi\n');
        const r = await capture([f]);
        expect(r.code).toBe(0);
        expect(r.err).toBe('');
    });

    it('a file with no header at all passes', async () => {
        const f = join(work, 'bare');
        writeFileSync(f, '#!/bin/sh\nset -e\necho hi\n');
        expect((await capture([f])).code).toBe(0);
    });

    it('indented code below the header is not a false positive', async () => {
        // The rule reads the leading region only, so an indented statement in
        // the BODY -- inside an if, a loop, a function -- is ordinary code.
        const f = join(work, 'body');
        writeFileSync(f, '#!/bin/sh\n# header\nset -e\nif [ 1 ]; then\n  echo indented\nfi\n');
        expect((await capture([f])).code).toBe(0);
    });

    it('a non-shell script is skipped', async () => {
        // Not shell, not this check's business: a bare line in python or node
        // is not a command, and flagging one would be nonsense.
        const f = join(work, 'py');
        writeFileSync(f, '#!/usr/bin/env python3\n# doc\n  still_doc_but_indented\nx = 1\n');
        expect((await capture([f])).code).toBe(0);
    });

    it('a file with no shebang at all is data, and is skipped', async () => {
        const f = join(work, 'data');
        writeFileSync(f, '# doc\n  a bare line\nset -e\n');
        expect((await capture([f])).code).toBe(0);
    });

    it('the shebang test takes sh, bash, dash, ksh and zsh, and nothing else', () => {
        for (const line of ['#!/bin/sh', '#!/bin/bash', '#!/usr/bin/env sh', '#!/usr/bin/env bash', '#!/bin/dash', '#!/bin/ksh', '#!/bin/zsh', '#!/bin/sh -e']) {
            expect(isShellScript(line), line).toBe(true);
        }
        for (const line of ['#!/usr/bin/env python3', '#!/usr/bin/env node', '#!/usr/bin/env bats', '#!/bin/shell', '', '# not a shebang', '#!/usr/bin/perl']) {
            expect(isShellScript(line), line).toBe(false);
        }
    });

    it('a blank line inside the header neither ends it nor violates it', () => {
        const v = checkText('f', '#!/bin/sh\n# one\n\n\t \n# two\n  still in the banner\nset -e\n');
        expect(v).toEqual([{ file: 'f', line: 6, text: '  still in the banner' }]);
    });

    it('nothing past the first column-0 statement is read, which is what keeps heredocs out', () => {
        const v = checkText('f', '#!/bin/sh\n# header\ncat <<\'EOF\'\n  drover account login --harness cursor\nEOF\n');
        expect(v).toEqual([]);
    });

    it('an empty file, and a file that is only a shebang, are both nothing to say', () => {
        expect(checkText('f', '')).toEqual([]);
        expect(checkText('f', '#!/bin/sh\n')).toEqual([]);
    });
});

describe('drover check — arguments', () => {
    it('--help is the help text, on stdout, exit 0', async () => {
        const r = await capture(['--help']);
        expect(r.code).toBe(0);
        expect(r.err).toBe('');
        expect(r.out.startsWith('drover check — refuse a tree whose header comments have become commands.\n')).toBe(true);
        expect(r.out).toContain('drover check <file>…  Check just these files');
        expect(r.out).toContain('DROVER_SKIP_CHECK=1 bypasses it');
        expect((await capture(['-h'])).out).toBe(r.out);
    });

    it('an argument it does not know is refused with 2, by name', async () => {
        const r = await capture(['--nope']);
        expect(r.code).toBe(2);
        expect(r.out).toBe('');
        expect(r.err).toBe("drover-check: unknown argument '--nope' (try --help)\n");
    });

    it('-q says nothing on success', async () => {
        const f = join(work, 'ok');
        writeFileSync(f, '#!/bin/sh\n# doc\nset -e\n');
        const r = await capture(['-q', f]);
        expect(r.code).toBe(0);
        expect(r.out).toBe('');
        expect(r.err).toBe('');
        expect(await capture(['--quiet', f])).toEqual(r);
    });

    it('-q still exits 1 on a failure, and still says which line', async () => {
        const f = join(work, 'bad');
        writeFileSync(f, '#!/bin/sh\n# doc\n  drover account login --harness cursor\nset -e\n');
        const r = await capture(['-q', f]);
        expect(r.code).toBe(1);
        expect(r.out).toBe('');
        expect(r.err).toContain(`${f}:3:`);
        expect(r.err).toContain('To run anyway while you fix it:  DROVER_SKIP_CHECK=1 drover ...');
    });

    it('the first non-flag argument ends the flags: everything after it is a filename', async () => {
        // `files=1; break` in the shell. `-q` after a file is a FILE, and a
        // file that cannot be opened is a file that was not checked.
        const f = join(work, 'ok');
        writeFileSync(f, '#!/bin/sh\n# doc\nset -e\n');
        const r = await capture([f, '-q']);
        expect(r.code).toBe(1);
        expect(r.err).toContain("can't open file -q");
    });

    it('an empty tree is nothing to read, not a failure', async () => {
        const empty = join(work, 'empty');
        mkdirSync(empty);
        const r = await capture([], treeEnv(empty));
        expect(r.code).toBe(0);
        expect(r.out).toBe('drover check: nothing to read\n');
        expect((await capture(['-q'], treeEnv(empty))).out).toBe('');
    });

    it('a tree holding only bin/ and libexec/ reads those and nothing else', async () => {
        // The bats builds throwaway trees with exactly two directories. A raw
        // glob would hand the reader `<root>/lib/*.sh` as a literal path.
        const tree = join(work, 'two');
        mkdirSync(join(tree, 'bin'), { recursive: true });
        mkdirSync(join(tree, 'libexec'), { recursive: true });
        writeFileSync(join(tree, 'bin', 'drover'), '#!/bin/sh\n# doc\nset -e\n');
        writeFileSync(join(tree, 'libexec', 'drover-x'), '#!/bin/sh\n# doc\nset -e\n');
        expect(defaultFiles(tree)).toEqual([join(tree, 'bin', 'drover'), join(tree, 'libexec', 'drover-x')]);
        const r = await capture([], treeEnv(tree));
        expect(r.code).toBe(0);
        expect(r.out).toBe('drover check: headers clean\n');
    });
});

describe.skipIf(!haveTree)('drover check — the verb on a broken tree', () => {
    it('reports on a broken tree instead of refusing to run', async () => {
        // `drover check <file>` is what you reach for while you are fixing the
        // thing it is complaining about. Refusing to start because the tree is
        // broken would make it useless at exactly the moment it is wanted.
        const tree = fakeTree();
        revertedTypo(join(tree, 'libexec', 'drover-account'));
        const named = await capture([join(tree, 'libexec', 'drover-account')], treeEnv(tree));
        expect(named.code).toBe(1);
        expect(named.err).toContain('drover-account:17:');
        // And the default list over that same tree says the same thing, which
        // is what bin/drover would have seen before it dispatched.
        const all = await capture([], treeEnv(tree));
        expect(all.code).toBe(1);
        expect(all.err).toContain('drover-account:17:');
    });

    it('a clean file named inside a broken tree passes: named files bypass the list', async () => {
        const tree = fakeTree();
        revertedTypo(join(tree, 'libexec', 'drover-account'));
        const r = await capture([join(tree, 'libexec', 'drover-check')], treeEnv(tree));
        expect(r.code).toBe(0);
        expect(r.out).toBe('drover check: headers clean\n');
    });
});

describe('drover check — the row in the table', () => {
    it('is one row named check, loading its own chunk', () => {
        const row = droverVerbs.find((v) => v.name === 'check');
        expect(row, droverVerbs.map((v) => v.name).join(', ')).toBeDefined();
        expect(row?.summary).toBeTruthy();
    });

    it('is reachable through runDroverVerb, and answers --help there', async () => {
        const out: string[] = [];
        const so = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => (out.push(String(c)), true));
        try {
            const code = await runDroverVerb('check', ['--help']);
            expect(code).toBe(0);
        } finally {
            so.mockRestore();
        }
        expect(out.join('')).toContain('refuse a tree whose header comments have become commands');
    });
});

// --- the shell verb, byte for byte -------------------------------------------

describe.skipIf(!haveTree || !existsSync(shellVerb))('drover check — prints what libexec/drover-check printed, byte for byte', () => {
    /** Run the shell checker inside a tree of its own, so its `dirname` root is that tree. */
    function shell(verb: string, args: string[]): { code: number | null; out: string; err: string } {
        const env = { ...process.env };
        refuseRealHappyHome(env, 'the shell verb spawn');
        const r = spawnSync(verb, args, { env, encoding: 'utf8' });
        return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
    }

    it('agrees on named files: the typo, the prose line, the heredocs, a python script', async () => {
        const cases: string[][] = [
            [revertedTypo()],
            [proseOnly()],
            [
                join(realRoot, 'libexec', 'drover-accounts'),
                join(realRoot, 'libexec', 'drover-cursor'),
                join(realRoot, 'libexec', 'drover-cursor-login'),
                join(realRoot, 'libexec', 'drover-sync-commands'),
            ],
            ['-q', revertedTypo(join(work, 'quiet-typo'))],
        ];
        const py = join(work, 'py');
        writeFileSync(py, '#!/usr/bin/env python3\n# doc\n  still_doc_but_indented\nx = 1\n');
        cases.push([py]);
        for (const args of cases) {
            const s = shell(shellVerb, args);
            const n = await capture(args);
            expect(n.code, args.join(' ')).toBe(s.code);
            expect(n.out, args.join(' ')).toBe(s.out);
            expect(n.err, args.join(' ')).toBe(s.err);
        }
    });

    it('agrees on the flags: --help, -h, an unknown argument', async () => {
        for (const args of [['--help'], ['-h'], ['--nope'], ['-x']]) {
            const s = shell(shellVerb, args);
            const n = await capture(args);
            expect(n.code, args.join(' ')).toBe(s.code);
            expect(n.out, args.join(' ')).toBe(s.out);
            expect(n.err, args.join(' ')).toBe(s.err);
        }
    });

    it('agrees on a whole tree, clean and broken, over the default list', async () => {
        // realpath, because the shell verb takes its root from
        // `dirname "$(realpath "$0")"` and macOS puts a temp dir under
        // /private/var while $TMPDIR spells it /var. Same tree, two spellings,
        // and FILENAME is whatever was handed in.
        const tree = realpathSync(fakeTree());
        const treeVerb = join(tree, 'libexec', 'drover-check');
        // The shell verb takes its root from its own dirname; the node verb
        // takes it from DROVER_DIR. Point both at the same throwaway tree.
        for (const args of [[], ['-q']]) {
            const s = shell(treeVerb, args);
            const n = await capture(args, treeEnv(tree));
            expect(n.code, `clean ${args.join(' ')}`).toBe(s.code);
            expect(n.out, `clean ${args.join(' ')}`).toBe(s.out);
            expect(n.err, `clean ${args.join(' ')}`).toBe(s.err);
        }
        revertedTypo(join(tree, 'libexec', 'drover-account'));
        for (const args of [[], ['-q']]) {
            const s = shell(treeVerb, args);
            const n = await capture(args, treeEnv(tree));
            expect(n.code, `broken ${args.join(' ')}`).toBe(1);
            expect(n.code, `broken ${args.join(' ')}`).toBe(s.code);
            expect(n.out, `broken ${args.join(' ')}`).toBe(s.out);
            expect(n.err, `broken ${args.join(' ')}`).toBe(s.err);
        }
    });

    /**
     * THE OWNER SWEEP, which the node arm did not have until DROVE-315 wave 4.
     *
     * `check` is owner=node, so a hand-typed `drover check` ran an arm that
     * read headers and said "headers clean" while the shell file it replaced
     * had grown a second sweep — and the node arm's own --help still advertised
     * it. `make lint` calls libexec/drover-check by path, so CI never lost the
     * guard; the verb Clay types did.
     *
     * Each case drifts ONE thing, so the report is a single line and the
     * comparison can be byte for byte. The multi-drift case is compared as a
     * SET, because awk's `for (v in array)` has no defined order and the node
     * arm deliberately sorts.
     */
    it('agrees on the owner table, one drift at a time', async () => {
        const tree = realpathSync(fakeTree());
        const treeVerb = join(tree, 'libexec', 'drover-check');
        const drover = join(tree, 'bin', 'drover');
        const pristine = readFileSync(drover, 'utf8');

        const drifts: { name: string; apply: () => void }[] = [
            {
                name: 'a libexec file with no row at all',
                apply: () => writeFileSync(join(tree, 'libexec', 'drover-zzz'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }),
            },
            {
                name: 'a row whose libexec file is gone',
                apply: () => rmSync(join(tree, 'libexec', 'drover-mcps')),
            },
            {
                name: 'a node-owned verb nothing routes',
                apply: () => writeFileSync(drover, pristine.split('\n')
                    .filter((l) => l.trim() !== 'run_node mcps "$@" || :')
                    .join('\n')),
            },
            {
                name: 'a shell-owned verb that IS routed',
                apply: () => writeFileSync(drover, pristine.replace(
                    '\trun "$libexec/drover-settings" "$@"',
                    '\trun_node settings "$@" || :\n\trun "$libexec/drover-settings" "$@"',
                )),
            },
        ];

        for (const { name, apply } of drifts) {
            writeFileSync(drover, pristine, { mode: 0o755 });
            apply();
            const s = shell(treeVerb, []);
            const n = await capture([], treeEnv(tree));
            expect(n.code, name).toBe(1);
            expect(n.code, name).toBe(s.code);
            expect(n.out, name).toBe(s.out);
            expect(n.err, name).toBe(s.err);
            // Not two empty complaints: the explanation block is really there.
            expect(n.err, name).toContain("bin/drover's owner table and libexec/ have drifted");
            // Put the tree back for the next case.
            writeFileSync(drover, pristine, { mode: 0o755 });
            rmSync(join(tree, 'libexec', 'drover-zzz'), { force: true });
            if (!existsSync(join(tree, 'libexec', 'drover-mcps'))) {
                writeFileSync(
                    join(tree, 'libexec', 'drover-mcps'),
                    readFileSync(join(realRoot, 'libexec', 'drover-mcps')),
                    { mode: 0o755 },
                );
            }
        }
    });

    it('finds the same SET of drifts when there are several, whatever the order', async () => {
        const tree = realpathSync(fakeTree());
        const treeVerb = join(tree, 'libexec', 'drover-check');
        const drover = join(tree, 'bin', 'drover');
        writeFileSync(join(tree, 'libexec', 'drover-zzz'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        writeFileSync(join(tree, 'libexec', 'drover-yyy'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        writeFileSync(drover, readFileSync(drover, 'utf8').split('\n')
            .filter((l) => l.trim() !== 'run_node mcps "$@" || :')
            .join('\n'), { mode: 0o755 });

        const s = shell(treeVerb, []);
        const n = await capture([], treeEnv(tree));
        expect(n.code).toBe(1);
        expect(n.code).toBe(s.code);
        const lines = (text: string): string[] => text.split('\n').filter((l) => l.startsWith('drover-check: ')).sort();
        expect(lines(n.err)).toEqual(lines(s.err));
        // Not an empty agreement: all three planted drifts are named.
        expect(lines(n.err).join('\n')).toContain('libexec/drover-zzz has no row');
        expect(lines(n.err).join('\n')).toContain('libexec/drover-yyy has no row');
        expect(lines(n.err).join('\n')).toContain('nothing calls run_node mcps');
        // And the explanation block, byte for byte, is the same paragraph.
        const why = (text: string): string => text.split('\n').filter((l) => !l.startsWith('drover-check: ')).join('\n');
        expect(why(n.err)).toBe(why(s.err));
    });

    it('the sweep is skipped for named files and under -q, exactly as the shell skips it', async () => {
        const tree = realpathSync(fakeTree());
        const treeVerb = join(tree, 'libexec', 'drover-check');
        // A drift the full run WOULD catch...
        writeFileSync(join(tree, 'libexec', 'drover-zzz'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        expect((await capture([], treeEnv(tree))).code).toBe(1);
        // ...and neither of the two exempt shapes pays for it. -q is the CLI
        // start path (DROVE-314); a named file means the run is about that file.
        for (const args of [['-q'], [join(tree, 'libexec', 'drover-zzz')]]) {
            const s = shell(treeVerb, args);
            const n = await capture(args, treeEnv(tree));
            expect(n.code, args.join(' ')).toBe(0);
            expect(n.code, args.join(' ')).toBe(s.code);
            expect(n.out, args.join(' ')).toBe(s.out);
            expect(n.err, args.join(' ')).toBe(s.err);
        }
    });

    it('a file it cannot open fails the same way, and names the file it could not read', async () => {
        // The one place the two differ by a word: awk said `awk: can't open
        // file X` because awk is what opened it. There is no awk here, so the
        // checker says so in its own name. Same exit code, same explanation
        // block, same file named.
        const missing = join(work, 'not-there');
        const s = shell(shellVerb, [missing]);
        const n = await capture([missing]);
        expect(n.code).toBe(1);
        expect(n.code).toBe(s.code);
        expect(n.out).toBe(s.out);
        expect(n.err).toContain(`drover-check: can't open file ${missing}`);
        expect(s.err).toContain(`can't open file ${missing}`);
        // Everything after the first line -- the explanation block -- is identical.
        const tail = (t: string): string => t.slice(t.indexOf('\ndrover-check: the lines above'));
        expect(tail(n.err)).toBe(tail(s.err));
        expect(basename(missing)).toBe('not-there');
    });
});
