/**
 * DROVE-336: no unit test reaches real state. The first describe is the wiring
 * check: it passes only because vitest.config.ts runs noRealState.setup.ts in
 * front of this file.
 */

import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { configuration } from '@/configuration';

import {
    applyNoRealState,
    assertNoRealState,
    droverStateDirOf,
    droverUrlOf,
    isLoopbackUrl,
    realHappyHomeDir,
    realStateOf,
    resolvesToRealHappyHome,
    stubDroverUrl,
    stubServerUrl,
    type RealState,
} from './noRealState';

const realHappy = join(homedir(), '.happy');
const realState = join(homedir(), '.local', 'state', 'cattle-drover');

describe('the guard is in front of every unit test (vitest.config.ts setupFiles)', () => {
    it('this test runs under a throwaway HAPPY_HOME_DIR and a loopback HAPPY_SERVER_URL', () => {
        expect(process.env.HAPPY_HOME_DIR).toBeDefined();
        expect(resolve(process.env.HAPPY_HOME_DIR!)).not.toBe(resolve(realHappy));
        expect(isLoopbackUrl(process.env.HAPPY_SERVER_URL)).toBe(true);
    });

    it('configuration resolved the throwaway, so its sessions file is nowhere near ~/.happy', () => {
        expect(resolve(configuration.happyHomeDir)).not.toBe(resolve(realHappy));
        expect(configuration.sessionsFile.startsWith(configuration.happyHomeDir)).toBe(true);
        expect(configuration.sessionsFile.startsWith(realHappy)).toBe(false);
        expect(isLoopbackUrl(configuration.serverUrl)).toBe(true);
        expect(configuration.serverUrl).not.toBe('https://api.cluster-fluster.com');
    });

    it("the wrapper's STATE_DIR is gone, the state dir is a throwaway, and the bus is a dead port", () => {
        expect(process.env.STATE_DIR).toBeUndefined();
        expect(resolve(droverStateDirOf(process.env))).not.toBe(resolve(realState));
        expect(process.env.DROVER_URL).toBe(stubDroverUrl);
    });
});

describe('resolvesToRealHappyHome', () => {
    it('unset is real, because configuration falls back to ~/.happy', () => {
        expect(resolvesToRealHappyHome(undefined, '/home/x/.happy')).toBe(true);
        expect(resolvesToRealHappyHome('', '/home/x/.happy')).toBe(true);
    });

    it('the expanded path and a dot-relative spelling of it are real; a sibling is not', () => {
        expect(resolvesToRealHappyHome('/home/x/.happy', '/home/x/.happy')).toBe(true);
        expect(resolvesToRealHappyHome('/home/x/./.happy/', '/home/x/.happy')).toBe(true);
        expect(resolvesToRealHappyHome('/home/x/.happy-test', '/home/x/.happy')).toBe(false);
        expect(resolvesToRealHappyHome('/tmp/happy-unit-abc/happy', '/home/x/.happy')).toBe(false);
    });

    it('~/.happy expands the way configuration expands it', () => {
        expect(resolvesToRealHappyHome('~/.happy', realHappyHomeDir())).toBe(true);
        expect(resolvesToRealHappyHome('~/.happy-other', realHappyHomeDir())).toBe(false);
    });
});

describe('isLoopbackUrl', () => {
    it('is 127/8, ::1 and localhost, on any port', () => {
        expect(isLoopbackUrl('http://127.0.0.1:1')).toBe(true);
        expect(isLoopbackUrl('http://127.5.6.7:59999')).toBe(true);
        expect(isLoopbackUrl('http://localhost:3005')).toBe(true);
        expect(isLoopbackUrl('http://[::1]:3005')).toBe(true);
    });

    it('is not the production server, a LAN host, garbage or unset', () => {
        expect(isLoopbackUrl('https://api.cluster-fluster.com')).toBe(false);
        expect(isLoopbackUrl('http://192.168.1.10:3005')).toBe(false);
        expect(isLoopbackUrl('http://127.0.0.1.evil.example')).toBe(false);
        expect(isLoopbackUrl('not a url')).toBe(false);
        expect(isLoopbackUrl(undefined)).toBe(false);
    });
});

describe('realStateOf reads the inherited env the way the readers do', () => {
    it("the wrapper's env: STATE_DIR wins, DROVER_URL as exported", () => {
        const real = realStateOf({ STATE_DIR: '/home/x/.local/state/cattle-drover', XDG_STATE_HOME: '/elsewhere', DROVER_URL: 'http://127.0.0.1:7970' }, '/home/x');
        expect(real).toEqual({
            home: '/home/x',
            happyHome: '/home/x/.happy',
            droverStateDir: '/home/x/.local/state/cattle-drover',
            droverUrl: 'http://127.0.0.1:7970',
        });
    });

    it('a bare shell: XDG_STATE_HOME, else ~/.local/state; the bus default', () => {
        expect(droverStateDirOf({ XDG_STATE_HOME: '/xdg' }, '/home/x')).toBe('/xdg/cattle-drover');
        expect(droverStateDirOf({}, '/home/x')).toBe('/home/x/.local/state/cattle-drover');
        expect(droverUrlOf({})).toBe('http://127.0.0.1:7970');
    });
});

describe('applyNoRealState', () => {
    it("gives the wrapper's env a throwaway home and state dir, the stub server and a dead bus", () => {
        const env: Record<string, string | undefined> = {
            STATE_DIR: '/home/x/.local/state/cattle-drover',
            DROVER_URL: 'http://127.0.0.1:7970',
        };
        const guard = applyNoRealState(env, '/home/x');
        try {
            expect(env.HAPPY_HOME_DIR).toBe(guard.happyHomeDir);
            expect(existsSync(guard.happyHomeDir)).toBe(true);
            expect(resolvesToRealHappyHome(guard.happyHomeDir, '/home/x/.happy')).toBe(false);
            expect(env.HAPPY_SERVER_URL).toBe(stubServerUrl);
            expect(env.STATE_DIR).toBeUndefined();
            expect(env.XDG_STATE_HOME).toBe(guard.xdgStateHome);
            expect(existsSync(guard.xdgStateHome)).toBe(true);
            expect(droverStateDirOf(env, '/home/x')).toBe(join(guard.xdgStateHome, 'cattle-drover'));
            expect(env.DROVER_URL).toBe(stubDroverUrl);
            expect(guard.real).toEqual({
                home: '/home/x',
                happyHome: '/home/x/.happy',
                droverStateDir: '/home/x/.local/state/cattle-drover',
                droverUrl: 'http://127.0.0.1:7970',
            });
        } finally {
            rmSync(guard.happyHomeDir, { recursive: true, force: true });
            rmSync(guard.xdgStateHome, { recursive: true, force: true });
        }
    });

    it("replaces whatever was inherited, a throwaway or a fake included: the inherited env is the wrapper's, never a test's", () => {
        const env: Record<string, string | undefined> = {
            HAPPY_HOME_DIR: '/tmp/somebody-elses-throwaway',
            HAPPY_SERVER_URL: 'http://127.0.0.1:59999',
            XDG_STATE_HOME: '/tmp/somebody-elses-state',
            DROVER_URL: 'http://127.0.0.1:59998',
        };
        const guard = applyNoRealState(env, '/home/x');
        try {
            expect(env.HAPPY_HOME_DIR).not.toBe('/tmp/somebody-elses-throwaway');
            expect(env.HAPPY_SERVER_URL).toBe(stubServerUrl);
            expect(env.XDG_STATE_HOME).not.toBe('/tmp/somebody-elses-state');
            expect(env.DROVER_URL).toBe(stubDroverUrl);
            // And what it inherited is what the checks call real.
            expect(guard.real.droverStateDir).toBe('/tmp/somebody-elses-state/cattle-drover');
            expect(guard.real.droverUrl).toBe('http://127.0.0.1:59998');
        } finally {
            rmSync(guard.happyHomeDir, { recursive: true, force: true });
            rmSync(guard.xdgStateHome, { recursive: true, force: true });
        }
    });

    it('two applies never share a scratch', () => {
        const a = applyNoRealState({}, '/home/x');
        const b = applyNoRealState({}, '/home/x');
        try {
            expect(a.happyHomeDir).not.toBe(b.happyHomeDir);
            expect(a.xdgStateHome).not.toBe(b.xdgStateHome);
        } finally {
            for (const g of [a, b]) {
                rmSync(g.happyHomeDir, { recursive: true, force: true });
                rmSync(g.xdgStateHome, { recursive: true, force: true });
            }
        }
    });
});

describe('assertNoRealState', () => {
    const real: RealState = {
        home: '/home/x',
        happyHome: '/home/x/.happy',
        droverStateDir: '/home/x/.local/state/cattle-drover',
        droverUrl: 'http://127.0.0.1:7970',
    };
    const ok = { happyHomeDir: '/tmp/happy-unit-abc/happy', serverUrl: stubServerUrl };
    const okEnv = {
        HAPPY_HOME_DIR: '/tmp/happy-unit-abc/happy',
        HAPPY_SERVER_URL: stubServerUrl,
        XDG_STATE_HOME: '/tmp/happy-unit-abc/state',
        DROVER_URL: stubDroverUrl,
    };

    it('passes for throwaways and dead ports', () => {
        expect(() => assertNoRealState(ok, okEnv, real)).not.toThrow();
    });

    it("names every drift at once: the real home, a real server, and the wrapper's env a child would inherit", () => {
        let message = '';
        try {
            assertNoRealState(
                { happyHomeDir: '/home/x/.happy', serverUrl: 'https://api.cluster-fluster.com' },
                { STATE_DIR: '/home/x/.local/state/cattle-drover' },
                real,
            );
        } catch (e) {
            message = (e as Error).message;
        }
        expect(message).toMatch(/^DROVE-336: a unit test can reach real state:/);
        expect(message).toContain('configuration.happyHomeDir is the real /home/x/.happy');
        expect(message).toContain('configuration.serverUrl is https://api.cluster-fluster.com, which is not loopback');
        expect(message).toContain('HAPPY_HOME_DIR is unset, so a child would use the real /home/x/.happy');
        expect(message).toContain('HAPPY_SERVER_URL is unset, so a child would reach a real server');
        expect(message).toContain('STATE_DIR is "/home/x/.local/state/cattle-drover" and XDG_STATE_HOME is unset, so the drover state dir is the real /home/x/.local/state/cattle-drover');
        expect(message).toContain('DROVER_URL is unset, so the bus is the live http://127.0.0.1:7970');
    });

    it('a nested run whose inherited bus is already the dead port is not told the dead port is live', () => {
        expect(() => assertNoRealState(ok, okEnv, { ...real, droverUrl: stubDroverUrl })).not.toThrow();
    });

    it('catches an env that drifted after configuration loaded, which is what a child would inherit', () => {
        expect(() => assertNoRealState(ok, { ...okEnv, HAPPY_HOME_DIR: '/home/x/.happy' }, real))
            .toThrow(/HAPPY_HOME_DIR is "\/home\/x\/\.happy", so a child would use the real/);
        expect(() => assertNoRealState(ok, { ...okEnv, HAPPY_SERVER_URL: 'http://10.0.0.5:3005' }, real))
            .toThrow(/HAPPY_SERVER_URL is "http:\/\/10\.0\.0\.5:3005", so a child would reach a real server/);
        expect(() => assertNoRealState(ok, { ...okEnv, XDG_STATE_HOME: undefined }, real))
            .toThrow(/XDG_STATE_HOME is unset, so the drover state dir is the real/);
        expect(() => assertNoRealState(ok, { ...okEnv, DROVER_URL: 'http://127.0.0.1:7970' }, real))
            .toThrow(/DROVER_URL is "http:\/\/127\.0\.0\.1:7970", so the bus is the live/);
    });
});
