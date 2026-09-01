import { describe, expect, it } from 'vitest';

import { accountLoginCard, clipboardCode, codeToSend, hostOf } from './droverAccountLogin';

describe('accountLoginCard', () => {
    it('reads the card the drover bridge mints', () => {
        expect(accountLoginCard({
            url: 'https://claude.com/cai/oauth/authorize?code=true&state=abc',
            header: 'Log in to Claude for account-2',
            reason: 'Open this in a browser, sign in, then send back the code it shows.',
            cancelLabel: 'Cancel the login',
        })).toEqual({
            url: 'https://claude.com/cai/oauth/authorize?code=true&state=abc',
            header: 'Log in to Claude for account-2',
            reason: 'Open this in a browser, sign in, then send back the code it shows.',
            cancelLabel: 'Cancel the login',
        });
    });

    it('refuses anything that is not an https link', () => {
        // The URL is handed to the share sheet and then to a browser. A card
        // that drew a sign-in button for some other scheme would be asking to
        // be tapped on something nobody vouched for.
        expect(accountLoginCard({ url: 'http://claude.com/x' })).toBeNull();
        expect(accountLoginCard({ url: 'javascript:alert(1)' })).toBeNull();
        expect(accountLoginCard({ url: '' })).toBeNull();
        expect(accountLoginCard({})).toBeNull();
        expect(accountLoginCard(null)).toBeNull();
    });

    it('fills in the labels a sparse card leaves out', () => {
        expect(accountLoginCard({ url: 'https://claude.com/x' })).toEqual({
            url: 'https://claude.com/x',
            header: 'Log in to Claude',
            reason: '',
            cancelLabel: 'Cancel',
        });
    });
});

describe('codeToSend', () => {
    it('trims, because a code copied off a page carries whitespace', () => {
        // A blank text resolution is refused by the bus, which would read on
        // the phone as a Send button that did nothing at all.
        expect(codeToSend('  ac_123#state \n')).toBe('ac_123#state');
        expect(codeToSend('   ')).toBeNull();
        expect(codeToSend('')).toBeNull();
    });

    it('leaves the middle of the token alone', () => {
        // Claude Code's login code is <code>#<state> and is opaque. Tidying it
        // is how a correct paste becomes a 400.
        expect(codeToSend('AbC-_9#st.at-e')).toBe('AbC-_9#st.at-e');
    });
});

describe('hostOf', () => {
    it('names where the link goes, so the tap is not blind', () => {
        expect(hostOf('https://claude.com/cai/oauth/authorize?x=1')).toBe('claude.com');
        expect(hostOf('not a url')).toBe('not a url');
    });
});

describe('clipboardCode (DROVE-335)', () => {
    // One tap sends whatever is on the clipboard to a `claude auth login` that
    // is blocked on stdin with two tries. So the refusals are the feature: a
    // wrong paste spends one of them and comes back "Invalid code".
    it('takes a real code, whitespace and all', () => {
        expect(clipboardCode('  ac_9fK2-tR#st.at-e \n')).toEqual({ code: 'ac_9fK2-tR#st.at-e' });
        expect(clipboardCode('AbC-_9xyz#state')).toEqual({ code: 'AbC-_9xyz#state' });
    });

    it('refuses the sign-in link, by name', () => {
        // The commonest wrong paste, because the link is one tap away on the
        // row above and it is what was on the clipboard a minute ago.
        const refused = clipboardCode('https://claude.com/cai/oauth/authorize?code=true&state=abc');
        expect(refused).toEqual({ refused: expect.stringContaining('sign-in link') });
        expect(clipboardCode('http://example.com/x')).toEqual({ refused: expect.stringContaining('sign-in link') });
    });

    it('refuses a paragraph', () => {
        expect(clipboardCode('Sign in, then paste the code below'))
            .toEqual({ refused: expect.stringContaining('more than one word') });
        expect(clipboardCode('ac_123#state extra')).toEqual({ refused: expect.stringContaining('more than one word') });
    });

    it('refuses an empty clipboard rather than sending nothing', () => {
        expect(clipboardCode('')).toEqual({ refused: expect.stringContaining('nothing on the clipboard') });
        expect(clipboardCode('   \n ')).toEqual({ refused: expect.stringContaining('nothing on the clipboard') });
        expect(clipboardCode(null)).toEqual({ refused: expect.stringContaining('nothing on the clipboard') });
        expect(clipboardCode(undefined)).toEqual({ refused: expect.stringContaining('nothing on the clipboard') });
    });

    it('refuses lengths no token has', () => {
        expect(clipboardCode('abc')).toEqual({ refused: expect.stringContaining('too short') });
        expect(clipboardCode('a'.repeat(513))).toEqual({ refused: expect.stringContaining('too long') });
        // ...and takes the ones that do, right up to the edges.
        expect(clipboardCode('abcdefgh')).toEqual({ code: 'abcdefgh' });
        expect(clipboardCode('a'.repeat(512))).toEqual({ code: 'a'.repeat(512) });
    });

    it('refuses characters no code carries', () => {
        expect(clipboardCode('{"code":"abc"}')).toEqual({ refused: expect.stringContaining('characters no login code') });
        expect(clipboardCode('code<script>')).toEqual({ refused: expect.stringContaining('characters no login code') });
    });

    it('is not a shape test for Claude Code\u2019s own format', () => {
        // Anthropic owns <code>#<state>. A validator that knew it too well
        // would be a login that breaks on their next release, so a plain
        // token with no fragment goes through.
        expect(clipboardCode('sk-nofragmenthere')).toEqual({ code: 'sk-nofragmenthere' });
    });
});
