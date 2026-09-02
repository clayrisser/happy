import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { accountLoginCard, clipboardCode, hostOf, loginControls, loginHarness } from './droverAccountLogin';

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
            harness: 'claude',
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
            harness: 'claude',
        });
    });
});

describe('loginHarness (DROVE-351)', () => {
    // Whose login this is decides whether there is a code step at all, and the
    // three surfaces that draw this card hand it the arguments and nothing
    // else — so it has to be readable off the card or it is not readable at
    // all on two of them.
    it('reads cursor off drover\u2019s own header', () => {
        expect(loginHarness({
            header: 'Log in to Cursor for a new cursor account',
            url: 'https://cursor.com/loginDeepControl?challenge=x',
        })).toBe('cursor');
    });

    it('reads cursor off the link when the header says nothing', () => {
        // Belt to the header's braces: the header is drover's string and the
        // link is the one cursor-agent printed, and either alone is enough.
        expect(loginHarness({ header: 'Log in', url: 'https://cursor.com/loginDeepControl?x=1' })).toBe('cursor');
        expect(loginHarness({ header: 'Log in', url: 'https://www.cursor.com/loginDeepControl' })).toBe('cursor');
        expect(loginHarness({ header: 'Log in', url: 'https://cursor.sh/x' })).toBe('cursor');
    });

    it('reads claude for the Claude login, and for anything it does not know', () => {
        expect(loginHarness({
            header: 'Log in to Claude for ~/.claude-accounts/account-9',
            url: 'https://claude.com/cai/oauth/authorize?code=true',
        })).toBe('claude');
        // Absent means claude everywhere else in this app, and every card
        // minted before cursor existed was one.
        expect(loginHarness({ header: 'Log in', url: 'https://example.com/x' })).toBe('claude');
        // Not a substring match: precursor.com is not cursor.
        expect(loginHarness({ header: 'Log in', url: 'https://precursor.com/x' })).toBe('claude');
        expect(loginHarness({ header: 'Log in to Claude', url: 'https://claude.com/x' })).toBe('claude');
    });

    it('comes through on the card itself, so every surface gets it', () => {
        expect(accountLoginCard({
            url: 'https://cursor.com/loginDeepControl?challenge=x',
            header: 'Log in to Cursor for a new cursor account',
            reason: 'Open this in a browser and approve it. Nothing to send back \u2014 the login finishes on its own.',
            cancelLabel: 'Cancel the login',
        })?.harness).toBe('cursor');
    });
});

describe('loginControls (DROVE-351)', () => {
    // Clay, with the cursor card photographed: "for cursor there is no code to
    // send. For ones where there IS a code, like Claude, we don't need the
    // input form, just do paste and send."
    it('gives a cursor login Cancel and nothing else', () => {
        // The card in the screenshot said "Nothing to send back \u2014 the login
        // finishes on its own" and then drew a paste button, a code field and
        // Send code underneath it. cursor-agent polls its own API until a
        // browser approves, so all three were controls that could not do
        // anything: drover-cursor-login discards a non-cancel answer and
        // raises the card again.
        expect(loginControls('cursor')).toEqual(['cancel']);
        expect(loginControls('cursor')).not.toContain('paste');
        expect(loginControls('cursor')).not.toContain('field');
        expect(loginControls('cursor')).not.toContain('send');
    });

    it('gives a Claude login one button and Cancel', () => {
        // DROVE-335 put Paste and send beside the field. The code is on the
        // clipboard when he comes back from the browser, so the field and its
        // Send row were the slow path nobody took.
        expect(loginControls('claude')).toEqual(['paste', 'cancel']);
        expect(loginControls('claude')).not.toContain('field');
        expect(loginControls('claude')).not.toContain('send');
    });
});

/**
 * THE SHAPE ON THE SCREEN, not just in the function (DROVE-351).
 *
 * `loginControls` can be right while the renderer still draws a field beside
 * it, and there is no renderer in this suite to catch that. So the body is
 * read as text, the way `copyDensity.spec.ts` reads the rows it guards.
 *
 * It also pins the reach: the Accounts page, the gates screen and the session
 * overlay all draw THIS body, so "no field" is one fact about one file rather
 * than three files that have to agree.
 */
describe('the login card as it is actually drawn (DROVE-351)', () => {
    const views = __dirname;
    const sources = path.resolve(views, '..', '..', '..');
    const body = fs.readFileSync(path.join(views, 'DroverAccountLoginBody.tsx'), 'utf8');
    /** Comments explain what was removed; only the JSX says what is drawn. */
    const drawn = body
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');

    it('draws no text field', () => {
        expect(drawn).not.toMatch(/TextInput/);
        expect(drawn).not.toMatch(/Paste the code from that page/);
    });

    it('draws no Send code button', () => {
        expect(drawn).not.toMatch(/Send code/);
    });

    it('still draws the link row, Paste and send, and the cancel label', () => {
        // The absence bars above are only worth anything beside the presence
        // ones: a body that drew nothing would pass every "not" on its own.
        expect(drawn).toMatch(/Open the sign-in page/);
        expect(drawn).toMatch(/Paste and send/);
        expect(drawn).toMatch(/card\.cancelLabel/);
        // And the paste button is gated on the control list, which is what
        // keeps it off a cursor card.
        expect(drawn).toMatch(/controls\.includes\('paste'\)/);
    });

    it('is the one implementation all three surfaces draw', () => {
        // The Accounts-page card and the bridge-thread card are the same
        // component, so the shape above is both of them.
        for (const surface of [
            path.join(sources, 'app', '(app)', 'settings', 'accounts.tsx'),
            path.join(sources, 'app', '(app)', 'gates.tsx'),
            path.join(sources, 'components', 'SessionGateOverlay.tsx'),
        ]) {
            expect(fs.readFileSync(surface, 'utf8'), surface)
                .toMatch(/<DroverAccountLoginBody/);
        }
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

    it('leaves the middle of the token alone', () => {
        // Was codeToSend's bar, and it moved here with the field it guarded
        // (DROVE-351): this is now the only path a code takes. Claude Code's
        // login code is <code>#<state> and is opaque, and tidying the middle of
        // it is how a correct paste becomes a 400.
        expect(clipboardCode('AbC-_9#st.at-e')).toEqual({ code: 'AbC-_9#st.at-e' });
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
