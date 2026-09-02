/**
 * The flip family in node (DROVE-315 wave 2b): one smoke test per verb against
 * the fixtures its bats file uses, plus the spec the fork never had.
 *
 * The fixtures are lifted from cattle-drover's tests/policy.bats (three
 * measured accounts and one nobody has logged into) and tests/backdoor.bats
 * (an ambient row, a twin on the same login, two ordinary accounts), so the
 * numbers and the sentences these assert are the ones the shell asserts.
 *
 * ONE PICKER, and the last test is the proof. `pickTarget` used to walk the
 * registry in order; nothing in the fork's suite pinned an order at all,
 * because every fixture with two measured accounts had them both at 100%.
 * So a two-account fixture at genuinely different sub-100 percents is what
 * shows the fork and `drover flip-policy rank` now answer with one voice.
 *
 * NOTHING REAL IS TOUCHED. HOME, DROVER_ACCOUNTS, STATE_DIR and XDG_STATE_HOME
 * all point inside a per-file temp dir, the bus is a stub on a kernel-picked
 * loopback port, and no tmux, daemon or credential is read.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'drover-flip-'));
const home = join(root, 'home');
const state = join(root, 'state');
mkdirSync(home, { recursive: true });
mkdirSync(state, { recursive: true });

const saved = { ...process.env };
process.env.HOME = home;
process.env.STATE_DIR = state;
process.env.XDG_STATE_HOME = join(root, 'xdg');
process.env.DROVER_ACCOUNTS = join(root, 'accounts.json');
delete process.env.DROVER_ACCOUNT;
delete process.env.TMUX;
delete process.env.TMUX_PANE;
delete process.env.DROVER_WRAPPER_PID;

const { rankAccounts, decide, best } = await import('../flip/rank');
const { pickTarget } = await import('../flip/accounts');
const policy = await import('./flip-policy');
const flip = await import('./flip');
const flipMenu = await import('./flip-menu');
const flipRequest = await import('./flip-request');

// --- the fixture -------------------------------------------------------------

/** An ISO reset six hours out, in the exact shape Claude Code caches it. */
function future(): string {
    return new Date(Date.now() + 6 * 3600 * 1000).toISOString().replace('Z', '+00:00');
}

/** One row of an account's usage cache. */
function limit(percent: number, family?: string) {
    return {
        kind: 'session',
        percent,
        resets_at: future(),
        scope: { model: family ? { display_name: family } : null },
    };
}

/** Write one account's .claude.json: onboarding, identity, usage cache. */
function usage(file: string, email: string, rows: ReturnType<typeof limit>[]): void {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify({
        hasCompletedOnboarding: true,
        oauthAccount: { emailAddress: email },
        cachedUsageUtilization: { utilization: { limits: rows } },
    }));
}

function registry(rows: Array<{ name: string; configDir: string }>): void {
    writeFileSync(process.env.DROVER_ACCOUNTS!, JSON.stringify(rows));
}

/** tests/policy.bats' `spread`: 70% / 12% / 95% left, and one with no login. */
function spread(): void {
    for (const d of ['a', 'b', 'c', 'd']) mkdirSync(join(root, d), { recursive: true });
    registry([
        { name: 'alpha', configDir: join(root, 'a') },
        { name: 'bravo', configDir: join(root, 'b') },
        { name: 'charlie', configDir: join(root, 'c') },
        { name: 'delta', configDir: join(root, 'd') },
    ]);
    usage(join(root, 'a', '.claude.json'), 'a@x.com', [limit(30)]);
    usage(join(root, 'b', '.claude.json'), 'b@x.com', [limit(88)]);
    usage(join(root, 'c', '.claude.json'), 'c@x.com', [limit(5)]);
    rmSync(join(root, 'd', '.claude.json'), { force: true });
}

/**
 * tests/backdoor.bats' `spread`: the back door is the FULLEST account in the
 * registry, so any test that lands somewhere else has actually skipped it
 * rather than merely ranked it low.
 */
function backdoorSpread(): void {
    for (const d of ['jam', 'ba', 'bb']) mkdirSync(join(root, d), { recursive: true });
    registry([
        { name: 'main', configDir: 'default' },
        { name: 'jamrizzi', configDir: join(root, 'jam') },
        { name: 'alpha', configDir: join(root, 'ba') },
        { name: 'bravo', configDir: join(root, 'bb') },
    ]);
    usage(join(home, '.claude.json'), 'jamrizzi@gmail.com', [limit(2)]);
    usage(join(root, 'jam', '.claude.json'), 'jamrizzi@gmail.com', [limit(2)]);
    usage(join(root, 'ba', '.claude.json'), 'a@x.com', [limit(40)]);
    usage(join(root, 'bb', '.claude.json'), 'b@x.com', [limit(70)]);
}

// --- a bus that is not the bus ------------------------------------------------

interface Seen { method: string; url: string; body: string }

let server: Server | null = null;
let seen: Seen[] = [];
let reply: (req: Seen) => { status: number; body: string } = () => ({ status: 200, body: '{}' });

async function startBus(): Promise<void> {
    seen = [];
    server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            const record = { method: req.method ?? '', url: req.url ?? '', body };
            seen.push(record);
            const out = reply(record);
            res.writeHead(out.status, { 'Content-Type': 'application/json' });
            res.end(out.body);
        });
    });
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
    const addr = server!.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    process.env.DROVER_URL = `http://127.0.0.1:${port}`;
    // Never the live bus. 7970 is the drover Clay is using and a test that
    // reached it would answer his real prompts.
    expect(port).not.toBe(7970);
}

async function stopBus(): Promise<void> {
    if (!server) return;
    await new Promise<void>((done) => server!.close(() => done()));
    server = null;
}

/** Run a verb and collect everything it wrote, split by stream. */
async function capture(run: (a: string[]) => Promise<number>, args: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const so = process.stdout.write.bind(process.stdout);
    const se = process.stderr.write.bind(process.stderr);
    (process.stdout as unknown as { write: unknown }).write = (c: unknown) => { out.push(String(c)); return true; };
    (process.stderr as unknown as { write: unknown }).write = (c: unknown) => { err.push(String(c)); return true; };
    try {
        const code = await run(args);
        return { code, out: out.join(''), err: err.join('') };
    } finally {
        (process.stdout as unknown as { write: unknown }).write = so;
        (process.stderr as unknown as { write: unknown }).write = se;
    }
}

beforeEach(async () => {
    reply = () => ({ status: 200, body: '{}' });
    rmSync(join(state, 'flip-policy.log'), { force: true });
    await startBus();
});

afterEach(async () => { await stopBus(); });

afterAll(() => {
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
});

// --- rank --------------------------------------------------------------------

describe('drover flip-policy rank', () => {
    it('orders by headroom, most to least, with the key on every row', async () => {
        // alpha is FIRST in the registry and has 70% left; charlie is third and
        // has 95%. Registry order says alpha, headroom says charlie, and
        // headroom is what Clay asked for. (tests/policy.bats)
        spread();
        const r = await capture(policy.run, ['rank', '--json']);
        expect(r.code).toBe(0);
        const rows = JSON.parse(r.out) as Array<{ name: string; key: string; eligible: boolean }>;
        expect(rows.map((x) => `${x.name}=${x.key}`)).toEqual([
            'charlie=95% left',
            'alpha=70% left',
            'bravo=12% left',
            'delta=no login',
        ]);
        // A flip onto a never-logged-in account lands in Claude Code's
        // first-run wizard, which a wrapped session cannot answer.
        expect(rows[3]!.eligible).toBe(false);

        // ... and the human table carries the same key.
        const human = await capture(policy.run, ['rank']);
        expect(human.out).toContain('  #  ACCOUNT              HEADROOM');
        expect(human.out).toMatch(/charlie .* 95% left/);
    });

    it('marks the ambient row and every row on its login as the back door, and nothing else', async () => {
        // By the config dir, never by the name (tests/backdoor.bats).
        backdoorSpread();
        const r = await capture(policy.run, ['rank', '--json']);
        const rows = JSON.parse(r.out) as Array<{ name: string; backdoor: boolean; eligible: boolean }>;
        const flags = Object.fromEntries(rows.map((x) => [x.name, x.backdoor]));
        expect(flags).toEqual({ main: true, jamrizzi: true, alpha: false, bravo: false });
        // Eligible is UNTOUCHED: a flip by hand still lands there, and folding
        // the rule into eligibility would delete main from the tmux picker.
        expect(rows.find((x) => x.name === 'main')!.eligible).toBe(true);

        const human = await capture(policy.run, ['rank']);
        expect(human.out).toMatch(/main .*back door — manual flips only/);
        expect(human.out).toMatch(/jamrizzi .*back door — manual flips only/);
        expect(human.out.split('\n').find((l) => l.includes('alpha'))).not.toContain('back door');
    });
});

// --- decide ------------------------------------------------------------------

describe('drover flip-policy decide', () => {
    it('takes the account with the most headroom and skips the back door', async () => {
        // main and jamrizzi rank 1 and 2 at 98% left; bravo is third at 30%.
        // The ordering is untouched — this is not a demotion — and the TARGET
        // is bravo. (tests/backdoor.bats)
        backdoorSpread();
        reply = () => ({ status: 200, body: JSON.stringify({ effective: { onLimit: 'auto' } }) });
        const r = await capture(policy.run, ['decide', '--session', 'S', '--account', 'alpha', '--family', 'fable', '--json']);
        expect(r.code).toBe(0);
        const d = JSON.parse(r.out);
        expect(d.action).toBe('auto');
        expect(d.account).toBe('bravo');
        expect(d.backdoorLastResort).toBeUndefined();
        // the ranking still puts the back door first, so nothing was reordered
        expect(d.ranked[0].name).toBe('main');
    });

    it('answers backdoor, not auto, for a session sitting on it', async () => {
        backdoorSpread();
        reply = () => ({ status: 200, body: JSON.stringify({ effective: { onLimit: 'auto' } }) });
        const r = await capture(policy.run, ['decide', '--session', 'S', '--account', 'main', '--family', 'fable', '--json']);
        const d = JSON.parse(r.out);
        expect(d.action).toBe('backdoor');
        expect(d.account).toBeNull();
        expect(d.why).toContain('is the back door account');
        expect(d.why).toContain('drover flip <account>');

        // and a twin on the same login says WHY it counts as the back door
        const twin = await capture(policy.run, ['decide', '--session', 'S', '--account', 'jamrizzi', '--family', 'fable', '--json']);
        expect(JSON.parse(twin.out).why).toContain('same claude.ai login as main');
    });

    it('takes the back door only when nothing else has the family or a rung under it, and says so', async () => {
        for (const d of ['jam', 'ba', 'bb']) mkdirSync(join(root, d), { recursive: true });
        registry([
            { name: 'main', configDir: 'default' },
            { name: 'jamrizzi', configDir: join(root, 'jam') },
            { name: 'alpha', configDir: join(root, 'ba') },
            { name: 'bravo', configDir: join(root, 'bb') },
        ]);
        usage(join(home, '.claude.json'), 'jamrizzi@gmail.com', [limit(5)]);
        usage(join(root, 'jam', '.claude.json'), 'jamrizzi@gmail.com', [limit(5)]);
        usage(join(root, 'ba', '.claude.json'), 'a@x.com', [limit(100)]);
        usage(join(root, 'bb', '.claude.json'), 'b@x.com', [limit(100)]);
        reply = () => ({ status: 200, body: JSON.stringify({ effective: { onLimit: 'auto', onFamilyExhausted: 'flip-then-downgrade' } }) });
        const r = await capture(policy.run, ['decide', '--session', 'S', '--account', 'alpha', '--family', 'fable', '--json']);
        const d = JSON.parse(r.out);
        expect(d.action).toBe('auto');
        expect(d.account).toBe('main');
        expect(d.backdoorLastResort).toBe(true);
        expect(d.why).toContain('BACK DOOR account, taken only because');
    });
});

// --- apply -------------------------------------------------------------------

describe('drover flip-policy apply', () => {
    it('POSTs a flip whose prompt names the account and why, and writes it down', async () => {
        // "says in the transcript which account it moved to and why" — the flip
        // frame's `prompt` overrides every other scope in the fork's resolver.
        spread();
        reply = (req) => req.url.startsWith('/v1/settings')
            ? { status: 200, body: JSON.stringify({ effective: { onLimit: 'auto' } }) }
            : { status: 200, body: '{"ok":true}' };
        const r = await capture(policy.run, ['apply', '--session', 'S', '--account', 'alpha', '--reason', 'usage limit']);
        expect(r.code).toBe(0);
        expect(r.out).toContain('flipped to charlie — charlie has the most headroom (95% left)');

        const posted = seen.find((s) => s.url === '/v1/flip');
        expect(posted).toBeDefined();
        const frame = JSON.parse(posted!.body);
        expect(frame.account).toBe('charlie');
        expect(frame.by).toBe('policy');
        expect(frame.sessionId).toBe('S');
        expect(frame.prompt).toContain('moved this session to the charlie account');
        expect(frame.prompt).toContain('Headroom there: 95% left.');

        // Every decision that moved a session is written down, because the
        // transcript is INSIDE the session that moved.
        const log = readFileSync(join(state, 'flip-policy.log'), 'utf8');
        expect(log).toContain('S');
        expect(log).toContain('auto');
        expect(log).toContain('charlie (95% left)');
    });

    it('on the back door flips nothing, parks nothing, and exits 5', async () => {
        // Exit 5 is its own code on purpose. 0 would read as "flipped", 3 as
        // "stopped", and 4 as "parked" — and a park is the one thing this must
        // not do, because a park resumes by itself, which is the auto-flip
        // under another name. (tests/backdoor.bats)
        backdoorSpread();
        reply = () => ({ status: 200, body: JSON.stringify({ effective: { onLimit: 'auto' } }) });
        const r = await capture(policy.run, ['apply', '--session', 'S', '--account', 'main', '--family', 'fable']);
        expect(r.code).toBe(5);
        expect(r.err).toContain('back door account');
        expect(r.out).not.toContain('flipped to');
        // It said it ONCE: no prompt was raised and no flip was posted.
        expect(seen.filter((s) => s.url === '/v1/flip' || s.url === '/v1/events')).toEqual([]);
        expect(readFileSync(join(state, 'flip-policy.log'), 'utf8')).toContain('backdoor');
    });

    it('raises a bus question whose options are in headroom order, and flips to the one chosen', async () => {
        spread();
        reply = (req) => {
            if (req.url.startsWith('/v1/settings')) {
                return { status: 200, body: JSON.stringify({ effective: { onLimit: 'prompt' } }) };
            }
            if (req.url === '/v1/events') return { status: 200, body: '{"id":"q1"}' };
            if (req.url.startsWith('/v1/events/q1/wait')) {
                return { status: 200, body: '{"resolution":{"optionId":"bravo"}}' };
            }
            return { status: 200, body: '{}' };
        };
        const r = await capture(policy.run, ['apply', '--session', 'S', '--account', 'alpha']);
        expect(r.code).toBe(0);
        expect(r.out).toContain('flipped to bravo');

        const asked = JSON.parse(seen.find((s) => s.url === '/v1/events')!.body);
        expect(asked.kind).toBe('question');
        expect(asked.origin.gate).toBe('flip-policy');
        expect(asked.options.map((o: { id: string; label: string }) => `${o.id}|${o.label}`)).toEqual([
            'charlie|charlie — 95% left',
            'bravo|bravo — 12% left',
            // staying put is always the last option: a prompt whose only exit
            // is the TTL is the stranded card this broker exists to kill
            '__stay|Stay here and park',
        ]);
        // alpha is the account we are ON, so it is not offered as a target
        expect(asked.options.some((o: { id: string }) => o.id === 'alpha')).toBe(false);
        // answering with the SECOND option flipped there, not to the top
        expect(JSON.parse(seen.find((s) => s.url === '/v1/flip')!.body).account).toBe('bravo');
    });

    it('parks with exit 4 when the answer is stay', async () => {
        spread();
        reply = (req) => {
            if (req.url.startsWith('/v1/settings')) return { status: 200, body: JSON.stringify({ effective: { onLimit: 'prompt' } }) };
            if (req.url === '/v1/events') return { status: 200, body: '{"id":"q1"}' };
            if (req.url.startsWith('/v1/events/q1/wait')) return { status: 200, body: '{"resolution":{"optionId":"__stay"}}' };
            return { status: 200, body: '{}' };
        };
        const r = await capture(policy.run, ['apply', '--session', 'S', '--account', 'alpha']);
        expect(r.code).toBe(4);
        expect(r.out).toContain('parked');
        expect(seen.some((s) => s.url === '/v1/flip')).toBe(false);
    });

    it('a prompt nobody answers does not drift onto the back door', async () => {
        // onLimitTimeout auto is the one branch the policy decides without
        // Clay, so it is an automatic choice and the rule applies to it too.
        // bravo has less headroom than main and is still the answer.
        backdoorSpread();
        reply = (req) => {
            if (req.url.startsWith('/v1/settings')) {
                return { status: 200, body: JSON.stringify({ effective: { onLimit: 'prompt', onLimitTimeout: 'auto', onLimitPromptTtlMs: 900 } }) };
            }
            if (req.url === '/v1/events') return { status: 200, body: '{"id":"q1"}' };
            if (req.url.startsWith('/v1/events/q1/wait')) return { status: 200, body: '{"state":"timeout"}' };
            return { status: 200, body: '{}' };
        };
        const r = await capture(policy.run, ['apply', '--session', 'S', '--account', 'alpha', '--family', 'fable']);
        expect(r.code).toBe(0);
        expect(r.out).toContain('nobody answered — flipped to bravo');
        expect(JSON.parse(seen.find((s) => s.url === '/v1/flip')!.body).account).toBe('bravo');
        expect(readFileSync(join(state, 'flip-policy.log'), 'utf8')).toContain('timeout-auto');
    });

    it('stops with exit 3 when the family is gone and switching cannot change the model', async () => {
        for (const d of ['a', 'b']) mkdirSync(join(root, d), { recursive: true });
        registry([{ name: 'alpha', configDir: join(root, 'a') }, { name: 'bravo', configDir: join(root, 'b') }]);
        usage(join(root, 'a', '.claude.json'), 'a@x.com', [limit(100, 'Fable 5'), limit(20, 'Opus 4.8')]);
        usage(join(root, 'b', '.claude.json'), 'b@x.com', [limit(100, 'Fable 5'), limit(30, 'Opus 4.8')]);
        reply = () => ({ status: 200, body: JSON.stringify({ effective: { onFamilyExhausted: 'flip-only' } }) });
        const r = await capture(policy.run, ['apply', '--session', 'S', '--family', 'fable', '--account', 'alpha']);
        expect(r.code).toBe(3);
        expect(r.err).toContain('STOPPED');
        expect(r.err).toContain('no account has fable');
        expect(r.err).toContain('account switching is set to flip-only');
        expect(r.err).toContain('drover settings set onFamilyExhausted downgrade-only');
    });

    it('falls back down the chain when the family is gone everywhere and the setting allows it', async () => {
        for (const d of ['a', 'b']) mkdirSync(join(root, d), { recursive: true });
        registry([{ name: 'alpha', configDir: join(root, 'a') }, { name: 'bravo', configDir: join(root, 'b') }]);
        usage(join(root, 'a', '.claude.json'), 'a@x.com', [limit(100, 'Fable 5'), limit(20, 'Opus 4.8')]);
        usage(join(root, 'b', '.claude.json'), 'b@x.com', [limit(100, 'Fable 5'), limit(65, 'Opus 4.8')]);
        reply = (req) => req.url.startsWith('/v1/settings')
            ? { status: 200, body: JSON.stringify({ effective: { onFamilyExhausted: 'fallback', familyFallback: { fable: ['opus', 'sonnet'] } } }) }
            : { status: 200, body: '{}' };
        const r = await capture(policy.run, ['decide', '--session', 'S', '--family', 'fable', '--account', 'bravo', '--json']);
        const d = JSON.parse(r.out);
        expect(d.action).toBe('fallback');
        expect(d.family).toBe('opus');
        expect(d.fromFamily).toBe('fable');
        // alpha has 80% of Opus left, bravo 35% — and the CURRENT account is
        // not excluded in a fallback pass, because falling back is a change of
        // model and staying put while changing model is the cheapest answer.
        expect(d.account).toBe('alpha');
    });

    it('refuses an unknown verb with 2 and a missing flag value by name', async () => {
        const bad = await capture(policy.run, ['wibble']);
        expect(bad.code).toBe(2);
        expect(bad.err).toContain("unknown verb 'wibble'");
        const missing = await capture(policy.run, ['rank', '--family']);
        expect(missing.code).toBe(2);
        expect(missing.err).toContain('--family needs a value');
    });
});

// --- flip --------------------------------------------------------------------

describe('drover flip', () => {
    it('POSTs the frame for this pane and says so; --all needs no pane', async () => {
        spread();
        reply = (req) => req.url.startsWith('/v1/sessions')
            ? { status: 200, body: JSON.stringify({ sessions: [{ id: 'x', pane: '%9', state: 'running' }] }) }
            : { status: 200, body: '{"ok":true}' };
        process.env.TMUX_PANE = '%9';
        const r = await capture(flip.run, ['charlie']);
        expect(r.code).toBe(0);
        expect(r.out).toContain('flip requested (charlie)');
        const frame = JSON.parse(seen.find((s) => s.url === '/v1/flip')!.body);
        expect(frame).toMatchObject({ pane: '%9', account: 'charlie', by: 'cli', reason: 'manual' });
        // It never comes through the policy — the escape hatch is a straight
        // POST the fork's controller takes on its `wanted` branch (DROVE-333).
        expect(seen.some((s) => s.url.includes('settings'))).toBe(false);

        delete process.env.TMUX_PANE;
        const nowhere = await capture(flip.run, []);
        expect(nowhere.code).toBe(2);
        expect(nowhere.err).toContain('not in tmux and no target given');
    });

    it('says when the bus lists no live session for the target', async () => {
        reply = (req) => req.url.startsWith('/v1/sessions')
            ? { status: 200, body: '{"sessions":[]}' }
            : { status: 200, body: '{}' };
        const r = await capture(flip.run, ['--session', 'gone']);
        expect(r.code).toBe(0);
        expect(r.err).toContain('the bus lists no live session for this target');
        expect(r.err).toContain('it is not drover-managed and cannot flip');
    });
});

// --- flip-menu ---------------------------------------------------------------

describe('drover flip-menu', () => {
    it('--pick-any resolves through the SAME ranking the menu is sorted by', async () => {
        // A bare `drover flip` posts account:null and lets the controller pick,
        // so the top entry of a headroom-sorted menu could flip you somewhere
        // other than the first row you were looking at.
        spread();
        reply = () => ({ status: 200, body: '{"sessions":[]}' });
        process.env.TMUX_PANE = '%3';
        const r = await capture(flipMenu.run, ['--pick-any', '--pane', '%3']);
        expect(r.code).toBe(0);
        expect(JSON.parse(seen.find((s) => s.url === '/v1/flip')!.body)).toMatchObject({
            account: 'charlie', pane: '%3', by: 'tmux',
        });
        delete process.env.TMUX_PANE;
    });

    it('refuses outside tmux, and names a flag with no value', async () => {
        delete process.env.TMUX;
        const outside = await capture(flipMenu.run, []);
        expect(outside.code).toBe(2);
        expect(outside.err).toContain('not inside tmux');
        const missing = await capture(flipMenu.run, ['--pane']);
        expect(missing.code).toBe(2);
        expect(missing.err).toContain('--pane needs a value');
    });
});

// --- flip-request -------------------------------------------------------------

describe('drover flip-request', () => {
    it('says a session is not drover-managed rather than posting into the void, and exits 0', async () => {
        delete process.env.DROVER_WRAPPER_PID;
        const r = await capture(flipRequest.run, []);
        expect(r.code).toBe(0);
        expect(r.out).toContain('this session is not drover-managed, so /flip cannot move it');
        expect(seen).toEqual([]);
    });

    it('posts for a wrapped session, addressed by claude session id', async () => {
        spread();
        process.env.DROVER_WRAPPER_PID = String(process.pid);
        process.env.CLAUDE_CODE_SESSION_ID = 'abc';
        reply = () => ({ status: 200, body: '{"ok":true}' });
        const r = await capture(flipRequest.run, ['bravo']);
        expect(r.code).toBe(0);
        expect(r.out).toContain('flip requested (-> bravo)');
        expect(JSON.parse(seen.find((s) => s.url === '/v1/flip')!.body)).toMatchObject({
            sessionId: 'abc', account: 'bravo', by: 'terminal',
        });
        delete process.env.DROVER_WRAPPER_PID;
        delete process.env.CLAUDE_CODE_SESSION_ID;
    });
});

// --- one picker ---------------------------------------------------------------

describe('one picker (DROVE-315 wave 2b)', () => {
    it('pickTarget takes the account with the most headroom, the same one rank puts first', async () => {
        // THE PROOF, and the fork never had it. Every fixture in flip.test.ts
        // with two measured accounts has them both at 100%, so the ranking
        // degenerates to a tie and registry order survives untested. Here alpha
        // is FIRST in the registry with 70% left and charlie is third with 95%,
        // which is the one arrangement that tells the two orders apart.
        spread();
        const target = pickTarget(undefined, null, Date.now(), 'fable');
        expect(target.kind).toBe('account');
        expect(target.kind === 'account' && target.account.name).toBe('charlie');
        // ... and it is the row `drover flip-policy rank` puts at the top.
        expect(rankAccounts({ family: 'fable' })[0]!.name).toBe('charlie');
        expect(best(rankAccounts({ family: 'fable' }))!.name).toBe('charlie');
    });

    it('pickTarget skips the back door for the same reason decide does', async () => {
        backdoorSpread();
        const target = pickTarget('alpha', null, Date.now(), 'fable');
        expect(target.kind === 'account' && target.account.name).toBe('bravo');
        const d = decide({
            family: 'fable',
            exclude: 'alpha',
            settings: { onLimit: 'auto', onFamilyExhausted: 'flip-then-downgrade', chain: ['opus', 'sonnet'] },
        });
        expect(d.account).toBe('bravo');
    });

    it('leaves nothing under the real home, and never reached the live bus', () => {
        expect(process.env.HOME).toBe(home);
        expect(existsSync(join(home, '.happy'))).toBe(false);
        expect(process.env.DROVER_URL).not.toContain(':7970');
    });
});
