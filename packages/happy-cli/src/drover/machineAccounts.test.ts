/**
 * The machine-scoped account list and removal (DROVE-165).
 *
 * The registry, the login state and the usage cache are stubbed, so what is
 * pinned here is the JOIN and the refusals, not the readers — those have their
 * own tests in flip/. Specifically: that the row carries the address and the
 * config dir the phone needs, that no row is ever marked current, that the
 * ambient login cannot be removed from a phone, and that a wrapper failure
 * comes back as `{ ok: false }` rather than a throw.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/drover/flip/accounts', () => ({
    readAccounts: () => registry,
    loginEmail: (a: { name: string }) => emails[a.name],
    sameLoginAs: (a: { name: string }) => twins[a.name],
    isAmbientSpelling: (dir: unknown) => dir === 'default' || dir === '~/.claude',
}));

vi.mock('@/drover/flip/usage', () => ({
    usageSnapshot: (current: string | undefined, now: number) => ({
        capturedAt: now,
        accounts: registry.map((a) => ({
            name: a.name,
            current: a.name === current,
            loggedIn: emails[a.name] !== undefined,
            fetchedAt: null,
            headroom: headroom[a.name] ?? null,
            cooling: null,
            limits: [],
        })),
    }),
}));

type Row = { name: string; configDir: string; ambient?: boolean };

let registry: Row[] = [];
let emails: Record<string, string | undefined> = {};
let twins: Record<string, string | undefined> = {};
let headroom: Record<string, number | null> = {};

const {
    listMachineAccounts,
    readMachineAccounts,
    removeMachineAccount,
    validRemovableAccountName,
    describeDroverError,
} = await import('./machineAccounts');

function seedThreeAccounts(): void {
    registry = [
        { name: 'main', configDir: 'default', ambient: true },
        { name: 'jamrizzi', configDir: '/Users/clay/.claude-accounts/jamrizzi' },
        { name: 'risserproperties', configDir: '/Users/clay/.claude-accounts/risserproperties' },
    ];
    emails = {
        main: 'clayrisser@gmail.com',
        jamrizzi: 'jamrizzi@gmail.com',
        risserproperties: 'clayrisser@gmail.com',
    };
    twins = { risserproperties: 'main' };
    headroom = { main: 12, jamrizzi: 43, risserproperties: 12 };
}

describe('readMachineAccounts', () => {
    it('joins the registry onto the usage snapshot, keeping registry order', () => {
        seedThreeAccounts();
        const { accounts } = readMachineAccounts(1_000);
        expect(accounts.map((a) => a.name)).toEqual(['main', 'jamrizzi', 'risserproperties']);
        expect(accounts[1]).toMatchObject({
            name: 'jamrizzi',
            configDir: '/Users/clay/.claude-accounts/jamrizzi',
            ambient: false,
            loggedIn: true,
            login: 'jamrizzi@gmail.com',
            sameLoginAs: null,
            headroom: 43,
        });
    });

    it('marks the ambient row, which is the one the phone must not touch', () => {
        seedThreeAccounts();
        const { accounts } = readMachineAccounts(1_000);
        expect(accounts[0]).toMatchObject({ name: 'main', ambient: true });
        expect(accounts[2].ambient).toBe(false);
    });

    it('names the row a twin duplicates, so two identical bars do not read as a bug', () => {
        // DROVE-21: main and risserproperties hold ONE claude.ai login, so they
        // share one quota. The list says so rather than showing two rows with
        // the same numbers and no explanation.
        seedThreeAccounts();
        const { accounts } = readMachineAccounts(1_000);
        expect(accounts[2]).toMatchObject({ name: 'risserproperties', sameLoginAs: 'main' });
    });

    it('marks NO row current, because current is a session fact', () => {
        // The daemon has no DROVER_ACCOUNT and no CLAUDE_CONFIG_DIR. Any answer
        // it invented would mark the ambient account current on a Mac where
        // every live session is somewhere else.
        seedThreeAccounts();
        const { accounts } = readMachineAccounts(1_000);
        expect(accounts.every((a) => a.current === false)).toBe(true);
    });

    it('carries capturedAt, so the screen can say how fresh the numbers are', () => {
        seedThreeAccounts();
        expect(readMachineAccounts(1_700_000_000_000).capturedAt).toBe(1_700_000_000_000);
    });

    it('reports an account that has never been logged in', () => {
        registry = [{ name: 'spare', configDir: '/Users/clay/.claude-accounts/account-4' }];
        emails = {};
        twins = {};
        headroom = {};
        const { accounts } = readMachineAccounts(1_000);
        expect(accounts[0]).toMatchObject({ loggedIn: false, login: null, headroom: null });
    });
});

describe('listMachineAccounts', () => {
    it('answers ok with the rows', () => {
        seedThreeAccounts();
        const result = listMachineAccounts(1_000);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.accounts).toHaveLength(3);
    });

    it('turns a broken registry into an error, never into an empty list', () => {
        // "No accounts on this machine" is the one thing an unreadable
        // accounts.json must not say: the screen would offer to add a second
        // account to a Mac that already has five.
        registry = [];
        Object.defineProperty(registry, 'map', {
            value: () => { throw new Error('accounts.json: unexpected token'); },
        });
        const result = listMachineAccounts(1_000);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain('unexpected token');
    });
});

describe('validRemovableAccountName', () => {
    it('takes the names an account can actually have', () => {
        expect(validRemovableAccountName('clayrisser@gmail.com')).toBe(true);
        expect(validRemovableAccountName('bitspur.com')).toBe(true);
        expect(validRemovableAccountName('account-1')).toBe(true);
    });

    it('refuses what no account could be called', () => {
        expect(validRemovableAccountName('a/b')).toBe(false);
        expect(validRemovableAccountName('-purge')).toBe(false);
        expect(validRemovableAccountName('.hidden')).toBe(false);
        expect(validRemovableAccountName('two words')).toBe(false);
        expect(validRemovableAccountName('')).toBe(false);
    });
});

describe('removeMachineAccount', () => {
    const deps = (run: (args: string[]) => Promise<string>) => ({
        droverBin: '/d/bin/drover',
        exists: () => true,
        run,
    });

    it('runs the wrapper WITHOUT --purge', async () => {
        // Purging deletes the config dir and cannot be undone from a phone,
        // while the login itself is a Keychain item that survives it anyway.
        seedThreeAccounts();
        const calls: string[][] = [];
        const result = await removeMachineAccount(
            { name: 'jamrizzi' },
            deps(async (args) => { calls.push(args); return "removed 'jamrizzi'\n"; }),
        );
        expect(calls).toEqual([['account', 'rm', 'jamrizzi']]);
        expect(result).toEqual({ ok: true, name: 'jamrizzi', message: "removed 'jamrizzi'" });
    });

    it('refuses the ambient login without running anything', async () => {
        seedThreeAccounts();
        const run = vi.fn();
        const result = await removeMachineAccount({ name: 'main' }, deps(run as never));
        expect(run).not.toHaveBeenCalled();
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain('ambient login');
    });

    it('passes the wrapper refusal through verbatim', async () => {
        // `drover account rm` owns the three refusals that make removal safe
        // (last account, live session, ledger). Its stderr IS the answer.
        seedThreeAccounts();
        const result = await removeMachineAccount({ name: 'jamrizzi' }, deps(async () => {
            throw Object.assign(new Error('exit 2'), {
                stderr: "drover account: a live session is running on 'jamrizzi'.\n",
            });
        }));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain('a live session is running');
    });

    it('needs a name, and refuses one no account could have', async () => {
        seedThreeAccounts();
        expect((await removeMachineAccount({}, deps(async () => ''))).ok).toBe(false);
        expect((await removeMachineAccount({ name: '  ' }, deps(async () => ''))).ok).toBe(false);
        const bad = await removeMachineAccount({ name: 'a/b' }, deps(async () => ''));
        expect(bad.ok).toBe(false);
        if (!bad.ok) expect(bad.error).toContain('not a usable account name');
    });

    it('says where the wrapper should have been when it is missing', async () => {
        seedThreeAccounts();
        const result = await removeMachineAccount({ name: 'jamrizzi' }, {
            droverBin: '/nope/bin/drover',
            exists: () => false,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('/nope/bin/drover');
            expect(result.error).toContain('DROVER_BIN');
        }
    });

    it('removes a name that is not in the registry at all, letting the wrapper say so', async () => {
        // The ambient guard reads the registry, and a name it does not know is
        // not ambient. `drover account rm` is the one that says "no account
        // 'ghost'", so it gets to.
        seedThreeAccounts();
        const result = await removeMachineAccount({ name: 'ghost' }, deps(async () => {
            throw Object.assign(new Error('exit 2'), { stderr: "no account 'ghost' in accounts.json\n" });
        }));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain("no account 'ghost'");
    });
});

describe('describeDroverError', () => {
    it('prefers stderr, because that is the sentence a person can act on', () => {
        expect(describeDroverError(Object.assign(new Error('exit 2'), { stderr: ' boom \n' })))
            .toBe('boom');
        expect(describeDroverError(new Error('spawn ENOENT'))).toBe('spawn ENOENT');
        expect(describeDroverError('plain')).toBe('plain');
    });
});
