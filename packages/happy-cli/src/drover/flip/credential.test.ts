/**
 * An address is not a credential (DROVE-238).
 *
 * Clay added four accounts from his phone. All four listed, all four had an
 * `oauthAccount` in their config dir, and flipping onto any of them stranded
 * the session: "it actually showed they added but when I tried to flip to them
 * it actually got stuck on these screens and I had to actually authenticate it
 * in the terminal as it wasn't ACTUALLY authenticated."
 *
 * `isLoggedIn` reads a file, and the file holds the ADDRESS. The token is a
 * second write, to the macOS Keychain, keyed to the config dir's path, and a
 * login driven from a background daemon does not always land it. So the file
 * says yes and the account cannot run.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
    credentialDeniedRecently,
    forgetCredentialProbes,
    isLoggedIn,
    noteCredentialProbe,
    type DroverAccount,
} from './accounts';
import { credentialProbeEnv, probeCredential, readLoggedIn, refreshCredentialState } from './credential';

function account(name: string, configDir = '/tmp/drove238/' + name): DroverAccount {
    return { name, configDir, ambient: false } as DroverAccount;
}

beforeEach(() => {
    forgetCredentialProbes();
});

describe('readLoggedIn', () => {
    it('reads the boolean Claude Code answers with', () => {
        expect(readLoggedIn('{"loggedIn":true,"authMethod":"claude.ai"}')).toBe('yes');
        expect(readLoggedIn('{"loggedIn":false,"authMethod":"none"}')).toBe('no');
    });

    it('calls anything it cannot get a boolean out of unknown, never no', () => {
        // The whole safety property. A machine where the probe cannot run has
        // to behave the way it did before, not lose every account at once.
        expect(readLoggedIn('')).toBe('unknown');
        expect(readLoggedIn('claude: command not found')).toBe('unknown');
        expect(readLoggedIn('{"loggedIn":"yes"}')).toBe('unknown');
        expect(readLoggedIn('{}')).toBe('unknown');
    });
});

describe('probeCredential', () => {
    it('judges the body, not the exit status', async () => {
        // `claude auth status` EXITS 1 when it is not logged in — measured
        // 2026-08-31, the same run that found the bug. A reader that treated a
        // nonzero exit as a failed probe would call the commonest honest answer
        // unreadable, and the phantom accounts would go on listing.
        const state = await probeCredential(account('alt'), {
            run: async () => '{"loggedIn":false,"authMethod":"none"}',
        });
        expect(state).toBe('no');
    });

    it('is unknown when the probe itself blows up', async () => {
        const state = await probeCredential(account('alt'), {
            run: async () => { throw new Error('ENOENT claude'); },
        });
        expect(state).toBe('unknown');
    });
});

describe('what a probe does to isLoggedIn', () => {
    it('a no beats the file, which is the whole point', () => {
        const alt = account('alt');
        // No config dir on disk at all, so the file read below would say false
        // anyway — what is pinned is that the probe answers FIRST, before any
        // filesystem read, so a dir that does hold an oauthAccount is demoted
        // too.
        noteCredentialProbe(alt, false);
        expect(credentialDeniedRecently(alt)).toBe(true);
        expect(isLoggedIn(alt)).toBe(false);
    });

    it('a yes clears the record rather than storing one', () => {
        const alt = account('alt');
        noteCredentialProbe(alt, false);
        noteCredentialProbe(alt, true);
        expect(credentialDeniedRecently(alt)).toBe(false);
    });

    it('forgets a no after ten minutes', () => {
        // Clay fixed his four accounts by hand at the terminal. A record that
        // outlived that fix would keep a working account off the picker, so it
        // expires on its own even if nothing ever probes again.
        const alt = account('alt');
        noteCredentialProbe(alt, false, 1_000);
        expect(credentialDeniedRecently(alt, 1_000 + 9 * 60_000)).toBe(true);
        expect(credentialDeniedRecently(alt, 1_000 + 11 * 60_000)).toBe(false);
    });

    it('keeps the ambient login apart from a config dir spelled the same', () => {
        // The ambient account is reached by UNSETTING CLAUDE_CONFIG_DIR, and
        // its configDir field is a spelling like `default` — two ambient rows
        // must not be told apart by it, and a real dir must not collide with
        // one.
        const ambient = { name: 'main', configDir: 'default', ambient: true } as DroverAccount;
        noteCredentialProbe(ambient, false);
        expect(credentialDeniedRecently(ambient)).toBe(true);
        expect(credentialDeniedRecently(account('alt', 'default'))).toBe(false);
    });
});

describe('refreshCredentialState', () => {
    it('records the noes and leaves the unknowns alone', async () => {
        const dead = account('dead');
        const live = account('live');
        const mute = account('mute');
        await refreshCredentialState([dead, live, mute], {
            probe: async (a) => (a.name === 'dead' ? 'no' : a.name === 'live' ? 'yes' : 'unknown'),
        });
        expect(credentialDeniedRecently(dead)).toBe(true);
        expect(credentialDeniedRecently(live)).toBe(false);
        // An account nothing could tell us about is not demoted. This is the
        // difference between "we asked and it said no" and "we could not ask".
        expect(credentialDeniedRecently(mute)).toBe(false);
    });

    it('does not throw when a probe rejects', async () => {
        const alt = account('alt');
        await expect(refreshCredentialState([alt], {
            probe: async () => { throw new Error('spawn EACCES'); },
        })).resolves.toBeUndefined();
        expect(credentialDeniedRecently(alt)).toBe(false);
    });
});

describe('credentialProbeEnv', () => {
    it('drops an ambient key, which would sign off on every phantom account', () => {
        // Measured 2026-08-31 against a config dir with no credential at all:
        // `claude auth status` answers {"loggedIn": true, "authMethod":
        // "api_key"} whenever ANTHROPIC_API_KEY is set, and "oauth_token" for
        // ANTHROPIC_AUTH_TOKEN. Leave either in and the probe agrees with the
        // file it was written to disbelieve.
        const env = credentialProbeEnv(account('alt'), {
            HOME: '/Users/clay',
            ANTHROPIC_API_KEY: 'sk-ant-x',
            ANTHROPIC_AUTH_TOKEN: 'tok',
        });
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    });

    it('still points Claude Code at the account being asked about', () => {
        expect(credentialProbeEnv(account('alt'), { HOME: '/Users/clay' }).CLAUDE_CONFIG_DIR)
            .toBe('/tmp/drove238/alt');
    });

    it('reaches the ambient account by UNSETTING the config dir, never by naming it', () => {
        // Pointing CLAUDE_CONFIG_DIR at ~/.claude probes a different account:
        // the ambient config file is ~/.claude.json at the root of $HOME.
        const ambient = { name: 'main', configDir: 'default', ambient: true } as DroverAccount;
        const env = credentialProbeEnv(ambient, { HOME: '/Users/clay', CLAUDE_CONFIG_DIR: '/x' });
        expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    });

    it('does not mutate the environment it was handed', () => {
        const base = { HOME: '/Users/clay', ANTHROPIC_API_KEY: 'sk-ant-x' };
        credentialProbeEnv(account('alt'), base);
        expect(base.ANTHROPIC_API_KEY).toBe('sk-ant-x');
    });
});
