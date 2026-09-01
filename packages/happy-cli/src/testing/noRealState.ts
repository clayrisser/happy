/**
 * No unit test reaches real state (DROVE-336): not the real ~/.happy, not a
 * Happy server that is not loopback, not the real cattle-drover state dir, and
 * not the live bus.
 *
 * On 2026-09-01 ~/.happy/sessions.json gained 255 rig sessions in 36 minutes,
 * every one registered on api.cluster-fluster.com and listed by the phone
 * forever. Each was `node <worktree>/packages/happy-cli/dist/index.mjs
 * --version`, run from a port worktree with the real process.env by a startup
 * benchmark: on a dist without DROVE-314's early exit a bare --version falls
 * through to the session-start branch, authenticates with the real
 * credentials, calls getOrCreateSession on the real server and reports the
 * session to the live daemon before it exits. The vitest suites in those
 * worktrees stubbed everything themselves; nothing SHARED made them, and the
 * same real env reaches any child a test spawns.
 *
 * The env a unit test inherits is the wrapper's: bin/drover exports STATE_DIR
 * (the real ~/.local/state/cattle-drover, with the real cooldowns.json and a
 * local.env that can re-point the bus) and DROVER_URL (the live bus, which is
 * loopback, so "loopback only" would not catch it); HAPPY_HOME_DIR unset means
 * ~/.happy and HAPPY_SERVER_URL unset means production. Each test file used to
 * fence what it knew about. This fences all four in front of every file, and
 * `configuration` is checked after, because it is a singleton that reads the
 * env once at import and a test that loaded it early would have the real
 * paths baked in. Children inherit process.env, so the env is the guard for
 * them too. A test that needs something else sets it explicitly, to another
 * throwaway; there is no way to opt back into the real thing.
 *
 * The integration projects are not under this: they start a real claude and
 * talk to the real daemon on purpose, and droverTestHome.setup.ts is their
 * fence (DROVE-81).
 */

import { mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type Env = Record<string, string | undefined>;

/** A loopback port nothing listens on: a connection refuses at once. */
export const stubServerUrl = 'http://127.0.0.1:1';
/** The same dead port for the bus, so a verb that asks gets `refused`. */
export const stubDroverUrl = 'http://127.0.0.1:1';
/** What every reader of DROVER_URL falls back to. */
const defaultDroverUrl = 'http://127.0.0.1:7970';

/** What the inherited env would have reached: the real things, captured before anything is changed. */
export interface RealState {
    /** The HOME everything below was resolved against, captured before any test moves it. */
    home: string;
    happyHome: string;
    droverStateDir: string;
    droverUrl: string;
}

export interface NoRealState {
    /** The throwaway HAPPY_HOME_DIR the env now carries. */
    happyHomeDir: string;
    /** The loopback HAPPY_SERVER_URL the env now carries. */
    serverUrl: string;
    /** The throwaway XDG_STATE_HOME the env now carries; STATE_DIR is gone. */
    xdgStateHome: string;
    /** The dead-port DROVER_URL the env now carries. */
    droverUrl: string;
    /** Captured before the env was touched, for the checks that follow. */
    real: RealState;
}

/** The directory `configuration` falls back to when HAPPY_HOME_DIR is unset. */
export function realHappyHomeDir(home: string = homedir()): string {
    return join(home, '.happy');
}

/**
 * The cattle-drover state dir this env resolves to, the way src/drover/cli/env.ts
 * and messageLedger.ts read it: STATE_DIR, else XDG_STATE_HOME/cattle-drover,
 * else ~/.local/state/cattle-drover.
 */
export function droverStateDirOf(env: Env, home: string = homedir()): string {
    return env.STATE_DIR || join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'cattle-drover');
}

/** The bus this env resolves to, the way every reader of DROVER_URL does. */
export function droverUrlOf(env: Env): string {
    return env.DROVER_URL || defaultDroverUrl;
}

/** What the inherited env reaches. */
export function realStateOf(env: Env, home: string = homedir()): RealState {
    return {
        home,
        happyHome: realHappyHomeDir(home),
        droverStateDir: droverStateDirOf(env, home),
        droverUrl: droverUrlOf(env),
    };
}

/**
 * Would `configuration` resolve this HAPPY_HOME_DIR value to the real home?
 * Unset does, because the fallback is ~/.happy; so does `~/.happy`, which the
 * constructor expands the same way.
 */
export function resolvesToRealHappyHome(value: string | undefined, realHome: string = realHappyHomeDir()): boolean {
    if (!value) return true;
    const expanded = value.replace(/^~(?=$|\/)/, homedir());
    return resolve(expanded) === resolve(realHome);
}

/** Loopback only: 127.0.0.0/8, ::1, localhost. Anything else can be a real server. */
export function isLoopbackUrl(value: string | undefined): boolean {
    if (!value) return false;
    let host: string;
    try {
        host = new URL(value).hostname;
    } catch {
        return false;
    }
    if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function samePath(a: string, b: string): boolean {
    return resolve(a) === resolve(b);
}

/**
 * Point the env at throwaways and dead ports. Unconditionally: the env this
 * runs on is the one the process inherited, which is the wrapper's, never a
 * test's, so nothing in it is a fixture worth keeping. A test that wants its
 * own throwaway or its own fake sets it after this, and wins.
 */
export function applyNoRealState(env: Env = process.env, home: string = homedir()): NoRealState {
    const real = realStateOf(env, home);
    const scratch = mkdtempSync(join(tmpdir(), 'happy-unit-'));

    const happyHomeDir = join(scratch, 'happy');
    mkdirSync(happyHomeDir, { recursive: true });
    env.HAPPY_HOME_DIR = happyHomeDir;

    const serverUrl = stubServerUrl;
    env.HAPPY_SERVER_URL = serverUrl;

    // STATE_DIR is the wrapper's export and wins over XDG_STATE_HOME in every
    // reader; a test that sets XDG_STATE_HOME to its fixture expects that to
    // count. So STATE_DIR goes, and XDG_STATE_HOME is the throwaway.
    delete env.STATE_DIR;
    const xdgStateHome = join(scratch, 'state');
    mkdirSync(xdgStateHome, { recursive: true });
    env.XDG_STATE_HOME = xdgStateHome;

    const droverUrl = stubDroverUrl;
    env.DROVER_URL = droverUrl;

    return { happyHomeDir, serverUrl, xdgStateHome, droverUrl, real };
}

export interface HappyPaths {
    happyHomeDir: string;
    serverUrl: string;
}

/**
 * The loud part. Throws, naming what drifted, if `configuration` resolved the
 * real home or a non-loopback server, or if the env a child would inherit has
 * drifted back to any of the four real things. Called once after the env is
 * applied and again after every test, so a test that deletes a variable fails
 * itself rather than the next one.
 */
export function assertNoRealState(cfg: HappyPaths, env: Env, real: RealState): void {
    const problems: string[] = [];
    const show = (v: string | undefined): string => (v === undefined ? 'unset' : JSON.stringify(v));

    if (samePath(cfg.happyHomeDir, real.happyHome)) {
        problems.push(`configuration.happyHomeDir is the real ${real.happyHome}`);
    }
    if (!isLoopbackUrl(cfg.serverUrl)) {
        problems.push(`configuration.serverUrl is ${cfg.serverUrl}, which is not loopback`);
    }
    if (resolvesToRealHappyHome(env.HAPPY_HOME_DIR, real.happyHome)) {
        problems.push(`HAPPY_HOME_DIR is ${show(env.HAPPY_HOME_DIR)}, so a child would use the real ${real.happyHome}`);
    }
    if (!isLoopbackUrl(env.HAPPY_SERVER_URL)) {
        problems.push(`HAPPY_SERVER_URL is ${show(env.HAPPY_SERVER_URL)}, so a child would reach a real server`);
    }
    if (samePath(droverStateDirOf(env, real.home), real.droverStateDir)) {
        problems.push(
            `STATE_DIR is ${show(env.STATE_DIR)} and XDG_STATE_HOME is ${show(env.XDG_STATE_HOME)}, `
            + `so the drover state dir is the real ${real.droverStateDir}`,
        );
    }
    // A nested run inherits the dead port as its "real" bus; that one is not live.
    if (droverUrlOf(env) === real.droverUrl && real.droverUrl !== stubDroverUrl) {
        problems.push(`DROVER_URL is ${show(env.DROVER_URL)}, so the bus is the live ${real.droverUrl}`);
    }
    if (problems.length === 0) return;
    throw new Error(
        'DROVE-336: a unit test can reach real state:\n'
        + problems.map((p) => `  - ${p}`).join('\n')
        + '\n  A unit test runs under a throwaway HAPPY_HOME_DIR and XDG_STATE_HOME, a loopback HAPPY_SERVER_URL '
        + 'and a dead-port DROVER_URL; set another throwaway if you need one, never the real thing. '
        + 'See src/testing/noRealState.ts.',
    );
}
