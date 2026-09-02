/**
 * The four service wrappers, as plans (DROVE-315).
 *
 * NOTHING HERE STARTS, STOPS OR KICKSTARTS ANYTHING. Every wrapper answers
 * with a ServicePlan and this file reads it, which is the whole reason the
 * wrappers were ported as plans: a function that returns the argv it would run
 * cannot accidentally boot a real bus, bridge or daemon out from under a live
 * session. HOME is a throwaway per test, so the credential probe and the state
 * file are fixtures and never the real ~/.happy.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { bridgePlan, busPlan, daemonPid, daemonPlan, hasCredential, relayPlan } from './services';

let home: string;
let forkDir: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'drover-svc-'));
    home = join(root, 'home');
    forkDir = join(root, 'fork');
    mkdirSync(join(forkDir, 'packages', 'happy-cli'), { recursive: true });
    mkdirSync(join(forkDir, 'packages', 'happy-server'), { recursive: true });
    mkdirSync(join(home, '.drover', 'happy'), { recursive: true });
    env = { HOME: home, DROVER_HOME: join(home, '.drover'), FORK_DIR: forkDir, DROVER_DIR: join(root, 'checkout') };
});

const signIn = () => writeFileSync(join(home, '.drover', 'happy', 'access.key'), 'x');

describe('the bus', () => {
    it('names loopback, because that is the only bind server.js will accept', () => {
        // Not a default: the bus has no auth and its routes inject into live
        // sessions, so server.js refuses a routable bind and exits (DROVE-6).
        const p = busPlan(env, home);
        expect(p.env.DROVER_BIND).toBe('127.0.0.1');
        expect(p.env.DROVER_PORT).toBe('7970');
        expect(p.argv).toEqual(['node', join(env.DROVER_DIR!, 'server.js')]);
    });
});

describe('the relay', () => {
    it('migrates before it serves, on its own data dir', () => {
        // Migrations are idempotent and must run before first serve, or
        // /v1/auth 500s on a fresh PGlite dir.
        const p = relayPlan(env, home);
        expect(p.before).toEqual([['pnpm', 'standalone', 'migrate']]);
        expect(p.argv).toEqual(['pnpm', 'standalone', 'serve']);
        expect(p.env.PORT).toBe('7971');
        expect(p.env.DATABASE_URL).toBe('');
        // The master secret is minted on the machine and read at start. A
        // secret in a plan is a secret in a log.
        expect(Object.keys(p.env)).not.toContain('HANDY_MASTER_SECRET');
    });

    it('refuses rather than starts when the fork is not there', () => {
        const p = relayPlan({ ...env, FORK_DIR: '/nowhere' }, home);
        expect(p.refuse).toBe('drover relay: fork not found at /nowhere');
        expect(p.argv).toEqual([]);
    });
});

describe('the bridge', () => {
    it('waits for the bus, and waits QUIETLY for a login rather than crash-looping', () => {
        // Official mode has no seeding path: the account is minted by scanning
        // the QR once. Crash-looping under KeepAlive would fill the log with
        // the same stack every ten seconds.
        const p = bridgePlan(env, home);
        expect(p.waitFor).toEqual([{ url: 'http://127.0.0.1:7970/v1/status', name: 'bus' }]);
        expect(p.waitForLogin?.message).toContain("run 'drover pair' and scan the QR");
        expect(p.argv).toEqual(['node', 'dist/index.mjs', 'drover-bridge']);
        expect(p.env.HAPPY_HOME_DIR).toBe(join(home, '.drover', 'happy'));
        // Never `npx`: a shim ahead of it re-execs the tree under Socket
        // Firewall, which answers 405 for the official Happy server.
        expect(p.argv[0]).toBe('node');
    });

    it('starts once there is a credential, and adds the relay when the mode says so', () => {
        signIn();
        expect(bridgePlan(env, home).waitForLogin).toBeUndefined();
        const relay = bridgePlan({ ...env, DROVER_SERVER_MODE: 'relay' }, home);
        expect(relay.waitFor?.map((w) => w.name)).toEqual(['bus', 'relay']);
        expect(relay.env.HAPPY_SERVER_URL).toBe('http://127.0.0.1:7971');
    });
});

describe('the daemon', () => {
    it('tells the daemon it has a supervisor, and exports the state dir with it', () => {
        signIn();
        const p = daemonPlan(env, home);
        // Without HAPPY_DAEMON_SUPERVISED the daemon replaces ITSELF on a
        // rebuild: the successor reparents to pid 1 where launchd cannot see
        // it, while launchd restarts the copy it does supervise. Five were
        // found alive at once (DROVE-42).
        expect(p.env.HAPPY_DAEMON_SUPERVISED).toBe('1');
        // Unexported, a machine with a STATE_DIR override would have the
        // sessions it spawns write to the default path while status read the
        // override (DROVE-48).
        expect(p.env.STATE_DIR).toBe(join(home, '.drover', 'state'));
        expect(p.argv).toEqual(['node', 'dist/index.mjs', 'daemon', 'start-sync']);
    });
});

describe('daemonPid — adopt, do not race', () => {
    const state = '/fixture/daemon.state.json';
    const doc = (pid: unknown) => () => ({ pid });

    it('adopts a pid whose command line really is a daemon', () => {
        const ps = () => 'node /fork/packages/happy-cli/dist/index.mjs daemon start-sync';
        expect(daemonPid(state, ps, doc(20879))).toBe('20879');
    });

    it('refuses a pid the OS recycled onto something else', () => {
        // `kill -0` alone trusts a pid that may now be anything: the state file
        // outlives the process that wrote it, so a stale pid on a live stranger
        // would make the wrapper defer forever to a daemon that does not exist.
        expect(daemonPid(state, () => '/usr/sbin/cupsd -l', doc(18544))).toBeNull();
    });

    it('refuses the LOOSE match that let a test harness adopt itself', () => {
        // The pattern is `dist/index.mjs daemon start-sync`, not the bare
        // phrase: a shell one-liner that greps for it contains the phrase too.
        expect(daemonPid(state, () => 'sh -c grep -q "daemon start-sync" x', doc(1))).toBeNull();
    });

    it('answers null for a dead pid, an empty pid and an unreadable file', () => {
        expect(daemonPid(state, () => null, doc(18544))).toBeNull();
        expect(daemonPid(state, () => 'x dist/index.mjs daemon start-sync', doc(''))).toBeNull();
        expect(daemonPid(state, () => 'x', () => { throw new Error('ENOENT'); })).toBeNull();
    });
});

describe('hasCredential', () => {
    it('is present AND not empty, which is what `[ -s ]` says', () => {
        const h = join(home, '.drover', 'happy');
        expect(hasCredential(h)).toBe(false);
        writeFileSync(join(h, 'access.key'), '');
        expect(hasCredential(h)).toBe(false);
        writeFileSync(join(h, 'access.key'), 'x');
        expect(hasCredential(h)).toBe(true);
    });
});
