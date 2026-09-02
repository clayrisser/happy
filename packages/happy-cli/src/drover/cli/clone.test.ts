/**
 * `drover clone`, ported (DROVE-315). What this pins is the SEAM and the
 * REFUSALS — the parts the shell file owned — not the seed itself, which is
 * engine/export.js's and stays pinned by cattle-drover/tests/clone.bats.
 *
 * Nothing here reaches a bus, a tmux server, a transcript of Clay's, or the
 * real STATE_DIR. Every port either answers from a fixture or throws: the
 * `sessions`, `exportSeed` and `tmux` defaults below throw by name, so a test
 * that forgot to inject fails loudly instead of quietly driving the machine.
 * The state dir is one mkdtemp per test.
 *
 * One case is DIFFERENTIAL: it runs the SHELL verb's `--help` and compares the
 * bytes to the node verb's. The usage is the contract a person reads, so it is
 * compared rather than described.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { run, type CloneIo } from './clone';

/** The shell file this is a port of, at the path etc/drover.env defaults to. */
const shellClone = join(homedir(), 'Projects', 'bitspur', 'cattle-drover', 'libexec', 'drover-clone');

interface Rig {
    dir: string;
    state: string;
    root: string;
    repo: string;
    transcript: string;
    io: CloneIo;
    out: () => string;
    err: () => string;
    exports: string[][];
    ledger: () => unknown[];
}

function rig(overrides: Partial<CloneIo> & { env?: Record<string, string | undefined> } = {}): Rig {
    const { env: envOverride, ...ports } = overrides;
    const dir = mkdtempSync(join(tmpdir(), 'drover-clone-'));
    const state = join(dir, 'state');
    const root = join(dir, 'checkout');
    const repo = join(dir, 'repo');
    const transcript = join(dir, 'session.jsonl');
    mkdirSync(state, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(transcript, '{"type":"user","message":{"role":"user","content":"HELLO"}}\n');
    const outs: string[] = [];
    const errs: string[] = [];
    const exports: string[][] = [];
    const io: CloneIo = {
        env: {
            STATE_DIR: state,
            DROVER_DIR: root,
            DROVER_URL: 'http://127.0.0.1:1',
            HOME: dir,
            ...(envOverride ?? {}),
        },
        cwd: repo,
        pid: 4242,
        now: () => new Date('2026-09-02T01:23:45.678Z'),
        out: (t) => {
            outs.push(t);
        },
        err: (t) => {
            errs.push(t);
        },
        sessions: () => {
            throw new Error('a test reached the live bus');
        },
        exportSeed: (_root, args) => {
            exports.push(args);
            const at = args.indexOf('--out');
            // The fake seed is the CONVERSATION, so a test can prove the pane
            // command carries a path and never the content.
            if (at >= 0) writeFileSync(args[at + 1], 'THE WHOLE CONVERSATION\n');
            return 0;
        },
        tmux: () => {
            throw new Error('a test reached the live tmux server');
        },
        ...ports,
    };
    return {
        dir,
        state,
        root,
        repo,
        transcript,
        io,
        out: () => outs.join(''),
        err: () => errs.join(''),
        exports,
        ledger: () => JSON.parse(readFileSync(join(state, 'clones.json'), 'utf8')) as unknown[],
    };
}

describe('drover clone — help', () => {
    it('prints the usage, exits 0, and asks nothing of the machine', async () => {
        const r = rig();
        expect(await run(['--help'], r.io)).toBe(0);
        expect(await run(['-h'], r.io)).toBe(0);
        const text = r.out();
        expect(text.startsWith('drover clone — seed a NEW session in another harness with this one\'s\n')).toBe(true);
        expect(text).toContain('  --to <harness>        where it lands (default claude)');
        expect(text).toContain('  drover clone <session> --to claude|opencode|cursor|pi');
        expect(text).toContain('  drover clone --list               every clone this machine has made');
        expect(text.endsWith('See also: drover flip (same session, another account) · docs/clone.md\n')).toBe(true);
        expect(r.exports).toHaveLength(0);
        expect(existsSync(join(r.state, 'clones.json'))).toBe(false);
    });

    it('is byte for byte the shell verb\'s own usage', async () => {
        const r = rig();
        const shell = spawnSync('sh', [shellClone, '--help'], { encoding: 'utf8' });
        expect(shell.status).toBe(0);
        expect(await run(['--help'], r.io)).toBe(0);
        expect(r.out()).toBe(shell.stdout);
    });
});

describe('drover clone — the option loop refuses the same things', () => {
    it('names an unknown option, a non-numeric --turns and an unknown harness, and records nothing', async () => {
        const r = rig();
        expect(await run(['--nope'], r.io)).toBe(2);
        expect(r.err()).toContain('drover clone: unknown option --nope (try --help)');

        const t = rig();
        expect(await run(['--transcript', t.transcript, '--turns', 'lots'], t.io)).toBe(2);
        expect(t.err()).toContain('drover clone: --turns needs a number, got \'lots\'');

        // A harness nobody has driven is refused rather than guessed at, and a
        // clone that never happened leaves no row behind.
        const h = rig();
        expect(await run(['--transcript', h.transcript, '--to', 'emacs'], h.io)).toBe(2);
        expect(h.err()).toContain('drover clone: unknown harness \'emacs\' (claude, opencode, cursor, pi)');
        expect(existsSync(join(h.state, 'clones.json'))).toBe(false);
        expect(h.exports).toHaveLength(0);
    });
});

describe('drover clone --list', () => {
    it('says so when there is no ledger, and shows a row whose clone has not spoken', async () => {
        const r = rig();
        expect(await run(['--list'], r.io)).toBe(0);
        expect(r.out()).toBe('no clones yet\n');

        const w = rig();
        writeFileSync(
            join(w.state, 'clones.json'),
            JSON.stringify([
                { at: '2026-09-02T01:23:45Z', from: 'abcdef0123456789', to: null, harness: 'claude', cwd: '/tmp/x' },
            ]),
            { flag: 'w' },
        );
        expect(await run(['--list'], w.io)).toBe(0);
        expect(w.out()).toBe('2026-09-02T01:23:45Z  abcdef01 -> (not started yet)  claude  /tmp/x\n');
    });
});

describe('drover clone — which session', () => {
    it('an unreachable bus is one sentence and --transcript is the way out', async () => {
        const r = rig({
            env: { TMUX_PANE: '%9' },
            sessions: () => Promise.reject(new Error('ECONNREFUSED')),
        });
        expect(await run([], r.io)).toBe(1);
        expect(r.err()).toBe(
            'drover clone: the bus is unreachable at http://127.0.0.1:1, so there is no way\n'
            + '  to look a session id up. Start it (drover status), or name the file:\n'
            + '  drover clone --transcript <path/to/session.jsonl> --cwd <dir>\n',
        );
    });

    it('no session named and no pane to read one from is refused with 2', async () => {
        const r = rig({ sessions: () => Promise.resolve('{"sessions":[]}') });
        expect(await run([], r.io)).toBe(2);
        expect(r.err()).toBe(
            'drover clone: no session named and not inside tmux, so there is no\n'
            + '  pane to read one from. Name it: drover clone <session id>\n'
            + '  (drover sessions lists them)\n',
        );
    });

    it('an ambiguous prefix lists the matches, and a session with no transcript says why', async () => {
        const two = JSON.stringify({
            sessions: [
                { id: 'ab111111', cwd: '/tmp/one', transcript: '/tmp/a.jsonl', lastActivity: 2 },
                { id: 'ab222222', cwd: '/tmp/two', transcript: '/tmp/b.jsonl', lastActivity: 9 },
            ],
        });
        const r = rig({ sessions: () => Promise.resolve(two) });
        expect(await run(['ab'], r.io)).toBe(2);
        // Newest first — sort_by(-.lastActivity) — and both spelled out.
        expect(r.err()).toBe(
            'drover clone: \'ab\' matches 2 sessions:\n'
            + '  ab222222  /tmp/two\n'
            + '  ab111111  /tmp/one\n',
        );

        const none = rig({
            sessions: () => Promise.resolve(JSON.stringify({ sessions: [{ id: 'cd333333', cwd: '/tmp/x' }] })),
        });
        expect(await run(['cd'], none.io)).toBe(1);
        expect(none.err()).toBe(
            'drover clone: session cd333333 has written no transcript yet, so there is\n'
            + '  no conversation to clone. Say something to it first.\n',
        );
    });
});

describe('drover clone — the seed and the window', () => {
    it('--seed-only writes the file under the state dir and prints its path', async () => {
        const r = rig();
        expect(await run(['--transcript', r.transcript, '--cwd', r.repo, '--seed-only', '--no-diff'], r.io)).toBe(0);
        const seed = r.out().trim();
        expect(seed.startsWith(join(r.state, 'clones'))).toBe(true);
        expect(readFileSync(seed, 'utf8')).toContain('THE WHOLE CONVERSATION');
        // The exporter got the argument list the shell built, --no-diff and all.
        expect(r.exports[0]).toEqual([
            '--transcript', r.transcript,
            '--turns', '40',
            '--session', 'session',
            '--to', 'claude',
            '--cwd', r.repo,
            '--no-diff',
            '--out', seed,
        ]);
        expect(existsSync(join(r.state, 'clones.json'))).toBe(false);
    });

    it('the dry run prints the tmux line and records its half of the lineage first', async () => {
        const r = rig({ env: { TMUX: 'fake', DROVER_DRY_RUN: '1' } });
        expect(await run(['--transcript', r.transcript, '--cwd', r.repo, '--no-diff'], r.io)).toBe(0);
        const line = r.out();
        expect(line.startsWith(`tmux new-window -c ${r.repo} -n clone-${basename(r.repo)} -e DROVER_CLONE_ID=20260902T012345Z-4242 `)).toBe(true);
        expect(line).toContain(`exec '${join(r.root, 'bin', 'drover')}' --seed '`);
        expect(line.endsWith('.md\'\n')).toBe(true);

        const rows = r.ledger() as Record<string, unknown>[];
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            id: '20260902T012345Z-4242',
            at: '2026-09-02T01:23:45Z',
            from: 'session',
            to: null,
            harness: 'claude',
            cwd: r.repo,
            account: null,
            turns: 40,
        });
    });

    it('the cursor lane carries the seed BY PATH, never the conversation', async () => {
        const r = rig({ env: { TMUX: 'fake', DROVER_DRY_RUN: '1' } });
        expect(await run(['--transcript', r.transcript, '--cwd', r.repo, '--to', 'cursor', '--no-diff'], r.io)).toBe(0);
        const line = r.out();
        expect(line).toContain(`exec '${join(r.root, 'bin', 'drover')}' cursor --seed '`);
        expect(line).toContain('.md\'');
        // A retold conversation is tens of kilobytes and one quote in it would
        // turn the tmux command line into a syntax error.
        expect(line).not.toContain('THE WHOLE CONVERSATION');
    });

    it('outside tmux it refuses with 3 and still leaves the seed behind', async () => {
        const r = rig();
        expect(await run(['--transcript', r.transcript, '--cwd', r.repo, '--no-diff'], r.io)).toBe(3);
        const err = r.err();
        expect(err).toContain('drover clone: not inside tmux — a clone is a real session, so it needs a');
        expect(err).toContain('  window to be a session IN (DROVE-1). The seed is written:');
        expect(err).toContain('  Start tmux and run this again, or start the harness yourself with it.');
        const seed = err.match(/\S+\.md/)?.[0];
        expect(seed).toBeTruthy();
        expect(readFileSync(seed as string, 'utf8')).toContain('THE WHOLE CONVERSATION');
        // Refused before the row: a clone that never happened is not recorded.
        expect(existsSync(join(r.state, 'clones.json'))).toBe(false);
    });
});
