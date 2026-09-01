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
 * cannot drift a character from what the ship loop printed before it.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { droverEnv } from './env';
import {
    fmtLocal,
    parseEtime,
    run,
    staleCodeMtime,
    staleServicePid,
    staleStartedAt,
    staleTranscriptOf,
    type Probe,
} from './stale-sessions';

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

async function capture(args: string[], env: Record<string, string | undefined>, probe: Probe = noProbe): Promise<Captured> {
    const out: string[] = [];
    const err: string[] = [];
    const so = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => (out.push(String(c)), true));
    const se = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => (err.push(String(c)), true));
    try {
        const code = await run(args, { env, probe, uid: () => 501 });
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
