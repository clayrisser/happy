import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import type { DroverAccount } from '@/drover/flip/accounts';

import {
    accountStartEnvironment,
    buildDaemonResumeLaunch,
    openDroverWindow,
    resumeInDroverWindow,
    startAccountEnvironment,
    type DroverWindowDeps,
    type PickStartAccount,
} from './droverWindow';
import { tmuxUnreachableMessage } from './tmuxSpawn';
import type { SessionEncryptionData, TrackedSession } from './types';

// DROVE-76: tapping Resume on a dead session in the app used to spawn a
// headless remote-mode claude, detached, with no pane. The DROVE-1 audit
// measured it as the one remaining producer of the second kind of session one
// mode says cannot exist. A resume now takes the same tmux path a
// phone-started NEW session takes, and there is no direct spawn to fall back to.

const happySessionId = 'happy-7Q2';
const claudeSessionId = '3f6e1c2a-resume-me';

const encryption: SessionEncryptionData = {
    encryptionKey: new Uint8Array([1, 2, 3, 4]),
    encryptionVariant: 'dataKey',
    seq: 7,
    metadataVersion: 2,
    agentStateVersion: 5,
};

function claudeMetadata(extra: Partial<Metadata> = {}): Metadata {
    return {
        path: '/Users/clay/Projects/bitspur/cattle-drover',
        host: 'mac',
        flavor: 'claude',
        claudeSessionId,
        ...extra,
    } as Metadata;
}

function fakeDeps(overrides: Partial<DroverWindowDeps> = {}) {
    const spawnInTmux = vi.fn(async () => ({ success: true, sessionId: 'main:4', pid: 4242 }));
    const tracked = new Map<number, TrackedSession>();
    const deps: DroverWindowDeps = {
        ambientEnvironment: { PATH: '/usr/bin', HOME: '/Users/clay' },
        isTmuxAvailable: async () => true,
        droverBin: () => '/d/bin/drover',
        droverExists: () => true,
        tmuxFor: () => ({ spawnInTmux }),
        track: (pid, session) => { tracked.set(pid, session); },
        awaitWebhook: vi.fn(async () => ({ type: 'success' as const, sessionId: happySessionId })),
        ...overrides,
    };
    return { deps, spawnInTmux, tracked };
}

const exists = async () => true;

function spawnCall(spawnInTmux: ReturnType<typeof vi.fn>) {
    const [args, options, env] = spawnInTmux.mock.calls[0] as unknown as [
        string[],
        { sessionName?: string; windowName?: string; cwd?: string },
        Record<string, string>,
    ];
    return { command: args.join(' '), options, env };
}

describe('resume from the phone', () => {
    it('opens a tmux window running the wrapper in LOCAL mode with --resume <claudeSessionId>', async () => {
        const { deps, spawnInTmux, tracked } = fakeDeps();

        const result = await resumeInDroverWindow(deps, {
            happySessionId,
            metadata: claudeMetadata(),
            encryption,
            skipPermissions: false,
        }, exists);

        expect(spawnInTmux).toHaveBeenCalledTimes(1);
        const { command, options } = spawnCall(spawnInTmux);
        expect(command).toContain("'/d/bin/drover' 'claude' '--happy-starting-mode' 'local' '--started-by' 'daemon'");
        expect(command).toContain(`'--resume' '${claudeSessionId}'`);
        expect(command).not.toContain('remote');
        expect(options.cwd).toBe('/Users/clay/Projects/bitspur/cattle-drover');
        expect(options.windowName).toBe('cattle-drover');

        // The pane pid is what the webhook re-keys from, same as a spawn.
        expect(tracked.get(4242)).toMatchObject({ startedBy: 'daemon', pid: 4242, tmuxSessionId: 'main:4' });
        expect(deps.awaitWebhook).toHaveBeenCalledWith(4242, ' (tmux resume)');
        expect(result).toEqual({ type: 'success', sessionId: happySessionId });
    });

    it('reattaches to the SAME Happy session through HAPPY_RECONNECT_*, never a new one', async () => {
        const { deps, spawnInTmux } = fakeDeps();

        await resumeInDroverWindow(deps, { happySessionId, metadata: claudeMetadata(), encryption, skipPermissions: false }, exists);

        const { command, env } = spawnCall(spawnInTmux);
        expect(env.HAPPY_RECONNECT_SESSION_ID).toBe(happySessionId);
        expect(env.HAPPY_RECONNECT_ENCRYPTION_VARIANT).toBe('dataKey');
        expect(env.HAPPY_RECONNECT_SEQ).toBe('7');
        expect(env.HAPPY_RECONNECT_METADATA_VERSION).toBe('2');
        expect(env.HAPPY_RECONNECT_AGENT_STATE_VERSION).toBe('5');
        expect(env.HAPPY_RECONNECT_ENCRYPTION_KEY).toMatch(/^[A-Za-z0-9+/=]+$/);
        // The window's sanitizer must not unset the very keys this launch sets.
        expect(command).not.toMatch(/unset[^;]*HAPPY_RECONNECT_SESSION_ID/);
        // The daemon's own environment still reaches the window.
        expect(env.PATH).toBe('/usr/bin');
    });

    it('runs on the account the session was left on, as CLAUDE_CONFIG_DIR for DROVE-77 to seed', async () => {
        const { deps, spawnInTmux } = fakeDeps();
        const pickAccount = vi.fn((): DroverAccount => ({ name: 'jamrizzi', configDir: '/Users/clay/.claude-accounts/jamrizzi' }));

        await resumeInDroverWindow(deps, { happySessionId, metadata: claudeMetadata(), encryption, pickAccount, skipPermissions: false }, exists);

        expect(pickAccount).toHaveBeenCalledWith({ cwd: '/Users/clay/Projects/bitspur/cattle-drover', sessionId: claudeSessionId });
        const { env } = spawnCall(spawnInTmux);
        expect(env.CLAUDE_CONFIG_DIR).toBe('/Users/clay/.claude-accounts/jamrizzi');
        expect(env.DROVER_ACCOUNT).toBe('jamrizzi');
    });

    it('reaches the ambient account by UNSETTING CLAUDE_CONFIG_DIR, even when the daemon carries one', async () => {
        const { deps, spawnInTmux } = fakeDeps({
            ambientEnvironment: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/Users/clay/.claude-accounts/alt', DROVER_ACCOUNT: 'alt' },
        });
        const pickAccount = (): DroverAccount => ({ name: 'main', configDir: '/Users/clay/.claude', ambient: true });

        await resumeInDroverWindow(deps, { happySessionId, metadata: claudeMetadata(), encryption, pickAccount, skipPermissions: false }, exists);

        const { command, env } = spawnCall(spawnInTmux);
        expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
        expect(env.DROVER_ACCOUNT).toBe('main');
        expect(command).toMatch(/^unset [^;]*\bCLAUDE_CONFIG_DIR\b[^;]*; /);
    });

    it('leaves the account alone when there is no registry opinion', async () => {
        const { deps, spawnInTmux } = fakeDeps({ ambientEnvironment: { CLAUDE_CONFIG_DIR: '/Users/clay/.claude-accounts/alt' } });

        await resumeInDroverWindow(deps, { happySessionId, metadata: claudeMetadata(), encryption, pickAccount: () => undefined, skipPermissions: false }, exists);

        const { env } = spawnCall(spawnInTmux);
        expect(env.CLAUDE_CONFIG_DIR).toBe('/Users/clay/.claude-accounts/alt');
        expect(env.DROVER_ACCOUNT).toBeUndefined();
    });

    it('carries the model and permission mode the phone asked for', async () => {
        const { deps, spawnInTmux } = fakeDeps();

        await resumeInDroverWindow(deps, {
            happySessionId,
            metadata: claudeMetadata(),
            encryption,
            options: { model: 'opus', permissionMode: 'plan' },
            skipPermissions: true,
        }, exists);

        const { command } = spawnCall(spawnInTmux);
        expect(command).toContain("'--model' 'opus' '--permission-mode' 'plan' '--resume'");
        expect(command).not.toContain('--dangerously-skip-permissions');
    });

    it('applies the drover permission policy when the phone has no specific ask', () => {
        const launch = buildDaemonResumeLaunch({ happySessionId, metadata: claudeMetadata(), encryption, skipPermissions: true });

        expect(launch.modeArgs).toEqual(['--dangerously-skip-permissions']);
        expect(launch.agent).toBe('claude');
        expect(launch.resumeId).toBe(claudeSessionId);
    });

    it('FAILS with the tmux message when tmux is unreachable, starting nothing', async () => {
        const { deps, spawnInTmux, tracked } = fakeDeps({ isTmuxAvailable: async () => false });

        const result = await resumeInDroverWindow(deps, { happySessionId, metadata: claudeMetadata(), encryption, skipPermissions: false }, exists);

        expect(result).toEqual({ type: 'error', errorMessage: tmuxUnreachableMessage() });
        expect(spawnInTmux).not.toHaveBeenCalled();
        expect(tracked.size).toBe(0);
        expect(deps.awaitWebhook).not.toHaveBeenCalled();
    });

    it('fails when the saved path is gone rather than opening a window somewhere else', async () => {
        const { deps, spawnInTmux } = fakeDeps();

        const result = await resumeInDroverWindow(deps, { happySessionId, metadata: claudeMetadata(), encryption, skipPermissions: false }, async () => false);

        expect(result).toEqual({ type: 'error', errorMessage: 'Saved session path does not exist: /Users/clay/Projects/bitspur/cattle-drover' });
        expect(spawnInTmux).not.toHaveBeenCalled();
    });

    it('reports a tmux failure as nothing started, not as a headless session', async () => {
        const spawnInTmux = vi.fn(async () => ({ success: false, error: 'no server' }));
        const { deps, tracked } = fakeDeps({ tmuxFor: () => ({ spawnInTmux }) });

        const result = await resumeInDroverWindow(deps, { happySessionId, metadata: claudeMetadata(), encryption, skipPermissions: false }, exists);

        expect(result.type).toBe('error');
        expect((result as { errorMessage: string }).errorMessage).toMatch(/no server/);
        expect((result as { errorMessage: string }).errorMessage).toMatch(/Nothing was started headless/);
        expect(tracked.size).toBe(0);
    });

    it('refuses a Claude session that has no Claude id to resume', () => {
        expect(() => buildDaemonResumeLaunch({
            happySessionId,
            metadata: claudeMetadata({ claudeSessionId: undefined }),
            encryption,
            skipPermissions: false,
        })).toThrow(`Happy session ${happySessionId} is missing its Claude session ID.`);
    });

    it('resumes a Codex session through the same window, with no account decision', async () => {
        const { deps, spawnInTmux } = fakeDeps();
        const pickAccount = vi.fn(() => undefined);

        await resumeInDroverWindow(deps, {
            happySessionId,
            metadata: claudeMetadata({ flavor: 'codex', claudeSessionId: undefined, codexThreadId: 'thread-9' }),
            encryption,
            pickAccount,
            skipPermissions: true,
        }, exists);

        const { command } = spawnCall(spawnInTmux);
        expect(command).toContain("'/d/bin/drover' 'codex' '--happy-starting-mode' 'local' '--started-by' 'daemon' '--resume' 'thread-9'");
        expect(command).not.toContain('--dangerously-skip-permissions');
        expect(pickAccount).not.toHaveBeenCalled();
    });
});

describe('the account a resumed window starts on', () => {
    it('is no opinion when nothing was picked', () => {
        expect(accountStartEnvironment(undefined)).toEqual({ env: {}, unset: [] });
    });

    it('is a config dir plus a stamp for a registry account', () => {
        expect(accountStartEnvironment({ name: 'alt', configDir: '/a/alt' }))
            .toEqual({ env: { DROVER_ACCOUNT: 'alt', CLAUDE_CONFIG_DIR: '/a/alt' }, unset: [] });
    });

    it('is an UNSET for the ambient account, as drover account use does', () => {
        expect(accountStartEnvironment({ name: 'main', configDir: '/Users/clay/.claude', ambient: true }))
            .toEqual({ env: { DROVER_ACCOUNT: 'main' }, unset: ['CLAUDE_CONFIG_DIR'] });
    });
});

describe('the window path shared by spawn and resume', () => {
    it('names the window for the directory and forwards the requested tmux session', async () => {
        const { deps, spawnInTmux } = fakeDeps();

        await openDroverWindow(deps, {
            directory: '/Users/clay/Projects/x/my repo/',
            paneCommand: (bin) => `${bin} claude`,
            extraEnv: { FOO: 'bar' },
            tmuxSessionName: 'work',
            message: (w) => `opened ${w}`,
        });

        const { command, options, env } = spawnCall(spawnInTmux);
        expect(command).toMatch(/\/d\/bin\/drover claude$/);
        expect(options).toEqual({ sessionName: 'work', windowName: 'my-repo', cwd: '/Users/clay/Projects/x/my repo/' });
        expect(env.FOO).toBe('bar');
    });

    it('refuses without a wrapper on disk, naming the path', async () => {
        const { deps, spawnInTmux } = fakeDeps({ droverExists: () => false });

        const result = await openDroverWindow(deps, {
            directory: '/x',
            paneCommand: (bin) => bin,
            extraEnv: {},
            message: () => '',
        });

        expect(result).toMatchObject({ type: 'error' });
        expect((result as { errorMessage: string }).errorMessage).toContain('/d/bin/drover');
        expect(spawnInTmux).not.toHaveBeenCalled();
    });
});

// AC on DROVE-76: no daemon source asks for remote mode, and the direct spawn
// that used to be the resume path is gone rather than merely unused.
describe('the daemon has no headless path left', () => {
    const daemonDir = __dirname;
    const sources = readdirSync(daemonDir)
        .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
        .map((name) => [name, readFileSync(join(daemonDir, name), 'utf8')] as const);

    it('never asks for claudeStartingMode remote', () => {
        for (const [name, source] of sources) {
            expect(source, name).not.toMatch(/claudeStartingMode:\s*['"]remote['"]/);
            expect(source, name).not.toMatch(/--happy-starting-mode['"]?,?\s*['"]remote/);
        }
    });

    it('has no spawnTrackedHappyProcess to fall back to', () => {
        for (const [name, source] of sources) {
            // A definition or a call; prose may still say the name is gone.
            expect(source, name).not.toMatch(/\bspawnTrackedHappyProcess\s*[(=]/);
        }
    });
});

// DROVE-87: a NEW session started from the phone gets the account decision a
// terminal start and a phone Resume both make. The pane runs `drover claude
// ...`, agent name first, and bin/drover deliberately asks nothing for that
// shape, so the daemon decides, with the function the resume path uses.
describe('a phone-started NEW session', () => {
    const cwd = '/Users/clay/Projects/bitspur/cattle-drover';
    const registry: DroverAccount = { name: 'jamrizzi', configDir: '/Users/clay/.claude-accounts/jamrizzi' };
    const ambient: DroverAccount = { name: 'main', configDir: '/Users/clay/.claude', ambient: true };

    // What spawnSession in run.ts does with the decision, no more: decide,
    // merge the env, hand the unset list to the window.
    async function spawnLike(
        deps: DroverWindowDeps,
        input: { pickAccount?: PickStartAccount; requestEnv?: Record<string, string>; agent?: 'claude' | 'codex'; resumeId?: string; model?: string },
    ) {
        const agent = input.agent ?? 'claude';
        const requestEnv = input.requestEnv ?? {};
        const account = startAccountEnvironment({
            agent,
            cwd,
            resumeId: input.resumeId,
            model: input.model,
            requestEnv,
            ambientEnv: deps.ambientEnvironment,
            pickAccount: input.pickAccount,
        });
        return openDroverWindow(deps, {
            directory: cwd,
            paneCommand: (bin) => `${bin} ${agent} --happy-starting-mode local --started-by daemon`,
            extraEnv: { ...requestEnv, ...account.env },
            unsetKeys: account.unset,
            message: () => '',
        });
    }

    it('runs on the registry account the picker names, as CLAUDE_CONFIG_DIR plus the stamp', async () => {
        const { deps, spawnInTmux } = fakeDeps();
        const pickAccount = vi.fn((): DroverAccount => registry);

        await spawnLike(deps, { pickAccount });

        expect(pickAccount).toHaveBeenCalledTimes(1);
        expect(pickAccount).toHaveBeenCalledWith({ cwd });
        const { command, env } = spawnCall(spawnInTmux);
        expect(env.CLAUDE_CONFIG_DIR).toBe('/Users/clay/.claude-accounts/jamrizzi');
        expect(env.DROVER_ACCOUNT).toBe('jamrizzi');
        expect(command).toMatch(/drover claude --happy-starting-mode local --started-by daemon$/);
    });

    it('reaches the ambient account by UNSETTING CLAUDE_CONFIG_DIR the daemon carries', async () => {
        const { deps, spawnInTmux } = fakeDeps({
            ambientEnvironment: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/Users/clay/.claude-accounts/risserproperties', DROVER_ACCOUNT: 'risserproperties' },
        });

        await spawnLike(deps, { pickAccount: () => ambient });

        const { command, env } = spawnCall(spawnInTmux);
        expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
        expect(env.DROVER_ACCOUNT).toBe('main');
        expect(command).toMatch(/^unset [^;]*\bCLAUDE_CONFIG_DIR\b[^;]*; /);
    });

    it('leaves the account alone when the picker has no opinion', async () => {
        const { deps, spawnInTmux } = fakeDeps({ ambientEnvironment: { CLAUDE_CONFIG_DIR: '/Users/clay/.claude-accounts/alt' } });

        await spawnLike(deps, { pickAccount: () => undefined });

        const { command, env } = spawnCall(spawnInTmux);
        expect(env.CLAUDE_CONFIG_DIR).toBe('/Users/clay/.claude-accounts/alt');
        expect(env.DROVER_ACCOUNT).toBeUndefined();
        expect(command).not.toMatch(/\bCLAUDE_CONFIG_DIR\b/);
    });

    it('hands a fork its transcript id and the model the phone asked for, so whereabouts can answer', async () => {
        const { deps } = fakeDeps();
        const pickAccount = vi.fn((): DroverAccount => registry);

        await spawnLike(deps, { pickAccount, resumeId: claudeSessionId, model: 'opus' });

        expect(pickAccount).toHaveBeenCalledWith({ cwd, sessionId: claudeSessionId, model: 'opus' });
    });

    it('keeps an account the request itself names, and never asks', async () => {
        const { deps, spawnInTmux } = fakeDeps();
        const pickAccount = vi.fn((): DroverAccount => registry);

        await spawnLike(deps, { pickAccount, requestEnv: { CLAUDE_CONFIG_DIR: '/Users/clay/.claude-accounts/alt' } });
        expect(pickAccount).not.toHaveBeenCalled();
        expect(spawnCall(spawnInTmux).env.CLAUDE_CONFIG_DIR).toBe('/Users/clay/.claude-accounts/alt');

        await spawnLike(deps, { pickAccount, requestEnv: { DROVER_ACCOUNT: 'alt' } });
        expect(pickAccount).not.toHaveBeenCalled();
    });

    it('is switched off by DROVER_PICK_ACCOUNT=0, as bin/drover is', async () => {
        const { deps, spawnInTmux } = fakeDeps({ ambientEnvironment: { DROVER_PICK_ACCOUNT: '0' } });
        const pickAccount = vi.fn((): DroverAccount => registry);

        await spawnLike(deps, { pickAccount });

        expect(pickAccount).not.toHaveBeenCalled();
        expect(spawnCall(spawnInTmux).env.DROVER_ACCOUNT).toBeUndefined();
    });

    it('makes no account decision for Codex', async () => {
        const { deps } = fakeDeps();
        const pickAccount = vi.fn((): DroverAccount => registry);

        await spawnLike(deps, { pickAccount, agent: 'codex' });

        expect(pickAccount).not.toHaveBeenCalled();
    });
});

describe('the account decision is one decision, made once', () => {
    const cwd = '/Users/clay/Projects/bitspur/cattle-drover';
    const cases: [string, DroverAccount | undefined][] = [
        ['registry', { name: 'jamrizzi', configDir: '/Users/clay/.claude-accounts/jamrizzi' }],
        ['ambient', { name: 'main', configDir: '/Users/clay/.claude', ambient: true }],
        ['none', undefined],
    ];

    it.each(cases)('spawn and resume produce the same env for the same inputs (%s)', (_, account) => {
        const spawnPick = vi.fn(() => account);
        const resumePick = vi.fn(() => account);

        const spawned = startAccountEnvironment({ agent: 'claude', cwd, resumeId: claudeSessionId, model: 'opus', pickAccount: spawnPick });
        const resumed = buildDaemonResumeLaunch({
            happySessionId, metadata: claudeMetadata({ path: cwd }), encryption, options: { model: 'opus' }, pickAccount: resumePick, skipPermissions: false,
        });

        expect(spawnPick.mock.calls).toEqual(resumePick.mock.calls);
        expect(spawnPick).toHaveBeenCalledTimes(1);
        const accountKeys = (env: Record<string, string>) => Object.fromEntries(
            Object.entries(env).filter(([key]) => key === 'DROVER_ACCOUNT' || key === 'CLAUDE_CONFIG_DIR'),
        );
        expect(accountKeys(resumed.extraEnv)).toEqual(spawned.env);
        expect(resumed.unsetKeys).toEqual(spawned.unset);
    });

    it('run.ts asks the picker in one place and hands that one to spawn and resume', () => {
        const source = readFileSync(join(__dirname, 'run.ts'), 'utf8');
        // One wrapper around pickStartAccount, nothing inline.
        expect(source.match(/\bpickStartAccount\(/g)).toHaveLength(1);
        // The spawn path decides through startAccountEnvironment with that
        // wrapper; the resume path hands the same wrapper to
        // buildDaemonResumeLaunch, which calls the same function.
        expect(source.match(/\bstartAccountEnvironment\(\{/g)).toHaveLength(1);
        expect(source.match(/pickAccount: daemonPickAccount/g)).toHaveLength(2);
        expect(source).not.toMatch(/accountStartEnvironment\(/);
    });
});
