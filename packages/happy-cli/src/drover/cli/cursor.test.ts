/**
 * The vitest twin of the `drover cursor` half of cattle-drover/tests/cli.bats,
 * plus the refusal cases tests/cursor-auth.bats pins (DROVE-315).
 *
 * Nothing here touches a real anything. Every run gets a mkdtemp HOME, a
 * mkdtemp STATE_DIR, a mkdtemp CURSOR_CONFIG_DIR and an injected io whose
 * `launch`, `enter` and `pick` THROW unless the case under test expects them —
 * so a port that reached for the live bus, the machine's tmux server, Clay's
 * ~/.cursor/hooks.json or a real cursor-agent would fail the test rather than
 * do it quietly. The CursorAuth port is always a fake: no test on this machine
 * reads a credential, from the store, the Keychain or anywhere else.
 *
 * One differential runs the SHELL verb (`sh libexec/drover-cursor --help`) and
 * compares its stdout byte for byte with the node verb's, because the help text
 * is a thing a human reads and a paraphrase of it is a regression. A second
 * does the same for `--print-hooks`, which is the read-only path people are
 * told about when they want to see what would be merged.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A throwaway HAPPY_HOME_DIR, pinned above every import. This file never starts
 * a session and never calls defaultIo(), but the leak that registered
 * seventy-eight real sessions on Clay's phone came from a tree where nothing
 * said no. This does.
 */
const happyHome = vi.hoisted(() => {
    // require, not the file's imports: vi.hoisted runs before every one of them.
    const fs = require('node:fs') as typeof import('node:fs');
    const os = require('node:os') as typeof import('node:os');
    const path = require('node:path') as typeof import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drover-cursor-happy-'));
    process.env.HAPPY_HOME_DIR = dir;
    return dir;
});

import {
    cursorLaunch,
    cursorTokenState,
    desiredHooks,
    mergeHooks,
    run,
    type CursorAuth,
    type CursorIo,
    type CursorTokenState,
} from './cursor';

const shellRoot = '/Users/clayrisser/Projects/bitspur/cattle-drover';
const shellVerb = join(shellRoot, 'libexec', 'drover-cursor');

const temps: string[] = [];
function tempDir(tag: string): string {
    const dir = mkdtempSync(join(tmpdir(), `drover-cursor-${tag}-`));
    temps.push(dir);
    return dir;
}

afterAll(() => {
    for (const dir of [...temps, happyHome]) rmSync(dir, { recursive: true, force: true });
});

/** A store that answers from a literal table and never opens a file. */
function fakeAuth(table: Record<string, { code: number; state?: CursorTokenState; renew?: string | null }> = {}): CursorAuth {
    return {
        runEnv: (account) => {
            const row = table[account];
            if (!row) return { code: 1, lines: [] };
            if (row.code !== 0) return { code: row.code, lines: [] };
            return { code: 0, lines: ['CURSOR_AUTH_TOKEN=tok-for-' + account, 'AGENT_CLI_CREDENTIAL_STORE=memory'] };
        },
        token: (account) => (table[account] ? `tok-for-${account}` : null),
        state: (token) => {
            for (const [name, row] of Object.entries(table)) {
                if (token === `tok-for-${name}`) return row.state ?? 'live';
            }
            return 'unreadable';
        },
        renewWarn: async (account) => table[account]?.renew ?? null,
    };
}

interface Harness {
    io: CursorIo;
    stdout: () => string;
    stderr: () => string;
    launched: () => string[] | null;
    entered: () => string[] | null;
    home: string;
    cursorHome: string;
    hooksFile: string;
    forkDir: string;
    droverDir: string;
}

/**
 * One fully isolated launch. `which` finds a cursor-agent by default (the
 * preflight is not what most of these cases are about); every door out —
 * launch, enter, pick — throws until a case opts into it.
 */
function harness(opts: {
    env?: Record<string, string | undefined>;
    auth?: CursorAuth;
    which?: (name: string) => string | null;
    pick?: (mode: 'pick' | 'latest') => { status: number; chatId: string };
    forkExists?: boolean;
} = {}): Harness {
    const home = tempDir('home');
    const stateDir = join(home, 'state');
    const cursorHome = join(home, 'cursorconf');
    const forkDir = join(home, 'fork');
    const droverDir = join(home, 'checkout');
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(droverDir, { recursive: true });
    if (opts.forkExists !== false) mkdirSync(join(forkDir, 'packages', 'happy-cli'), { recursive: true });

    let out = '';
    let err = '';
    let launched: string[] | null = null;
    let entered: string[] | null = null;

    const io: CursorIo = {
        env: {
            HOME: home,
            PATH: '/nonexistent-for-tests',
            STATE_DIR: stateDir,
            DROVER_DIR: droverDir,
            FORK_DIR: forkDir,
            CURSOR_CONFIG_DIR: cursorHome,
            DROVER_ALLOW_NO_TMUX: '1',
            ...opts.env,
        },
        cwd: '/tmp/proj',
        home,
        out: (line) => { out += `${line}\n`; },
        err: (line) => { err += `${line}\n`; },
        which: opts.which ?? ((name) => (name === 'cursor-agent' ? '/stub/cursor-agent' : null)),
        auth: opts.auth ?? fakeAuth(),
        pick: opts.pick ?? (() => { throw new Error('the picker must not run in this test'); }),
        enter: async (argv) => { entered = argv; return 0; },
        launch: async (argv) => { launched = argv; return 0; },
        now: () => new Date(Date.UTC(2026, 8, 2, 3, 4, 5)),
    };
    return {
        io,
        stdout: () => out,
        stderr: () => err,
        launched: () => launched,
        entered: () => entered,
        home,
        cursorHome,
        hooksFile: join(cursorHome, 'hooks.json'),
        forkDir,
        droverDir,
    };
}

describe('drover cursor', () => {
    beforeEach(() => {
        expect(process.env.HAPPY_HOME_DIR).toBe(happyHome);
    });

    it('prints the shell HELPTEXT byte for byte, before anything else runs', async () => {
        // The io's every door throws or is absent; a help that reached the env,
        // the store or a subprocess would fail here rather than pass.
        const h = harness({ which: () => { throw new Error('help must not preflight'); } });
        expect(await run(['--help'], h.io)).toBe(0);
        expect(await run(['-h'], h.io)).toBe(0);

        const shell = execFileSync('sh', [shellVerb, '--help'], { encoding: 'utf8' });
        // Both spellings ran, so node's capture is the text twice.
        expect(h.stdout()).toBe(shell + shell);
        expect(h.stderr()).toBe('');
    });

    it('--print-hooks reads only, names both adapters under --gate, and matches the shell', async () => {
        const real = harness({ env: { DROVER_DIR: shellRoot } });
        expect(await run(['--print-hooks'], real.io)).toBe(0);
        expect(real.stdout()).toBe(execFileSync('sh', [shellVerb, '--print-hooks'], { encoding: 'utf8' }));

        const gated = harness({ env: { DROVER_DIR: shellRoot } });
        expect(await run(['--gate', '--print-hooks'], gated.io)).toBe(0);
        expect(gated.stdout()).toBe(execFileSync('sh', [shellVerb, '--gate', '--print-hooks'], { encoding: 'utf8' }));

        // No gate unless asked: ~/.cursor/hooks.json is also what Cursor's IDE
        // reads, so a blocking hook there changes every Cursor window.
        expect(real.stdout()).toContain('cursor-session.sh');
        expect(real.stdout()).not.toContain('cursor-permission-gate');
        expect(gated.stdout()).toContain('cursor-permission-gate.sh');
        // Reads only.
        expect(existsSync(real.hooksFile)).toBe(false);
        expect(existsSync(gated.hooksFile)).toBe(false);
    });

    it('refuses a bad --seed in both spellings, and writes no hooks doing it', async () => {
        const bare = harness();
        expect(await run(['--seed'], bare.io)).toBe(2);
        expect(bare.stderr()).toBe('drover cursor: --seed needs a file\n');
        expect(existsSync(bare.hooksFile)).toBe(false);

        const empty = harness();
        expect(await run(['--seed='], empty.io)).toBe(2);
        expect(empty.stderr()).toBe('drover cursor: --seed needs a file\n');

        const missing = harness();
        const nope = join(missing.home, 'nope.md');
        expect(await run(['--seed', nope], missing.io)).toBe(2);
        expect(missing.stderr()).toBe(`drover cursor: cannot read the seed file '${nope}'\n`);
        expect(existsSync(missing.hooksFile)).toBe(false);

        const named = harness();
        expect(await run(['--account'], named.io)).toBe(2);
        expect(named.stderr()).toBe('drover cursor: --account needs a name\n');
    });

    it('says so and exits 127 when cursor-agent is not on PATH', async () => {
        const h = harness({ which: () => null });
        expect(await run([], h.io)).toBe(127);
        expect(h.stderr()).toBe(
            'drover cursor: cursor-agent is not on PATH.\n'
            + '  install it:  curl https://cursor.com/install -fsS | sh\n',
        );
        expect(h.launched()).toBeNull();
        expect(existsSync(h.hooksFile)).toBe(false);
    });

    it('re-enters through the shared window opener with the flags it was actually given', async () => {
        // The parse loop has already eaten --resume abc123 by the time the pane
        // check runs, so re-entering on what is LEFT would open a window running
        // a plain `drover cursor`.
        const dry = harness({ env: { DROVER_ALLOW_NO_TMUX: undefined, TMUX: undefined, DROVER_DRY_RUN: '1' } });
        expect(await run(['--resume', 'abc123'], dry.io)).toBe(0);
        const libexec = join(dry.droverDir, 'libexec');
        expect(dry.stdout()).toBe(
            `${join(libexec, 'drover-tmux-enter')} --cwd /tmp/proj -- ${join(libexec, 'drover-cursor')} '--resume' 'abc123'\n`,
        );
        expect(dry.entered()).toBeNull();

        // Without the dry run it goes through runEnter, not a launch.
        const live = harness({ env: { DROVER_ALLOW_NO_TMUX: undefined, TMUX: undefined } });
        expect(await run(['--resume', 'abc123'], live.io)).toBe(0);
        expect(live.entered()).toEqual([
            '--cwd', '/tmp/proj', '--', join(live.droverDir, 'libexec', 'drover-cursor'), '--resume', 'abc123',
        ]);
        expect(live.launched()).toBeNull();

        // And the escape hatch stays an escape hatch: asked for headless, it
        // opens nothing.
        const headless = harness({ env: { TMUX: undefined, DROVER_DRY_RUN: '1' } });
        expect(await run([], headless.io)).toBe(0);
        expect(headless.stdout()).not.toContain('drover-tmux-enter');
        expect(headless.entered()).toBeNull();
    });

    it('refuses a dead account before the session starts, and writes no hooks file', async () => {
        const expired = harness({ auth: fakeAuth({ 'dead@example.com': { code: 2, state: 'expired' } }) });
        expect(await run(['--account', 'dead@example.com'], expired.io)).toBe(4);
        expect(expired.stderr()).toContain("the cursor login for 'dead@example.com' has expired.");
        expect(expired.stderr()).toContain('      drover account login --harness cursor dead@example.com');
        expect(expired.stderr()).not.toContain('registered drover hooks');
        expect(existsSync(expired.hooksFile)).toBe(false);

        // A tombstone is a different sentence: something signed the account out,
        // and telling him his login lapsed sends him to look at the wrong thing.
        const dead = harness({ auth: fakeAuth({ 'gone@example.com': { code: 2, state: 'tombstone' } }) });
        expect(await run(['--account', 'gone@example.com'], dead.io)).toBe(4);
        expect(dead.stderr()).toContain("drover cursor: 'gone@example.com' has been signed out of Cursor.");
        expect(existsSync(dead.hooksFile)).toBe(false);

        const unknown = harness({ auth: fakeAuth({}) });
        expect(await run(['--account', 'none@example.com'], unknown.io)).toBe(2);
        expect(unknown.stderr()).toContain("drover cursor: no cursor token stored for 'none@example.com'.");
        expect(existsSync(unknown.hooksFile)).toBe(false);
    });

    it('hands a live account its own token inline, with the memory store and the renew warning', async () => {
        const h = harness({ auth: fakeAuth({ jam: { code: 0, state: 'renew', renew: '5' } }) });
        h.io.env.CURSOR_API_KEY = 'sk-should-not-survive';
        expect(await run(['--account', 'jam'], h.io)).toBe(0);
        expect(h.io.env.CURSOR_AUTH_TOKEN).toBe('tok-for-jam');
        expect(h.io.env.AGENT_CLI_CREDENTIAL_STORE).toBe('memory');
        expect(h.io.env.DROVER_ACCOUNT).toBe('jam');
        expect(h.io.env.DROVER_HARNESS).toBe('cursor');
        // A stray key can never bill Clay for a session he asked to run on a
        // subscription.
        expect(h.io.env.CURSOR_API_KEY).toBeUndefined();
        expect(h.stderr()).toContain("drover cursor: the login for 'jam' expires in 5 day(s) and cannot");
        // A renew token still RUNS. The warning never parks work.
        expect(h.launched()).toEqual(['cursor']);
    });

    it('merges its hooks without stomping the ones already there, and is idempotent', async () => {
        const h = harness();
        mkdirSync(h.cursorHome, { recursive: true });
        writeFileSync(h.hooksFile, `${JSON.stringify({
            version: 1,
            hooks: {
                beforeSubmitPrompt: [{ command: 'mine.sh' }],
                beforeShellExecution: [{ command: 'also-mine.sh' }, { command: 'stale.sh', _drover: 'session' }],
            },
        }, null, 2)}\n`);

        expect(await run([], h.io)).toBe(0);
        const after = JSON.parse(readFileSync(h.hooksFile, 'utf8'));
        const commands = [
            ...after.hooks.beforeSubmitPrompt.map((e: { command: string }) => e.command),
            ...after.hooks.beforeShellExecution.map((e: { command: string }) => e.command),
        ];
        expect(commands).toContain('mine.sh');
        expect(commands).toContain('also-mine.sh');
        expect(commands.some((c: string) => c.endsWith('adapters/cursor-session.sh'))).toBe(true);
        // A hand-written entry survives; drover's own previous entry does not
        // get a second copy beside it.
        expect(commands).not.toContain('stale.sh');
        expect(h.stderr()).toContain(`drover cursor: registered drover hooks in ${h.hooksFile}`);

        // Backed up ONCE, before the first write, and never again.
        const backups = join(h.home, 'state', 'backups');
        expect(readdirSync(backups).filter((f) => f.endsWith('.bak'))).toHaveLength(1);

        const before = readFileSync(h.hooksFile, 'utf8');
        const again = harness({
            env: { STATE_DIR: join(h.home, 'state'), CURSOR_CONFIG_DIR: h.cursorHome, DROVER_DIR: h.droverDir },
        });
        expect(await run([], again.io)).toBe(0);
        expect(readFileSync(h.hooksFile, 'utf8')).toBe(before);
        expect(again.stderr()).not.toContain('registered drover hooks');
        expect(readdirSync(backups).filter((f) => f.endsWith('.bak'))).toHaveLength(1);
    });

    it('a dry run prints the old command line and never touches the machine-wide file', async () => {
        const h = harness({ env: { DROVER_DRY_RUN: '1' } });
        const seed = join(h.home, 'My Clones', 'retold.md');
        mkdirSync(join(h.home, 'My Clones'), { recursive: true });
        writeFileSync(seed, 'THE WHOLE SEED\n');

        expect(await run(['--gate', '--seed', seed, '--force'], h.io)).toBe(0);
        // TWO spaces after `cursor`, and that is the shell's, not a typo. With
        // no --resume, args_pre starts empty and `args_pre="$args_pre --gated"`
        // gives it a leading space, which the one double-quoted echo keeps.
        // This line is what the bats grep, so it is reproduced rather than
        // tidied.
        expect(h.stdout()).toBe(
            `node ${join(h.forkDir, 'packages', 'happy-cli')}/bin/drover.mjs cursor  --gated --seed ${seed} --force\n`,
        );
        // The path, never the content.
        expect(h.stdout()).not.toContain('THE WHOLE SEED');
        // The incident, as a test: DROVER_DRY_RUN=1 from a worktree rewrote the
        // real file. An ABSENT file is the sharpest assertion available.
        expect(existsSync(h.hooksFile)).toBe(false);
        expect(h.launched()).toBeNull();
    });

    it('hands the runner one argv, with a spaced seed path intact and a picked chat id resolved', async () => {
        const h = harness({ pick: (mode) => ({ status: 0, chatId: mode === 'latest' ? 'chat-latest' : 'chat-picked' }) });
        const seed = join(h.home, 'My Clones', 'retold.md');
        mkdirSync(join(h.home, 'My Clones'), { recursive: true });
        writeFileSync(seed, 'seeded\n');

        expect(await run(['--continue', '--seed', seed, '--force'], h.io)).toBe(0);
        // The bars of the bats assertion, as an array: one argv word, space and all.
        expect(h.launched()).toEqual(['cursor', '--resume', 'chat-latest', '--seed', seed, '--force']);

        const picked = harness({ pick: () => ({ status: 0, chatId: 'chat-picked' }) });
        expect(await run(['--resume', '--gate'], picked.io)).toBe(0);
        expect(picked.launched()).toEqual(['cursor', '--resume', 'chat-picked', '--gated']);

        // --resume <id> is passed straight through, no picker.
        const direct = harness();
        expect(await run(['--resume', 'abc123'], direct.io)).toBe(0);
        expect(direct.launched()).toEqual(['cursor', '--resume', 'abc123']);

        // A picker that declines takes its exit code with it.
        const refused = harness({ pick: () => ({ status: 7, chatId: '' }) });
        expect(await run(['--continue'], refused.io)).toBe(7);
        expect(refused.launched()).toBeNull();
        expect(existsSync(refused.hooksFile)).toBe(false);
    });

    it('refuses when the fork is missing, before the picker and before the hooks', async () => {
        const h = harness({ forkExists: false, pick: () => { throw new Error('the picker runs after the fork check'); } });
        expect(await run(['--continue'], h.io)).toBe(1);
        expect(h.stderr()).toBe(`drover cursor: fork not found at ${h.forkDir}\n`);
        expect(existsSync(h.hooksFile)).toBe(false);
    });

    it('the pure pieces answer the way the shell library did', () => {
        // The merge drops drover's own entries and keeps everyone else's, and an
        // event drover no longer wants loses its stale entry rather than keeping
        // an empty stub.
        const merged = JSON.parse(mergeHooks(
            JSON.stringify({ version: 2, hooks: { preToolUse: [{ command: 'old.sh', _drover: 'gate' }], other: [{ command: 'theirs.sh' }] } }),
            { sessionStart: [{ command: 'new.sh', _drover: 'session' }] },
        ));
        expect(merged.version).toBe(2);
        expect(merged.hooks.preToolUse).toBeUndefined();
        expect(merged.hooks.other).toEqual([{ command: 'theirs.sh' }]);
        expect(merged.hooks.sessionStart).toEqual([{ command: 'new.sh', _drover: 'session' }]);

        // `expiring` is refused with `expired`: a token with four minutes left
        // dies mid-turn. `unreadable` is NOT assumed dead.
        const now = 1_800_000_000;
        const tok = (exp: number): string => `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.y`;
        expect(cursorTokenState(tok(now + 5_000_000), now)).toBe('live');
        expect(cursorTokenState(tok(now + 100_000), now)).toBe('renew');
        expect(cursorTokenState(tok(now + 100), now)).toBe('expiring');
        expect(cursorTokenState(tok(now - 1), now)).toBe('expired');
        expect(cursorTokenState(tok(1), now)).toBe('tombstone');
        expect(cursorTokenState('not-a-jwt', now)).toBe('unreadable');

        // args_pre splits on spaces because it is drover's own flags; the seed
        // rides beside it because it is a path a human chose.
        expect(cursorLaunch('--resume id --gated', '/a b/seed.md', ['--force']).argv)
            .toEqual(['cursor', '--resume', 'id', '--gated', '--seed', '/a b/seed.md', '--force']);
        expect(cursorLaunch('', null, []).argv).toEqual(['cursor']);

        expect(desiredHooks('/r', false)).not.toContain('permission-gate');
        expect(desiredHooks('/r', true)).toContain('/r/adapters/cursor-permission-gate.sh');
    });
});
