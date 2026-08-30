import { describe, expect, it } from 'vitest';

import { accountLoginCard, codeToSend, hostOf } from './droverAccountLogin';

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
