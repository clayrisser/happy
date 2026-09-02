/**
 * `drover status`, node against the shell it replaces (DROVE-315).
 *
 * One fixture, both implementations, byte for byte. The fixture pins a bus that
 * is not listening, a Happy home whose logs hold a known run of push verdicts,
 * and a state dir holding a publish ledger and a message ledger — which is
 * every section whose answer is a FILE rather than the machine. The sections
 * that read the machine (bridge, daemon, build, sleep, services) are asserted
 * separately against an injected StatusProbe, because a test that read Clay's
 * real launchd while he was working would be measuring the thing it is meant to
 * be checking.
 *
 * NOTHING HERE REACHES THE REAL STATE (DROVE-336). HAPPY_HOME_DIR is pinned to
 * a throwaway before the first import; the bus URL is a closed loopback port;
 * no dist entry is spawned. The shell verb is run with the same fixture env, so
 * it too reads nothing of Clay's.
 *
 * AND NOTHING HERE PRINTS A LOG (DROVE-283/318). The fixture log lines are
 * synthetic and the assertions are on the rendered COUNTS and verdicts, never on
 * a log's contents.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
    renderBridge,
    renderDaemon,
    renderServices,
    renderSleep,
    run,
    statusReport,
    type StatusProbe,
} from './status';

/** A throwaway HAPPY_HOME_DIR, pinned before the static imports are evaluated. */
const { happyHome, realHappyHome } = await vi.hoisted(async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const realHappyHome = path.join(os.homedir(), '.happy');
    const happyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'status-happy-'));
    process.env.HAPPY_HOME_DIR = happyHome;
    process.env.HAPPY_SERVER_URL = 'http://127.0.0.1:1';
    return { happyHome, realHappyHome };
});

// The verb imports none of these; a factory that throws turns a future import
// into a failure of this whole file at load, instead of a test that quietly
// reads ~/.happy.
vi.mock('../../configuration', () => {
    throw new Error('status.test: configuration (the ~/.happy reader) was imported; the verb must not reach the session machinery');
});
vi.mock('../../persistence', () => {
    throw new Error('status.test: persistence (access.key, settings) was imported; the verb must not reach the session machinery');
});
vi.mock('../../api/api', () => {
    throw new Error('status.test: api/api (session registration) was imported; the verb must not reach the session machinery');
});

const droverDir = join(homedir(), 'Projects', 'bitspur', 'cattle-drover');
/** A port nothing listens on, so the bus is refused in both implementations. */
const deadBus = 'http://127.0.0.1:45999';

let work: string;
let fixtureEnv: Record<string, string>;

beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'drover-status-'));
    const stateDir = join(work, 'state');
    const home = join(work, 'happy');
    mkdirSync(join(stateDir, 'logs'), { recursive: true });
    mkdirSync(join(home, 'logs'), { recursive: true });

    // Two log files, timestamp-prefixed the way happy-cli names them. The older
    // one holds a failure, the newer a success — the shape DROVE-14 exists for:
    // a single `tail -1` reading would have called this BROKEN.
    writeFileSync(
        join(home, 'logs', '2026-08-29-08-30-00-abc.log'),
        [
            '[08:39:23.928] sendSessionNotification failed reason=InvalidCredentials the key is not for this bundle',
            '  [08:40:00.000] sendSessionNotification duplicate quoted by the log, not said by it',
            '',
        ].join('\n'),
    );
    writeFileSync(
        join(home, 'logs', '2026-08-29-08-47-00-def.log'),
        [
            '[08:47:50.741] Push notifications sent successfully',
            '[08:48:05.001] [PUSH] receipt abc-123 ok',
            '[08:48:06.002] [PUSH] receipt abc-124 pending',
            '',
        ].join('\n'),
    );

    // The publish ledger: successes, one failure, and one of each blind cause.
    const t = (n: string, gate: string, verdict: string): string => `2026-08-31T0${n}:00:00Z\tsess\t${gate}\t${verdict}`;
    writeFileSync(
        join(stateDir, 'published.log'),
        [
            t('1', 'ask-bash', 'published ok'),
            t('2', 'ask-bash', 'published ok'),
            t('3', 'ask-write', 'publish-failed after 2x3s at http://127.0.0.1:7970'),
            t('4', 'ask-bash', 'popup-no-client-denied'),
            t('5', 'ask-bash', 'popup-refused-denied'),
            t('6', 'ask-bash', 'popup-tmux-error-denied'),
            t('7', 'ask-bash', 'popup-foreign-client-denied'),
            t('8', 'ask-bash', 'popup-unverifiable-denied'),
            '2026-08-31T09:00:00Z\tsess\task-bash\tallow-remote',
            '',
        ].join('\n'),
    );
    writeFileSync(
        join(stateDir, 'messages.log'),
        [
            '2026-08-31T01:00:00Z\tsess\tinbox\tdelivered',
            '2026-08-31T02:00:00Z\tsess\tinbox\tundelivered no socket on that pane',
            '',
        ].join('\n'),
    );

    fixtureEnv = {
        DROVER_DIR: droverDir,
        // A fork dir that is not there, so the build section is deterministic.
        FORK_DIR: join(work, 'no-fork'),
        STATE_DIR: stateDir,
        DROVER_HAPPY_HOME: home,
        DROVER_URL: deadBus,
        DROVER_PORT: '45999',
        DROVER_SERVER_MODE: 'official',
        DROVER_PUSH_WINDOW: '10',
        DROVER_STATUS_TIMEOUT_S: '2',
        HOME: work,
        HAPPY_HOME_DIR: happyHome,
        HAPPY_SERVER_URL: 'http://127.0.0.1:1',
        PATH: process.env.PATH ?? '',
        TMPDIR: process.env.TMPDIR ?? '/tmp',
    };
});

afterAll(() => {
    // The fence: the throwaway Happy home is still empty, so nothing in this
    // file registered a session anywhere.
    expect(resolve(happyHome)).not.toBe(resolve(realHappyHome));
    rmSync(work, { recursive: true, force: true });
    rmSync(happyHome, { recursive: true, force: true });
});

/** A probe that throws: a section reaching for the machine fails the test. */
function refusingProbe(overrides: Partial<StatusProbe> = {}): StatusProbe {
    const no = (what: string) => (): never => {
        throw new Error(`status.test: the render asked the real machine for ${what}`);
    };
    return {
        psCommand: no('ps'),
        pgrep: no('pgrep'),
        launchdPid: no('launchctl list'),
        launchdLoaded: no('launchctl print'),
        lsofEstablished: no('lsof'),
        pmset: no('pmset'),
        uid: () => '501',
        now: () => 1_756_000_000,
        ...overrides,
    } as StatusProbe;
}

/**
 * A probe that answers, for the whole-report tests: fixed, and still not the
 * real machine. Nothing is up, which makes every machine-reading section
 * deterministic without asking the OS a single question.
 */
function quietProbe(): StatusProbe {
    return {
        psCommand: () => '',
        pgrep: () => [],
        launchdPid: () => '',
        launchdLoaded: () => false,
        lsofEstablished: () => '',
        pmset: () => '',
        uid: () => '501',
        now: () => 1_756_000_000,
    };
}

/** Everything before the first machine-reading section. */
function fileSections(out: string): string[] {
    const all = out.split('\n');
    const cut = all.findIndex((l) => l.startsWith('bridge') || l.startsWith('daemon'));
    return cut < 0 ? all : all.slice(0, cut);
}

describe('drover status, against the shell it replaces', () => {
    it('renders the bus, push, gates, blind and messages sections byte for byte', async () => {
        const shell = spawnSync(join(droverDir, 'libexec', 'drover-status'), [], {
            encoding: 'utf8',
            env: fixtureEnv,
        });
        expect(shell.error).toBeUndefined();

        const node = await statusReport({
            env: fixtureEnv,
            home: work,
            probe: quietProbe(),
        });
        // The node render is asked only for the sections the fixture pins; the
        // probe above guarantees it never reached past them.
        expect(fileSections(node.join('\n'))).toEqual(fileSections(shell.stdout));
    });

    it('says DOWN for a refused bus and names the fix, never "unreachable"', async () => {
        const node = await statusReport({ env: fixtureEnv, home: work, probe: quietProbe() });
        expect(node[0]).toBe(`bus       DOWN at ${deadBus}`);
        expect(node[1]).toBe('          start it: drover bus   (or make launchd for the supervised stack)');
        expect(node[2]).toBe('          prompts still work — every producer falls back to its own UI.');
    });

    it('counts the blind gates apart, by cause, with the sentence each one earned', async () => {
        const node = await statusReport({ env: fixtureEnv, home: work, probe: quietProbe() });
        const text = node.join('\n');
        expect(text).toContain('gates     2 published, 1 FAILED to publish');
        expect(text).toContain('blind     1 denied with NO TMUX CLIENT attached and no surface answering');
        expect(text).toContain('          the popup had no screen to draw on. Attach a terminal, or make sure');
        expect(text).toContain('blind     1 denied while another popup held the overlay');
        expect(text).toContain('blind     1 denied because tmux would not run the popup, cause unknown');
        expect(text).toContain('blind     1 denied rather than draw on a terminal watching another session');
        expect(text).toContain('blind     1 denied because drover could not tell where the popup would land');
        expect(text).toContain('remote    1 answered on a phone or a watch after no popup could be drawn');
    });

    it('reads the push history rather than one verdict, and never quotes a log', async () => {
        const node = await statusReport({ env: fixtureEnv, home: work, probe: quietProbe() });
        const text = node.join('\n');
        // The newest verdict is the delivered receipt; the failure is still
        // reported, which is the whole of DROVE-14.
        expect(text).toContain('push      ok · APNs accepted the last push 2026-08-29 08:48:05.001 (ticket=abc-123)');
        expect(text).toContain('          last FAIL 2026-08-29 08:39:23.928 — InvalidCredentials the key is not for this bundle');
        // The quoted, indented line in the older log is not a verdict.
        expect(text).not.toContain('duplicate');
    });

    it('says a phone message was lost, with why', async () => {
        const node = await statusReport({ env: fixtureEnv, home: work, probe: quietProbe() });
        const text = node.join('\n');
        expect(text).toContain('messages  1 delivered, 1 UNDELIVERED — the phone was told, nothing was pasted');
        expect(text).toContain("          a phone message rides Claude's own inbox socket and nothing else.");
    });
});

describe('the sections that read the machine', () => {
    const lines: string[] = [];
    const sink = { line: (t: string) => lines.push(t) };
    const reset = (): void => {
        lines.length = 0;
    };

    it('a live bridge pid connected to nothing is not health', () => {
        reset();
        renderBridge(sink, refusingProbe({
            pgrep: () => ['4242'],
            lsofEstablished: () => 'node 4242 clay 20u IPv4 TCP 127.0.0.1:1234->10.0.0.1:9999 (ESTABLISHED)\n',
        }), '7970', '/state');
        expect(lines).toEqual([
            'bridge    RUNNING BUT CONNECTED TO NOTHING · pid 4242',
            '          a live pid is not health. Check /state/logs/bridge.log',
        ]);
    });

    it('missing lsof is admitted, not guessed at', () => {
        reset();
        renderBridge(sink, refusingProbe({ pgrep: () => ['77'], lsofEstablished: () => null }), '7970', '/state');
        expect(lines).toEqual(['bridge    pid 77 (cannot verify its sockets: lsof missing)']);
    });

    it('a launchd pid that is not a daemon is DOWN, and says nothing is serving the state file', () => {
        reset();
        const home = mkdtempSync(join(tmpdir(), 'status-daemon-'));
        renderDaemon(sink, refusingProbe({
            launchdPid: () => '999',
            psCommand: (pid) => (pid === '999' ? '/bin/sh /libexec/drover-daemon' : ''),
            pgrep: () => [],
        }), home);
        expect(lines[0]).toBe('daemon    DOWN — pid 999 is alive but is not a daemon');
        expect(lines[1]).toBe(`          nothing is serving ${join(home, 'daemon.state.json')}.`);
        expect(lines[2]).toBe('          start it: launchctl kickstart -k gui/501/com.bitspur.cattle-drover.daemon');
        rmSync(home, { recursive: true, force: true });
    });

    it('a caffeinate-only Mac is told its assertion dies with the daemon', () => {
        reset();
        renderSleep(sink, ' sleep 10 (sleep prevented by 123 caffeinate)\n displaysleep 5\n');
        expect(lines[0]).toBe('sleep     awake ONLY while caffeinate is held · pmset sleep 10 min');
        expect(lines[3]).toBe('          Mac idles to sleep 10 min later, taking the bus and the bridge with');
    });

    it('the relay being stopped in official mode is not a fault', () => {
        reset();
        renderServices(sink, refusingProbe({ launchdLoaded: () => false }), work, 'official');
        expect(lines).toContain('  relay    NOT INSTALLED — run: make launchd');
    });
});

describe('arguments answer before anything is read', () => {
    it('--help exits 0', async () => {
        const original = process.stdout.write.bind(process.stdout);
        (process.stdout as unknown as { write: (t: string) => boolean }).write = () => true;
        try {
            expect(await run(['--help'])).toBe(0);
        } finally {
            (process.stdout as unknown as { write: typeof original }).write = original;
        }
    });

    it('an unknown argument is exit 2', async () => {
        const err: string[] = [];
        const original = process.stderr.write.bind(process.stderr);
        (process.stderr as unknown as { write: (t: string) => boolean }).write = (t: string) => {
            err.push(t);
            return true;
        };
        try {
            expect(await run(['--nope'])).toBe(2);
        } finally {
            (process.stderr as unknown as { write: typeof original }).write = original;
        }
        expect(err.join('')).toBe("drover status: unknown argument '--nope' (try --json or --help)\n");
    });
});
