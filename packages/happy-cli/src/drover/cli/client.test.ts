/**
 * `drover client` control verbs (DROVE-11, DROVE-239), in node (DROVE-315).
 *
 * NOTHING HERE STARTS A SUBSCRIBER, DRAWS A POPUP OR SIGNALS A REAL PROCESS.
 * The claims directory is a fixture under a throwaway STATE_DIR and `ps`/
 * `kill -0` are injected, so the only pids this file has an opinion about are
 * ones it made up. cattle-drover/tests/subscriber.bats drives the live half
 * against a real tmux server on its own socket, and keeps doing so while the
 * shell file ships.
 */

import { mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { type ClientCtx, clientKey, codeIsNewer, holderAlive, run } from './client';
import { droverVerbs } from './index';

let root: string;
let claims: string;
let client: string;
let ctx: ClientCtx;
let living: Set<string>;
let commands: Map<string, string>;
const lines: string[] = [];
const io = { out: (s: string) => void lines.push(s), err: (s: string) => void lines.push(s) };
const output = () => lines.join('');

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'drover-client-'));
    claims = join(root, 'state', 'client');
    client = join(root, 'checkout', 'clients', 'tmux-gum.sh');
    mkdirSync(claims, { recursive: true });
    mkdirSync(join(root, 'checkout', 'clients'), { recursive: true });
    writeFileSync(client, '#!/bin/sh\nexit 0\n');
    living = new Set();
    commands = new Map();
    ctx = {
        env: { HOME: join(root, 'home'), STATE_DIR: join(root, 'state'), TMUX: '/tmp/sock,4242,0' },
        client,
        libexec: join(root, 'checkout', 'libexec'),
        claims,
        psCommand: (pid) => commands.get(pid) ?? null,
        alive: (pid) => living.has(pid),
    };
    lines.length = 0;
});

function claimed(pid: string, cmd = `/bin/sh ${client}`): string {
    const f = join(claims, 'tmux-4242.pid');
    writeFileSync(f, `${pid}\n`);
    living.add(pid);
    commands.set(pid, cmd);
    return f;
}

describe('the claim key', () => {
    it('is the tmux SERVER pid, because a popup is drawn per server', () => {
        // $TMUX is "socket,serverpid,session". Two terminals on one server
        // share one screen's worth of popups, so one subscriber covers both.
        expect(clientKey({ TMUX: '/private/tmp/tmux-501/default,4242,0' })).toBe('tmux-4242');
        expect(clientKey({})).toBe('notmux');
        expect(clientKey({ TMUX: 'garbage' })).toBe('notmux');
    });
});

describe('a pidfile is only ever a claim', () => {
    it('believes it only when the pid is alive AND still the client', () => {
        // A recycled pid belonging to something else would otherwise leave
        // this tmux server with no subscriber at all, silently.
        living.add('900');
        commands.set('900', '/usr/sbin/cupsd -l');
        expect(holderAlive(ctx, '900')).toBe(false);
        commands.set('900', `/bin/sh ${client}`);
        expect(holderAlive(ctx, '900')).toBe(true);
        expect(holderAlive(ctx, '901')).toBe(false);
        expect(holderAlive(ctx, null)).toBe(false);
    });
});

describe('--status', () => {
    it('names the running subscriber, and says OLD CODE when it predates the file', async () => {
        const claim = claimed('900');
        expect(await run(['--status'], io, ctx)).toBe(0);
        expect(output()).toContain('tmux-4242\trunning\tpid 900');
        expect(output()).toContain('current');

        // The pidfile's mtime IS the start time, so ageing it is exactly "the
        // client file changed after this one started" (DROVE-239).
        const old = new Date('2026-01-01T00:00:00Z');
        utimesSync(claim, old, old);
        expect(codeIsNewer(ctx, claim)).toBe(true);
        lines.length = 0;
        expect(await run(['--status'], io, ctx)).toBe(0);
        expect(output()).toContain('OLD CODE');
        expect(output()).toContain('drover client --restart');
    });

    it('calls a claim whose holder is gone stale, and says so when there is none', async () => {
        writeFileSync(join(claims, 'tmux-4242.pid'), '900\n');
        expect(await run(['--status'], io, ctx)).toBe(0);
        expect(output()).toContain('tmux-4242\tstale\tpid 900');

        lines.length = 0;
        ctx.claims = join(root, 'state', 'empty-claims');
        expect(await run(['--status'], io, ctx)).toBe(0);
        expect(output()).toContain('no subscriber is running');
    });
});

describe('--stop', () => {
    it('says nothing was running when the claim is stale, and clears it either way', async () => {
        writeFileSync(join(claims, 'tmux-4242.pid'), '900\n');
        expect(await run(['--stop'], io, ctx)).toBe(0);
        expect(output()).toContain('no subscriber running for tmux-4242');
        expect(() => statSync(join(claims, 'tmux-4242.pid'))).toThrow();
    });
});

describe('the verb', () => {
    it('refuses an unknown argument with 2', async () => {
        expect(await run(['--frobnicate'], io, ctx)).toBe(2);
        expect(output()).toContain('unknown argument --frobnicate');
    });

    it('is in the verb table, so `drover client` reaches node', () => {
        expect(droverVerbs.map((v) => v.name)).toContain('client');
    });
});
