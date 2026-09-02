/**
 * The vitest twin of cattle-drover/tests/stale.bats (DROVE-315).
 *
 * stale.bats is the spec for `drover stale-sessions` and it stays green until
 * the shell file leaves. Every test there is here, one for one, against the
 * same injected doors — DROVER_STALE_ROWS, DROVER_STALE_SERVICE_ROWS,
 * DROVER_STALE_DIST_MTIME — and the same sentences. No process is inspected:
 * the Probe handed to every report test THROWS, so a scan that reached for ps,
 * tmux or launchctl would fail the test rather than quietly read Clay's real
 * sessions and services while he is working.
 *
 * On top of the bats, one differential test runs the SHELL verb on the same
 * rows and compares its stdout byte for byte with the node verb's, so the port
 * cannot drift a character from what the ship loop printed before it. And one
 * runs the BUILT ENTRY — `node dist/index.mjs stale-sessions`, the way the
 * verb is actually reached — under a throwaway HOME and HAPPY_HOME_DIR, with
 * a resolve hook listing every chunk the run loads.
 *
 * Nothing here may reach ~/.happy. HAPPY_HOME_DIR is pinned to a throwaway
 * directory before the first import, checked again at every run and every
 * spawn, and the modules a session registration goes through are mocked to
 * THROW on import. The pin below says which night made that necessary.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { droverEnv } from './env';
import {
    fmtLocal,
    parseEtime,
    run,
    staleCodeMtime,
    staleServicePid,
    staleStartedAt,
    deadRegistered,
    renderDeadReport,
    staleLedgerFile,
    staleTranscriptOf,
    type LedgerRegistry,
    type Probe,
} from './stale-sessions';
import {
    readLedger,
    type ArchiveAnswer,
    type ArchiveTransport,
    type LedgerCrypto,
    type ServerSession,
} from './happyLedger';

/**
 * A throwaway HAPPY_HOME_DIR, pinned above every import.
 *
 * On 2026-09-01 the startup benchmarks for this port spawned
 * `node dist/index.mjs --version` against a base that predated DROVE-314,
 * where --version printed the version and went on into authAndEnsureDaemon()
 * and runClaude(). No bench had set HAPPY_HOME_DIR, so each spawn read the
 * real ~/.happy/access.key and registered a real session with the real
 * daemon: seventy-eight of them from this worktree, on Clay's phone. Later the
 * same night a probe passed `stale-sessions --help` as ONE token (zsh does not
 * split an unquoted variable), the entry took the unknown word to Claude as it
 * always has, and two more were registered. The verb never touches ~/.happy
 * and this file never spawned the entry, but the leak came from the same tree
 * and nothing in it said no. This does.
 *
 * vi.hoisted runs before the static imports, so the pin is in place before
 * ./stale-sessions, or anything it might one day import, is evaluated. The
 * guard is applied again at every boundary a session could be registered
 * across: each in-process run, each spawn of the shell verb, each spawn of the
 * built entry. Unset resolves to ~/.happy too, and is refused too.
 */
const { happyHome, realHappyHome } = await vi.hoisted(async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const realHappyHome = path.join(os.homedir(), '.happy');
    const happyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-sessions-happy-'));
    process.env.HAPPY_HOME_DIR = happyHome;
    return { happyHome, realHappyHome };
});

// The modules a session registration goes through. The verb imports none of
// them; a factory that throws turns a future import into a failure of this
// whole file at load, instead of a test that quietly reads ~/.happy.
vi.mock('../../configuration', () => {
    throw new Error('stale-sessions.test: configuration (the ~/.happy reader) was imported; the verb must not reach the session machinery');
});
vi.mock('../../persistence', () => {
    throw new Error('stale-sessions.test: persistence (access.key, settings) was imported; the verb must not reach the session machinery');
});
vi.mock('../../api/api', () => {
    throw new Error('stale-sessions.test: api/api (session registration) was imported; the verb must not reach the session machinery');
});
vi.mock('../../claude/runClaude', () => {
    throw new Error('stale-sessions.test: claude/runClaude was imported; the verb must not reach the session machinery');
});

type Env = Record<string, string | undefined>;

/** Where HAPPY_HOME_DIR points, read the way configuration.ts reads it: unset is ~/.happy, a leading ~ is home. */
function happyHomeOf(env: Env): string {
    const raw = env.HAPPY_HOME_DIR;
    return raw ? resolve(raw.replace(/^~/, homedir())) : resolve(realHappyHome);
}

/**
 * Refuse an environment whose HAPPY_HOME_DIR is the real one. Thrown rather
 * than expect()ed so it fires inside helpers and fails the file, not one test.
 */
function refuseRealHappyHome(env: Env, where: string): void {
    if (happyHomeOf(env) === resolve(realHappyHome)) {
        throw new Error(
            `${where}: HAPPY_HOME_DIR resolves to the real ${realHappyHome} (it is ${env.HAPPY_HOME_DIR ?? 'unset'}). `
            + 'Anything that reached the entry from here would register sessions on the real daemon. Refusing.',
        );
    }
}

/** The files a session start leaves under a HAPPY_HOME_DIR. A debug log under logs/ is not one of them. */
const REGISTRATION_FILES = ['access.key', 'daemon.state.json', 'daemon.state.json.lock', 'sessions.json', 'settings.json'];

function registrationFilesUnder(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => REGISTRATION_FILES.includes(f));
}

beforeAll(() => {
    refuseRealHappyHome(process.env, 'stale-sessions.test');
    if (happyHomeOf(process.env) !== happyHome) {
        throw new Error(`stale-sessions.test: HAPPY_HOME_DIR moved off the pin (it is ${process.env.HAPPY_HOME_DIR}); refusing to run`);
    }
});

afterAll(() => {
    // Nothing in this file registered anything, or created anything: the
    // pinned home is exactly as empty as mkdtemp made it. Merely loading
    // configuration.ts would have put a logs/ here.
    refuseRealHappyHome(process.env, 'stale-sessions.test (afterAll)');
    expect(existsSync(happyHome) ? readdirSync(happyHome) : []).toEqual([]);
    rmSync(happyHome, { recursive: true, force: true });
});

/** A Probe that proves nothing on this machine is asked. */
const noProbe: Probe = {
    etime: () => {
        throw new Error('ps was asked');
    },
    envDump: () => {
        throw new Error('ps -E was asked');
    },
    processes: () => {
        throw new Error('ps -ax was asked');
    },
    children: () => {
        throw new Error('ps -ax (ppid) was asked');
    },
    tmuxSession: () => {
        throw new Error('tmux was asked');
    },
    launchctlList: () => {
        throw new Error('launchctl was asked');
    },
};

/**
 * The bats' `date -r <epoch> '+%Y-%m-%d %H:%M:%S'`, computed a different way
 * from the verb's own formatter so the two are not one function agreeing with
 * itself: sv-SE is the locale whose default date string is ISO-shaped.
 */
function local(epoch: number): string {
    return new Date(epoch * 1000).toLocaleString('sv-SE', { hourCycle: 'h23' }).replace('T', ' ');
}

interface Captured {
    code: number;
    out: string;
    err: string;
    lines: string[];
}

async function capture(args: string[], env: Env, probe: Probe = noProbe, uid: number = 501): Promise<Captured> {
    refuseRealHappyHome(process.env, 'capture');
    const out: string[] = [];
    const err: string[] = [];
    const so = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => (out.push(String(c)), true));
    const se = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => (err.push(String(c)), true));
    try {
        const code = await run(args, { env, probe, uid: () => uid });
        const text = out.join('');
        return { code, out: text, err: err.join(''), lines: text.split('\n').filter((l) => l !== '') };
    } finally {
        so.mockRestore();
        se.mockRestore();
    }
}

describe('drover stale-sessions — the report (stale.bats, against injected rows)', () => {
    let dir: string;
    let rows: string;
    let srows: string;
    let build: number;
    let env: Record<string, string | undefined>;

    // row <pid> <started-before-build-seconds> <supervised> <id> <name>
    const row = (pid: number, before: number, sup: number, id: string, name: string): void => {
        writeFileSync(rows, `${pid}\t${build - before}\t${sup}\t${id}\t${name}\n`, { flag: 'a' });
    };
    // srow <name> <start-epoch> <code-mtime-epoch>
    const srow = (name: string, at: number, mtime: number): void => {
        writeFileSync(srows, `${name}\t${at}\t${mtime}\tcom.bitspur.cattle-drover.${name}\n`, { flag: 'a' });
    };

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'stale-'));
        rows = join(dir, 'rows');
        srows = join(dir, 'srows');
        writeFileSync(rows, '');
        // Service rows too, and an EMPTY file on purpose: with the variable
        // set the scan reads only injected rows.
        writeFileSync(srows, '');
        // A build that finished at a round, recent moment.
        build = Math.floor(Date.now() / 1000) - 600;
        env = {
            HOME: dir,
            STATE_DIR: dir,
            DROVER_DIR: dir,
            DROVER_FORK_CLI: join(dir, 'happy-cli'),
            DROVER_STALE_ROWS: rows,
            DROVER_STALE_SERVICE_ROWS: srows,
            DROVER_STALE_DIST_MTIME: String(build),
        };
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('a session started before the build is named', async () => {
        row(4242, 3600, 0, '19c2f0a8-f803-4cb8-8bee-c68b6773e412', 'selfhosted-cloud:cattle-drover');
        const r = await capture([], env);
        expect(r.code).toBe(0);
        expect(r.out).toContain('selfhosted-cloud:cattle-drover');
        expect(r.out).toContain('19c2f0a8');
    });

    it('the report names BOTH timestamps, not just the session\'s', async () => {
        // DROVE-220. The diagnosis is one comparison and it takes two numbers.
        row(4242, 3600, 1, '19c2f0a8-f803-4cb8-8bee-c68b6773e412', 'cattle-drover:cattle-drover');
        const r = await capture([], env);
        expect(r.code).toBe(0);
        expect(r.out).toContain(`dist/index.mjs was written ${local(build)}`);
        expect(r.out).toContain(`started ${local(build - 3600)}`);
    });

    it('a session started after the build is not named', async () => {
        // THE regression that matters in the other direction: a report that
        // cries stale about a session already on the new bundle is a report
        // nobody reads by the third build.
        writeFileSync(rows, `4243\t${build + 30}\t1\t-\tfresh-one\n`, { flag: 'a' });
        const r = await capture([], env);
        expect(r.code).toBe(0);
        expect(r.out).not.toContain('fresh-one');
        expect(r.out).toContain('every running session is on the build that just finished');
    });

    it('a supervised session is told it fixes itself, an unsupervised one is given the command', async () => {
        row(1, 3600, 1, 'aaaaaaaa-0000-0000-0000-000000000000', 'supervised-one');
        row(2, 3600, 0, 'bbbbbbbb-0000-0000-0000-000000000000', 'manual-one');
        const r = await capture([], env);
        expect(r.code).toBe(0);
        expect(r.out).toContain('picks the new bundle up when its current turn ends');
        expect(r.out).toContain('drover --resume bbbbbbbb-0000-0000-0000-000000000000');
    });

    it('a session with no transcript id yet is still named, without a resume command', async () => {
        // Before the SessionStart hook fires there is nothing to resume ONTO,
        // so offering `drover --resume -` would be a command that cannot work.
        row(3, 60, 0, '-', 'just-started');
        const r = await capture([], env);
        expect(r.code).toBe(0);
        expect(r.out).toContain('just-started');
        expect(r.out).toContain('restart it by hand');
        expect(r.out).not.toContain('resume -');
    });

    it('the count is the number of stale sessions, not of rows', async () => {
        row(1, 3600, 0, 'aaaaaaaa-0000-0000-0000-000000000000', 'old-one');
        row(2, 3600, 1, 'bbbbbbbb-0000-0000-0000-000000000000', 'old-two');
        writeFileSync(rows, `3\t${build + 5}\t1\t-\tnew-one\n`, { flag: 'a' });
        const r = await capture([], env);
        expect(r.code).toBe(0);
        expect(r.out).toContain('2 running session(s) started BEFORE that');
        expect(r.out).not.toContain('new-one');
    });

    it('the session lines are the shell\'s printf, column for column', async () => {
        // '  %-32s %-9s started %s · %s' — the name padded to 32, the first
        // eight of the id padded to 9, then both timestamps' sentence.
        row(1, 3600, 0, 'aaaaaaaa-0000-0000-0000-000000000000', 'old-one');
        row(2, 3600, 1, '-', 'a-name-that-is-longer-than-thirty-two-columns');
        const r = await capture([], env);
        expect(r.lines).toEqual([
            `drover: dist/index.mjs was written ${local(build)}.`,
            'drover: 2 running session(s) started BEFORE that — they are on the old CLI:',
            `  old-one                          aaaaaaaa  started ${local(build - 3600)} · NOT supervised — drover --resume aaaaaaaa-0000-0000-0000-000000000000`,
            `  a-name-that-is-longer-than-thirty-two-columns -         started ${local(build - 3600)} · picks the new bundle up when its current turn ends`,
            'drover: a session on old code behaves exactly as if the fix never shipped. Say so before calling it live.',
        ]);
    });

    it('--raw emits only the stale rows, tab separated', async () => {
        row(1, 3600, 0, 'aaaaaaaa-0000-0000-0000-000000000000', 'old-one');
        writeFileSync(rows, `3\t${build + 5}\t1\t-\tnew-one\n`, { flag: 'a' });
        const r = await capture(['--raw'], env);
        expect(r.code).toBe(0);
        expect(r.lines).toHaveLength(1);
        expect(r.lines[0]).toBe(`1\t${build - 3600}\t0\taaaaaaaa-0000-0000-0000-000000000000\told-one`);
    });

    it('--raw with no dist to compare against prints nothing and exits 0', async () => {
        row(1, 3600, 0, 'aaaaaaaa-0000-0000-0000-000000000000', 'old-one');
        const r = await capture(['--raw'], { ...env, DROVER_STALE_DIST_MTIME: '' });
        expect(r.code).toBe(0);
        expect(r.out).toBe('');
    });

    it('an unknown argument is refused rather than reported on', async () => {
        const r = await capture(['--wat'], env);
        expect(r.code).toBe(2);
        expect(r.err).toContain('unknown argument');
        expect(r.err).toBe('drover stale-sessions: unknown argument: --wat\n');
        expect(r.out).toBe('');
    });

    it('the report never fails the build that called it', async () => {
        // It is bolted onto `make build-cli`. A report that can exit non-zero
        // is a report that can be the reason a fix does not ship. With no
        // injected build time and no dist under DROVER_FORK_CLI there is
        // nothing to compare against, and it still exits 0 — saying so.
        row(4242, 3600, 0, '19c2f0a8-f803-4cb8-8bee-c68b6773e412', 'some-session');
        const r = await capture([], { ...env, DROVER_STALE_DIST_MTIME: '' });
        expect(r.code).toBe(0);
        expect(r.err).toBe('drover: no dist/index.mjs to compare running sessions against.\n');
        expect(r.out).toBe('');
    });

    it('with no injected build time the dist on disk is the one compared against', async () => {
        const cli = join(dir, 'happy-cli');
        mkdirSync(join(cli, 'dist'), { recursive: true });
        writeFileSync(join(cli, 'dist', 'index.mjs'), '');
        utimesSync(join(cli, 'dist', 'index.mjs'), build, build);
        row(1, 3600, 0, 'aaaaaaaa-0000-0000-0000-000000000000', 'old-one');
        writeFileSync(rows, `3\t${build + 5}\t1\t-\tnew-one\n`, { flag: 'a' });
        const r = await capture([], { ...env, DROVER_STALE_DIST_MTIME: '' });
        expect(r.code).toBe(0);
        expect(r.out).toContain(`dist/index.mjs was written ${local(build)}`);
        expect(r.out).toContain('1 running session(s) started BEFORE that');
        expect(r.out).not.toContain('new-one');
    });

    // --- launchd services ---------------------------------------------------

    it('a bus older than its code is called stale, plainly, with the kickstart', async () => {
        srow('bus', build - 3600, build);
        const r = await capture([], env);
        expect(r.code).toBe(0);
        expect(r.out).toContain('the bus is on old code');
        expect(r.out).toContain('launchctl kickstart -k gui/501/com.bitspur.cattle-drover.bus');
    });

    it('the service line carries BOTH timestamps, like the session lines', async () => {
        srow('bus', build - 3600, build);
        const r = await capture([], env);
        expect(r.code).toBe(0);
        expect(r.out).toContain(`started ${local(build - 3600)}`);
        expect(r.out).toContain(`written ${local(build)}`);
        expect(r.lines).toContain(
            `drover: the bus started ${local(build - 3600)} and the code it loads was written ${local(build)} — the bus is on old code. Kickstart it:`,
        );
    });

    it('a service started after its code was written is not accused', async () => {
        srow('bus', build + 30, build);
        srow('bridge', build + 30, build);
        const r = await capture([], env);
        expect(r.code).toBe(0);
        expect(r.out).not.toContain('on old code');
        expect(r.out).toContain('every running service (bus bridge) started after the code it loads was written');
    });

    it('the bridge and the daemon are held to the same comparison', async () => {
        srow('bridge', build - 7200, build);
        srow('daemon', build - 7200, build);
        const r = await capture([], env);
        expect(r.code).toBe(0);
        expect(r.out).toContain('the bridge is on old code');
        expect(r.out).toContain('the daemon is on old code');
        expect(r.out).toContain('com.bitspur.cattle-drover.bridge');
        expect(r.out).toContain('com.bitspur.cattle-drover.daemon');
        expect(r.out).toContain('a service on old code behaves exactly as if the fix never shipped. Kickstart before calling it live.');
    });

    it('no service rows means no service noise', async () => {
        // A box with nothing running (or no launchd at all) gets the session
        // report and not a word about services — drover status owns not-running.
        row(4242, 3600, 0, '19c2f0a8-f803-4cb8-8bee-c68b6773e412', 'some-session');
        const r = await capture([], env);
        expect(r.code).toBe(0);
        expect(r.out).not.toContain('service');
        expect(r.out).not.toContain('kickstart');
    });

    it('a stale service never fails the build either', async () => {
        srow('bus', build - 3600, build);
        const r = await capture([], env);
        expect(r.code).toBe(0);
    });

    it('session rows injected without service rows keep launchctl unasked', async () => {
        // The shell's rule: a suite running against invented sessions must not
        // inspect Clay's real services either. The probe here throws.
        row(4242, 3600, 0, '19c2f0a8-f803-4cb8-8bee-c68b6773e412', 'some-session');
        const r = await capture([], { ...env, DROVER_STALE_SERVICE_ROWS: undefined });
        expect(r.code).toBe(0);
        expect(r.out).toContain('some-session');
        expect(r.out).not.toContain('service');
    });
});

describe('drover stale-sessions — help answers before anything is looked at', () => {
    it('prints the usage and exits 0 for --help and -h, asking nothing of the machine', async () => {
        for (const flag of ['--help', '-h']) {
            const fetchSpy = vi.spyOn(globalThis, 'fetch');
            // No env, no rows, no dist: help must not need any of it.
            const r = await capture([flag], {});
            expect(r.code, flag).toBe(0);
            expect(r.err, flag).toBe('');
            expect(r.out, flag).toMatch(/^drover stale-sessions — sessions and services running code a change replaced\.\n/);
            expect(r.out, flag).toContain('drover stale-sessions --raw  One TAB row per session: pid, start epoch,');
            expect(r.out, flag).toContain('relaunches onto the new bundle the moment its current turn ends');
            expect(r.out.trimEnd(), flag).toMatch(/launchctl kickstart -k gui\/<uid>\/<label>\.$/);
            expect(fetchSpy, flag).not.toHaveBeenCalled();
            fetchSpy.mockRestore();
        }
    });
});

// --- the guards, proven armed ------------------------------------------------------
//
// A guard that has never been seen to fire is a promise. These fire it.

/** The innermost message of a failed import: vitest wraps a throwing mock factory, and the cause is ours. */
async function trapped(load: () => Promise<unknown>): Promise<string> {
    try {
        await load();
    } catch (e) {
        let err = e as { message?: string; cause?: unknown } | undefined;
        while (err && typeof err === 'object' && err.cause && typeof err.cause === 'object') err = err.cause as typeof err;
        return String(err?.message ?? e);
    }
    return '';
}

describe('drover stale-sessions — the guards are armed', () => {
    it('the pin holds: this file runs under a throwaway HAPPY_HOME_DIR, not ~/.happy', () => {
        expect(process.env.HAPPY_HOME_DIR).toBe(happyHome);
        expect(happyHome).not.toBe(realHappyHome);
        expect(happyHome.startsWith(realHappyHome)).toBe(false);
    });

    it('the guard refuses the real ~/.happy, whether spelled out, as ~, or left unset', () => {
        expect(() => refuseRealHappyHome({}, 'unset')).toThrow(/resolves to the real/);
        expect(() => refuseRealHappyHome({ HAPPY_HOME_DIR: '~/.happy' }, 'tilde')).toThrow(/resolves to the real/);
        expect(() => refuseRealHappyHome({ HAPPY_HOME_DIR: join(homedir(), '.happy') }, 'spelled out')).toThrow(/resolves to the real/);
        expect(() => refuseRealHappyHome({ HAPPY_HOME_DIR: join(homedir(), '.happy', '..', '.happy') }, 'dotted')).toThrow(/resolves to the real/);
        expect(() => refuseRealHappyHome({ HAPPY_HOME_DIR: happyHome }, 'pinned')).not.toThrow();
    });

    it('importing the session machinery fails before it can read ~/.happy', async () => {
        expect(await trapped(() => import('../../configuration'))).toMatch(/configuration .* must not reach the session machinery/);
        expect(await trapped(() => import('../../persistence'))).toMatch(/persistence .* must not reach the session machinery/);
        expect(await trapped(() => import('../../api/api'))).toMatch(/api\/api .* must not reach the session machinery/);
        expect(await trapped(() => import('../../claude/runClaude'))).toMatch(/runClaude .* must not reach the session machinery/);
        // And none of those attempts created the home configuration.ts would have made.
        expect(existsSync(happyHome) ? readdirSync(happyHome) : []).toEqual([]);
    });
});

// --- the elapsed-time parse ------------------------------------------------------
//
// ps -o etime= is [[DD-]HH:]MM:SS, and the leading zeros in it were the trap:
// `08` is not a valid octal literal, so an unstripped $(( )) aborted the whole
// scan for nine minutes of every hour.

describe('drover stale-sessions — the elapsed-time parse', () => {
    it('elapsed time parses every ps shape, leading zeros included', () => {
        expect(parseEtime('45')).toBe(45);
        expect(parseEtime('09:08')).toBe(548);
        expect(parseEtime('01:02:03')).toBe(3723);
        expect(parseEtime('2-03:04:05')).toBe(183845);
        // ps pads the column; the shell's `tr -d ' '`.
        expect(parseEtime('   09:08\n')).toBe(548);
    });

    it('started-at subtracts the elapsed time from the clock it is given', () => {
        const probe = { ...noProbe, etime: () => '01:02:03' };
        expect(staleStartedAt('1', probe, () => 1_000_000_000)).toBe(1_000_000_000 - 3723);
    });

    it('a pid ps knows nothing about yields no row', () => {
        // ps prints nothing for a process that has exited between the scan and
        // the question. A row invented from an empty elapsed time would date
        // the session to right now and quietly call it fresh.
        const probe = { ...noProbe, etime: () => '' };
        expect(parseEtime('')).toBeNull();
        expect(staleStartedAt('999999', probe, () => 1_000_000_000)).toBeNull();
    });
});

// --- the transcript id -------------------------------------------------------------
//
// The report's whole use to a person is the `drover --resume <id>` at the end
// of the line. A session started fresh has no --resume in any argv, so reading
// argv alone left the one case that most needs the command without it.

describe('drover stale-sessions — the transcript id', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cfg-'));
        mkdirSync(join(dir, 'sessions'));
        writeFileSync(
            join(dir, 'sessions', '1.json'),
            '{"pid":1,"sessionId":"aaaaaaaa-0000-0000-0000-000000000000","tmux":"other:@1.%1"}\n',
        );
        writeFileSync(
            join(dir, 'sessions', '2.json'),
            '{"pid":2,"sessionId":"bbbbbbbb-0000-0000-0000-000000000000","tmux":"mine:@13.%13"}\n',
        );
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('the transcript id comes from Claude\'s own registry, joined on the pane', () => {
        expect(staleTranscriptOf(dir, '%13')).toBe('bbbbbbbb-0000-0000-0000-000000000000');
    });

    it('a pane no record claims yields no id rather than someone else\'s', () => {
        expect(staleTranscriptOf(dir, '%99')).toBe('');
    });

    it('a config dir with no sessions directory is not an error', () => {
        // A Claude older than the registry, or a flip onto an account that has
        // not started a session yet. The report still has to print.
        expect(staleTranscriptOf(join(tmpdir(), 'nope-' + process.pid), '%13')).toBe('');
    });

    it('an empty pane asks nothing and answers nothing', () => {
        expect(staleTranscriptOf(dir, '')).toBe('');
    });

    it('a record that is not JSON, or has no id, is skipped rather than fatal', () => {
        writeFileSync(join(dir, 'sessions', '0.json'), 'not json\n');
        writeFileSync(join(dir, 'sessions', '3.json'), '{"pid":3,"tmux":"x:@2.%13"}\n');
        expect(staleTranscriptOf(dir, '%13')).toBe('bbbbbbbb-0000-0000-0000-000000000000');
    });
});

// --- what the launchd half reads ----------------------------------------------------

describe('drover stale-sessions — the service scan\'s readers', () => {
    it('the newest mtime among a file and a directory\'s *.js is the code mtime', () => {
        const dir = mkdtempSync(join(tmpdir(), 'code-'));
        try {
            mkdirSync(join(dir, 'engine'));
            writeFileSync(join(dir, 'server.js'), '');
            writeFileSync(join(dir, 'engine', 'a.js'), '');
            writeFileSync(join(dir, 'engine', 'b.js'), '');
            writeFileSync(join(dir, 'engine', 'notes.md'), '');
            utimesSync(join(dir, 'server.js'), 1_700_000_000, 1_700_000_000);
            utimesSync(join(dir, 'engine', 'a.js'), 1_700_000_500, 1_700_000_500);
            utimesSync(join(dir, 'engine', 'b.js'), 1_700_000_200, 1_700_000_200);
            utimesSync(join(dir, 'engine', 'notes.md'), 1_700_009_999, 1_700_009_999);
            expect(staleCodeMtime([join(dir, 'server.js'), join(dir, 'engine')])).toBe('1700000500');
            expect(staleCodeMtime([join(dir, 'missing')])).toBe('');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('the service pid is launchctl\'s, parsed the way drover-status parses it', () => {
        const listing = '{\n\t"LimitLoadToSessionType" = "Aqua";\n\t"Label" = "com.bitspur.cattle-drover.bus";\n\t"PID" = 4242;\n\t"Program" = "/bin/sh";\n};\n';
        expect(staleServicePid('com.bitspur.cattle-drover.bus', { ...noProbe, launchctlList: () => listing })).toBe('4242');
        expect(staleServicePid('com.bitspur.cattle-drover.bus', { ...noProbe, launchctlList: () => '' })).toBe('');
    });
});

describe('drover stale-sessions — the date', () => {
    it('is the shell\'s local %Y-%m-%d %H:%M:%S, and ? for a value that is not an epoch', () => {
        expect(fmtLocal(1_700_000_000)).toBe(local(1_700_000_000));
        expect(fmtLocal('1700000000')).toBe(local(1_700_000_000));
        expect(fmtLocal('')).toBe('?');
        expect(fmtLocal('soon')).toBe('?');
    });
});

// --- the shell verb, byte for byte ----------------------------------------------------

const shellVerb = join(droverEnv().droverDir, 'libexec', 'drover-stale-sessions');

describe.skipIf(process.platform !== 'darwin' || !existsSync(shellVerb))(
    'drover stale-sessions — prints what the shell verb printed, byte for byte',
    () => {
        it('the report and --raw match libexec/drover-stale-sessions on the same rows', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'diff-'));
            try {
                const build = Math.floor(Date.now() / 1000) - 600;
                const rows = join(dir, 'rows');
                const srows = join(dir, 'srows');
                writeFileSync(
                    rows,
                    [
                        `1\t${build - 3600}\t0\taaaaaaaa-0000-0000-0000-000000000000\tselfhosted-cloud:cattle-drover`,
                        `2\t${build - 60}\t1\tbbbbbbbb-0000-0000-0000-000000000000\tcattle-drover:happy`,
                        `3\t${build - 5}\t0\t-\tjust-started`,
                        `4\t${build + 30}\t1\t-\tfresh-one`,
                        '',
                    ].join('\n'),
                );
                writeFileSync(
                    srows,
                    [
                        `bus\t${build - 3600}\t${build}\tcom.bitspur.cattle-drover.bus`,
                        `bridge\t${build + 30}\t${build}\tcom.bitspur.cattle-drover.bridge`,
                        `daemon\t${build - 7200}\t${build}\tcom.bitspur.cattle-drover.daemon`,
                        '',
                    ].join('\n'),
                );
                const env = {
                    ...process.env,
                    DROVER_FORK_CLI: join(dir, 'happy-cli'),
                    DROVER_STALE_ROWS: rows,
                    DROVER_STALE_SERVICE_ROWS: srows,
                    DROVER_STALE_DIST_MTIME: String(build),
                };
                refuseRealHappyHome(env, 'the shell verb spawn');
                const uid = process.getuid?.() ?? 0;
                for (const args of [[], ['--raw']]) {
                    const shell = spawnSync(shellVerb, args, { env, encoding: 'utf8' });
                    expect(shell.status, args.join(' ')).toBe(0);
                    const out: string[] = [];
                    const so = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => (out.push(String(c)), true));
                    const code = await run(args, { env, probe: noProbe, uid: () => uid });
                    so.mockRestore();
                    expect(code, args.join(' ')).toBe(0);
                    expect(out.join(''), args.join(' ')).toBe(shell.stdout);
                }
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    },
);

// --- the built entry, the way the verb is reached ------------------------------------------
//
// bin/drover routes the live name to libexec/ until its arm flips, so the port
// is reached as `drover.mjs stale-sessions`: the lazy arm in src/index.ts, the
// row in the table, the chunk pkgroll split out. Only the BUILT entry proves
// those three. And the 2026-09-01 leak was an entry going on into runClaude,
// so this is where that is refused: the same argv through the same entry,
// under a HOME and a HAPPY_HOME_DIR that are throwaway, with an ESM resolve
// hook recording every dist chunk the run loads. No session, auth or api
// chunk may load, and nothing may be registered under that home.

const distEntry = join(__dirname, '..', '..', '..', 'dist', 'index.mjs');

/** The chunks that mean the session machinery loaded: index.startup.test.ts's list. */
const HEAVY = /(?:runClaude|api-[A-Za-z0-9_]+\.[cm]js|codexCommand|persistence-|auth-[A-Za-z0-9_]+\.[cm]js)/;

interface EntryRun {
    status: number | null;
    stdout: string;
    stderr: string;
    /** Every dist chunk the run loaded, by basename. */
    chunks: string[];
    /** The registration files left under the run's throwaway HAPPY_HOME_DIR. */
    registered: string[];
}

function runEntry(args: string[], doors: Record<string, string>): EntryRun {
    const work = mkdtempSync(join(tmpdir(), 'stale-entry-'));
    try {
        const home = join(work, 'home');
        const happy = join(home, 'happy');
        mkdirSync(home, { recursive: true });
        const chunksOut = join(work, 'chunks.txt');
        writeFileSync(join(work, 'hook.mjs'), [
            'import fs from \'node:fs\';',
            'const out = process.env.CHUNKS_OUT;',
            'export async function resolve(specifier, context, nextResolve) {',
            '    const r = await nextResolve(specifier, context);',
            '    try {',
            '        if (out && /\\/dist\\/[^/]+\\.(mjs|cjs)$/.test(r.url)) fs.appendFileSync(out, r.url.split(\'/\').pop() + \'\\n\');',
            '    } catch {}',
            '    return r;',
            '}',
            '',
        ].join('\n'));
        writeFileSync(join(work, 'register.mjs'), 'import { register } from \'node:module\';\nregister(\'./hook.mjs\', import.meta.url);\n');
        // A scrubbed environment: PATH, a HOME that is nobody's, the doors, and
        // nothing inherited from the shell that ran vitest — not
        // CLAUDE_CONFIG_DIR, not DROVER_ACCOUNT, not TMUX_PANE.
        const env: Record<string, string> = {
            PATH: process.env.PATH ?? '',
            HOME: home,
            HAPPY_HOME_DIR: happy,
            CHUNKS_OUT: chunksOut,
            DROVER_DIR: work,
            STATE_DIR: work,
            DROVER_FORK_CLI: join(work, 'happy-cli'),
            ...doors,
        };
        refuseRealHappyHome(env, 'the entry spawn');
        const r = spawnSync(
            process.execPath,
            ['--no-warnings', '--no-deprecation', '--import', join(work, 'register.mjs'), distEntry, ...args],
            { encoding: 'utf8', input: '', timeout: 20_000, env },
        );
        const chunks = existsSync(chunksOut) ? [...new Set(readFileSync(chunksOut, 'utf8').split('\n').filter(Boolean))] : [];
        return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', chunks, registered: registrationFilesUnder(happy) };
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

describe('drover stale-sessions — through the built entry, registering nothing', () => {
    beforeAll(() => {
        if (!existsSync(distEntry)) {
            throw new Error(
                `${distEntry} is missing. Build the CLI before running this test `
                + '(`pnpm run build`, which `pnpm test` and vitest\'s global setup do for you).',
            );
        }
    });

    it('--help is the verb\'s own help, from its own chunk, with no session chunk loaded', async () => {
        const entry = runEntry(['stale-sessions', '--help'], {});
        const inProcess = await capture(['--help'], {});
        expect(entry.status, entry.stderr).toBe(0);
        expect(entry.stdout).toBe(inProcess.out);
        expect(entry.chunks.some((c) => c.startsWith('stale-sessions-')), entry.chunks.join(', ')).toBe(true);
        expect(entry.chunks.filter((c) => HEAVY.test(c))).toEqual([]);
        expect(entry.registered).toEqual([]);
    });

    it('the report and --raw match the in-process verb byte for byte, and load no session chunk', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'entry-rows-'));
        try {
            const build = Math.floor(Date.now() / 1000) - 600;
            const rows = join(dir, 'rows');
            const srows = join(dir, 'srows');
            writeFileSync(rows, [
                `1\t${build - 3600}\t0\taaaaaaaa-0000-0000-0000-000000000000\tselfhosted-cloud:cattle-drover`,
                `2\t${build - 60}\t1\tbbbbbbbb-0000-0000-0000-000000000000\tcattle-drover:happy`,
                `3\t${build + 30}\t1\t-\tfresh-one`,
                '',
            ].join('\n'));
            writeFileSync(srows, [
                `bus\t${build - 3600}\t${build}\tcom.bitspur.cattle-drover.bus`,
                `daemon\t${build + 30}\t${build}\tcom.bitspur.cattle-drover.daemon`,
                '',
            ].join('\n'));
            const doors = { DROVER_STALE_ROWS: rows, DROVER_STALE_SERVICE_ROWS: srows, DROVER_STALE_DIST_MTIME: String(build) };
            const uid = process.getuid?.() ?? 0;
            for (const args of [[], ['--raw']]) {
                const entry = runEntry(['stale-sessions', ...args], doors);
                const inProcess = await capture(
                    args,
                    { HOME: dir, STATE_DIR: dir, DROVER_DIR: dir, DROVER_FORK_CLI: join(dir, 'happy-cli'), ...doors },
                    noProbe,
                    uid,
                );
                expect(entry.status, `${args.join(' ')}: ${entry.stderr}`).toBe(0);
                expect(entry.stdout, args.join(' ')).toBe(inProcess.out);
                expect(entry.chunks.filter((c) => HEAVY.test(c)), args.join(' ')).toEqual([]);
                expect(entry.registered, args.join(' ')).toEqual([]);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// --- the dead sessions the daemon still lists (DROVE-389) --------------------------
//
// A harness session the daemon registered stays 'running' on the phone until
// something archives it, and when its process was killed nothing ever does.
// The report names them; --archive retires them the way the Archive button
// does. Everything here is against a ledger of this test's own and a registry
// that answers from fixtures and records what was written.

describe('drover stale-sessions — the dead sessions the daemon still lists', () => {
    const NOW = Date.now();
    const KEY = Buffer.alloc(32, 7).toString('base64');
    const B = 'bbbbbbbb-0000-0000-0000-000000000000';
    const C = 'cccccccc-0000-0000-0000-000000000000';
    const L = 'llllllll-0000-0000-0000-000000000000';
    const K = 'kkkkkkkk-0000-0000-0000-000000000000';
    const DEAD_PID = 2 ** 22 - 1;
    const DEAD_PID_2 = 2 ** 22 - 2;

    const plainCrypto: LedgerCrypto = {
        encrypt: (_key, _variant, data) => new Uint8Array(Buffer.from(JSON.stringify(data), 'utf8')),
        decrypt: (_key, _variant, data) => JSON.parse(Buffer.from(data).toString('utf8')) as unknown,
        encodeBase64: (b) => Buffer.from(b).toString('base64'),
        decodeBase64: (s) => new Uint8Array(Buffer.from(s, 'base64')),
    };
    const blob = (data: unknown): string => plainCrypto.encodeBase64(plainCrypto.encrypt(new Uint8Array(), 'legacy', data));

    const entry = (md: Record<string, unknown>, savedAt: number): Record<string, unknown> => ({
        agentStateVersion: 0, encryptionKey: KEY, encryptionVariant: 'legacy', metadata: md, metadataVersion: 1, savedAt, seq: 0,
    });
    const LEDGER = {
        sessions: {
            [B]: entry({ path: '/Users/x/two', hostPid: DEAD_PID, startedBy: 'daemon', lifecycleState: 'running', name: 'fix the build', flavor: 'codex' }, NOW - 2000),
            [C]: entry({ path: '/Users/x/three', hostPid: DEAD_PID_2, startedBy: 'terminal', lifecycleState: 'running', flavor: 'opencode' }, NOW - 1000),
            [L]: entry({ path: '/Users/x/live', hostPid: process.pid, lifecycleState: 'running', name: 'still going', flavor: 'cursor' }, NOW - 500),
            [K]: entry({ path: '/Users/x/claude', hostPid: DEAD_PID, lifecycleState: 'running', name: 'a claude that ended', flavor: 'claude' }, NOW - 400),
        },
    };

    interface Fake extends LedgerRegistry {
        listCalls: number;
        updates: Array<{ sid: string; expectedVersion: number; metadata: unknown }>;
        archived: string[];
        closed: number;
    }

    /** A registry that lists from a fixture, answers updateMetadata from a script, and records every write. */
    function fake(listed: ServerSession[] | Error, answers: ArchiveAnswer[] = [], transportError?: Error): Fake {
        const f: Fake = {
            listCalls: 0,
            updates: [],
            archived: [],
            closed: 0,
            async list() {
                f.listCalls++;
                if (listed instanceof Error) throw listed;
                return listed;
            },
            async transport() {
                if (transportError) throw transportError;
                const t: ArchiveTransport = {
                    async updateMetadata(sid, expectedVersion, metadata) {
                        f.updates.push({ sid, expectedVersion, metadata: JSON.parse(Buffer.from(metadata, 'base64').toString('utf8')) });
                        return answers.shift() ?? { result: 'success' };
                    },
                    async archive(sid) {
                        f.archived.push(sid);
                        return true;
                    },
                    close() {
                        f.closed++;
                    },
                };
                return t;
            },
            async crypto() {
                return plainCrypto;
            },
        };
        return f;
    }

    let dir: string;
    let ledger: string;
    let home: string;
    let env: Env;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'stale-dead-'));
        ledger = join(dir, 'sessions.json');
        home = join(dir, 'happy');
        mkdirSync(home);
        writeFileSync(ledger, JSON.stringify(LEDGER));
        writeFileSync(join(home, 'access.key'), JSON.stringify({ token: 't0k' }));
        const rows = join(dir, 'rows');
        const srows = join(dir, 'srows');
        writeFileSync(rows, '');
        writeFileSync(srows, '');
        env = {
            HOME: dir,
            STATE_DIR: dir,
            DROVER_DIR: dir,
            DROVER_FORK_CLI: join(dir, 'happy-cli'),
            DROVER_STALE_ROWS: rows,
            DROVER_STALE_SERVICE_ROWS: srows,
            DROVER_STALE_DIST_MTIME: String(Math.floor(NOW / 1000) - 600),
            DROVER_STALE_LEDGER: ledger,
            HAPPY_HOME_DIR: home,
            HAPPY_SERVER_URL: 'http://srv',
        };
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    async function run2(args: string[], e: Env, registry: LedgerRegistry): Promise<Captured> {
        refuseRealHappyHome(process.env, 'run2');
        const out: string[] = [];
        const err: string[] = [];
        const so = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => (out.push(String(c)), true));
        const se = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => (err.push(String(c)), true));
        try {
            const code = await run(args, { env: e, probe: noProbe, uid: () => 501, registry });
            const text = out.join('');
            return { code, out: text, err: err.join(''), lines: text.split('\n').filter((l) => l !== '') };
        } finally {
            so.mockRestore();
            se.mockRestore();
        }
    }

    it('which ledger: the named one, else silence under injected rows, else the happy home\'s', () => {
        expect(staleLedgerFile({ DROVER_STALE_LEDGER: '/l', DROVER_STALE_ROWS: '/r' }, '/Users/x')).toBe('/l');
        expect(staleLedgerFile({ DROVER_STALE_ROWS: '/r' }, '/Users/x')).toBeNull();
        expect(staleLedgerFile({ HAPPY_HOME_DIR: '/h' }, '/Users/x')).toBe('/h/sessions.json');
    });

    it('deadRegistered: a harness session whose pid is gone, never claude, never one already archived, newest first', () => {
        const alive = (pid: number | null): boolean => pid === process.pid;
        const dead = deadRegistered(readLedger(ledger, NOW), alive);
        expect(dead.map((e) => e.id)).toEqual([C, B]);
        const report = renderDeadReport(dead, new Set([C]));
        expect(report).toEqual([
            'drover: 1 registered session(s) whose process is gone are still running on the phone:',
            `  codex    bbbbbbbb  pid ${DEAD_PID} gone · fix the build`,
            'drover: the watch shows each as active until it is archived. Retire them with: drover stale-sessions --archive',
        ]);
        expect(renderDeadReport(dead, new Set([B, C]))).toEqual([]);
    });

    it('with rows injected and no ledger named, the half is silent and --archive says so, and the server is never asked', async () => {
        const registry = fake([]);
        const quiet = { ...env, DROVER_STALE_LEDGER: undefined };
        const report = await run2([], quiet, registry);
        expect(report.code).toBe(0);
        expect(report.out).not.toContain('registered session');
        const archive = await run2(['--archive'], quiet, registry);
        expect(archive.code).toBe(0);
        expect(archive.out).toBe('drover: rows are injected (DROVER_STALE_ROWS) and no ledger is named (DROVER_STALE_LEDGER); nothing archived.\n');
        expect(registry.listCalls).toBe(0);
    });

    it('the report names each dead codex and opencode with its pid, after the stale sections; the live cursor and the claude are not named', async () => {
        const registry = fake([]);
        const r = await run2([], env, registry);
        expect(r.code).toBe(0);
        expect(registry.listCalls).toBe(1);
        const at = r.lines.indexOf('drover: 2 registered session(s) whose process is gone are still running on the phone:');
        expect(at).toBeGreaterThan(0);
        expect(r.lines.slice(at)).toEqual([
            'drover: 2 registered session(s) whose process is gone are still running on the phone:',
            `  opencode cccccccc  pid ${DEAD_PID_2} gone · /Users/x/three`,
            `  codex    bbbbbbbb  pid ${DEAD_PID} gone · fix the build`,
            'drover: the watch shows each as active until it is archived. Retire them with: drover stale-sessions --archive',
        ]);
        expect(r.out).not.toContain('still going');
        expect(r.out).not.toContain('a claude that ended');
        expect(r.err).toBe('');
    });

    it('one the server has already archived is not named; when every dead one is, the section is absent', async () => {
        const one = fake([{ id: C, active: false, activeAt: 1, updatedAt: 1, metadata: blob({ lifecycleState: 'archived' }), metadataVersion: 2 }]);
        const r = await run2([], env, one);
        expect(r.out).toContain('1 registered session(s) whose process is gone');
        expect(r.out).not.toContain('cccccccc');
        expect(r.out).toContain('bbbbbbbb');
        const both = fake([
            { id: C, active: false, activeAt: 1, updatedAt: 1, metadata: blob({ lifecycleState: 'archived' }), metadataVersion: 2 },
            { id: B, active: false, activeAt: 1, updatedAt: 1, metadata: blob({ lifecycleState: 'archived' }), metadataVersion: 2 },
        ]);
        const none = await run2([], env, both);
        expect(none.out).not.toContain('registered session');
    });

    it('when the server cannot be asked, the report says why and still names them', async () => {
        const down = await run2([], env, fake(new Error('http://srv did not answer within 5s')));
        expect(down.code).toBe(0);
        expect(down.out).toContain('drover: 2 registered session(s) whose process is gone may still be running on the phone, but the happy server was not asked (the happy server did not answer (http://srv did not answer within 5s)):');
        expect(down.out).toContain('cccccccc');
        expect(down.out).toContain('bbbbbbbb');
        rmSync(join(home, 'access.key'));
        const noLogin = await run2([], env, fake([]));
        expect(noLogin.out).toContain(`but the happy server was not asked (no login under ${home}):`);
    });

    it('--archive stamps each dead session archived over the transport, POSTs, writes it through to the ledger, and is done the second time', async () => {
        const registry = fake([]);
        const r = await run2(['--archive'], env, registry);
        expect(r.code).toBe(0);
        expect(r.err).toBe('');
        expect(r.lines).toEqual([
            'drover: archiving 2 registered session(s) whose process is gone:',
            '  archived  opencode cccccccc  /Users/x/three',
            '  archived  codex    bbbbbbbb  fix the build',
            'drover: archived 2, already archived 0, failed 0.',
        ]);
        expect(registry.updates.map((u) => u.sid)).toEqual([C, B]);
        expect(registry.updates[1]).toMatchObject({ expectedVersion: 1, metadata: { name: 'fix the build', flavor: 'codex', lifecycleState: 'archived' } });
        expect(typeof (registry.updates[1].metadata as Record<string, unknown>).lifecycleStateSince).toBe('number');
        expect(registry.archived).toEqual([C, B]);
        expect(registry.closed).toBe(1);
        // Written through: the ledger now says archived, and only for those two.
        const after = JSON.parse(readFileSync(ledger, 'utf8')) as { sessions: Record<string, { metadata: Record<string, unknown> }> };
        expect(after.sessions[B].metadata.lifecycleState).toBe('archived');
        expect(after.sessions[C].metadata.lifecycleState).toBe('archived');
        expect(after.sessions[L].metadata.lifecycleState).toBe('running');
        expect(after.sessions[K].metadata.lifecycleState).toBe('running');
        // So the next run has nothing to do, and the report has nothing to say.
        const again = await run2(['--archive'], env, registry);
        expect(again.code).toBe(0);
        expect(again.out).toBe('drover: every registered codex, cursor, opencode, gemini and pi session still has its process; nothing to archive.\n');
        expect(registry.listCalls).toBe(1);
        const report = await run2([], env, registry);
        expect(report.out).not.toContain('registered session');
    });

    it('--archive: one the server already archived is written through and counted, not stamped again', async () => {
        const registry = fake([{ id: C, active: false, activeAt: 1, updatedAt: 1, metadata: blob({ lifecycleState: 'archived' }), metadataVersion: 2 }]);
        const r = await run2(['--archive'], env, registry);
        expect(r.code).toBe(0);
        expect(r.lines).toEqual([
            'drover: archiving 1 registered session(s) whose process is gone:',
            '  archived  codex    bbbbbbbb  fix the build',
            'drover: archived 1, already archived 1, failed 0.',
        ]);
        expect(registry.updates.map((u) => u.sid)).toEqual([B]);
        const after = JSON.parse(readFileSync(ledger, 'utf8')) as { sessions: Record<string, { metadata: Record<string, unknown> }> };
        expect(after.sessions[C].metadata.lifecycleState).toBe('archived');
        expect(after.sessions[B].metadata.lifecycleState).toBe('archived');

        // And when every dead one is already archived there, only the ledger moves.
        writeFileSync(ledger, JSON.stringify(LEDGER));
        const all = fake([
            { id: C, active: false, activeAt: 1, updatedAt: 1, metadata: blob({ lifecycleState: 'archived' }), metadataVersion: 2 },
            { id: B, active: false, activeAt: 1, updatedAt: 1, metadata: blob({ lifecycleState: 'archived' }), metadataVersion: 2 },
        ]);
        const done = await run2(['--archive'], env, all);
        expect(done.code).toBe(0);
        expect(done.out).toBe('drover: all 2 dead registered session(s) were already archived on the server; the ledger now says so.\n');
        expect(all.updates).toEqual([]);
    });

    it('--archive: a version mismatch is retried on the server\'s metadata; an error is a failed line and exit 1', async () => {
        const registry = fake([], [
            { result: 'version-mismatch', version: 7, metadata: blob({ flavor: 'opencode', name: 'renamed on the phone', lifecycleState: 'running' }) },
            { result: 'success' },
            { result: 'error' },
        ]);
        const r = await run2(['--archive'], env, registry);
        expect(r.code).toBe(1);
        expect(r.lines).toEqual([
            'drover: archiving 2 registered session(s) whose process is gone:',
            '  archived  opencode cccccccc  /Users/x/three',
            '  failed    codex    bbbbbbbb  fix the build',
            'drover: archived 1, already archived 0, failed 1.',
        ]);
        expect(registry.updates.map((u) => [u.sid, u.expectedVersion])).toEqual([[C, 1], [C, 7], [B, 1]]);
        expect(registry.updates[1].metadata).toMatchObject({ name: 'renamed on the phone', lifecycleState: 'archived' });
        expect(registry.archived).toEqual([C]);
        // The one that failed is NOT written through: the ledger still names it.
        const after = JSON.parse(readFileSync(ledger, 'utf8')) as { sessions: Record<string, { metadata: Record<string, unknown> }> };
        expect(after.sessions[C].metadata.lifecycleState).toBe('archived');
        expect(after.sessions[B].metadata.lifecycleState).toBe('running');
    });

    it('--archive exits 1, archiving nothing, when the server cannot be listed or the socket will not open', async () => {
        const unlisted = await run2(['--archive'], env, fake(new Error('http://srv answered 401')));
        expect(unlisted.code).toBe(1);
        expect(unlisted.out).toBe('');
        expect(unlisted.err).toBe('drover: the happy server did not answer (http://srv answered 401); nothing archived.\n');
        const noSocket = fake([], [], new Error('refused'));
        const closed = await run2(['--archive'], env, noSocket);
        expect(closed.code).toBe(1);
        expect(closed.err).toBe('drover: could not open the archive socket (refused); nothing archived.\n');
        expect(noSocket.updates).toEqual([]);
        const after = JSON.parse(readFileSync(ledger, 'utf8')) as { sessions: Record<string, { metadata: Record<string, unknown> }> };
        expect(after.sessions[B].metadata.lifecycleState).toBe('running');
    });

    it('--archive is the flag, spelled exactly; a near miss is refused before anything is read', async () => {
        const registry = fake([]);
        const r = await run2(['--archived'], env, registry);
        expect(r.code).toBe(2);
        expect(r.err).toBe('drover stale-sessions: unknown argument: --archived\n');
        expect(registry.listCalls).toBe(0);
    });
});
