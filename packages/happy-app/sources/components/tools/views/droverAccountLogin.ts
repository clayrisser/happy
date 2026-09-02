/**
 * Reading the account-login card's input (DROVE-61).
 *
 * Split out of the view for the usual reason: the rules about what is a usable
 * login link, which controls a card gets, and what a clipboard has to hold
 * before any of it is sent, are worth testing without a renderer.
 */

export interface AccountLoginCard {
    url: string;
    header: string;
    reason: string;
    cancelLabel: string;
    /** Whose login this is, and therefore what the card draws (DROVE-351). */
    harness: LoginHarness;
}

/**
 * Which login a card belongs to (DROVE-351).
 *
 * It decides whether there is a code step at all, so it is not cosmetic.
 * `claude auth login` prints a URL and then BLOCKS on a code typed back in.
 * `cursor-agent login` prints a URL and then polls its own API until a browser
 * approves it — there is no code, there never was, and drover-cursor-login
 * already says so where it raises the card: a non-cancel answer "is not an
 * error and not an answer", the card is simply raised again.
 */
export type LoginHarness = 'claude' | 'cursor';

/**
 * The controls the card draws under the link row, in the order it draws them.
 *
 * `field` and `send` are in the vocabulary with nothing returning them, and
 * that is the point: a bar that says "no text field" has to be able to SAY
 * text field, or the spec asserting their absence asserts nothing.
 */
export type LoginControl = 'paste' | 'field' | 'send' | 'cancel';

/** A cursor host, port and subdomain included. */
const cursorHost = /(^|\.)cursor\.(com|sh)$/i;

/**
 * Whose login this is, read off the card rather than off the screen.
 *
 * The three surfaces that draw this body — the Accounts page, the gates screen
 * and the session overlay — all hand it the mirrored request's arguments and
 * nothing else, so an answer that came from the screen would be right on one
 * of them and absent on the other two. The card is the only thing all three
 * share.
 *
 * Two independent signals, either one enough. The header is drover's own
 * string ("Log in to Cursor for <label>"), and the link is the one the login
 * printed — cursor's is cursor.com/loginDeepControl, Claude's is on claude.com.
 * Unknown reads as claude, which is what `harness` absent means everywhere
 * else in this app and what every card minted before cursor existed was.
 */
export function loginHarness(card: { header: string; url: string }): LoginHarness {
    if (/\bcursor\b/i.test(card.header)) return 'cursor';
    if (cursorHost.test(hostOf(card.url).replace(/:\d+$/, ''))) return 'cursor';
    return 'claude';
}

/**
 * What the card offers back, which is the whole of DROVE-351.
 *
 * Clay, with the cursor card photographed: "for cursor there is no code to
 * send. For ones where there IS a code, like Claude, we don't need the input
 * form, just do paste and send."
 *
 * CURSOR GETS NO CODE STEP. The card in that screenshot said "Nothing to send
 * back — the login finishes on its own" and then drew a paste button, a code
 * field and a Send code button underneath it. Three controls that cannot do
 * anything: the login finishes in the browser, and whatever is typed here is
 * discarded by the script and the card raised again. Cancel is the only answer
 * a cursor login has, so it is the only one offered.
 *
 * CLAUDE GETS ONE BUTTON. The code is on the clipboard when he comes back from
 * the browser — that IS the flow — so Paste and send does it in one tap
 * (DROVE-335), and the field and the Send code row it was added beside are now
 * the slow path nobody takes.
 */
export function loginControls(harness: LoginHarness): LoginControl[] {
    return harness === 'cursor' ? ['cancel'] : ['paste', 'cancel'];
}

/**
 * The card, or null when this input is not one.
 *
 * The URL must be https. It is about to be handed to the iOS share sheet and
 * then to a browser, and the drover bridge only ever mints this card from a
 * bus event whose preview already starts with https:// — so anything else here
 * is a malformed card, and drawing a "sign in" button that opens an unknown
 * scheme is the one outcome worth refusing outright.
 */
export function accountLoginCard(input: unknown): AccountLoginCard | null {
    if (!input || typeof input !== 'object') return null;
    const raw = input as Record<string, unknown>;
    const url = typeof raw.url === 'string' ? raw.url.trim() : '';
    if (!url.startsWith('https://')) return null;
    const header = typeof raw.header === 'string' && raw.header.trim()
        ? raw.header.trim()
        : 'Log in to Claude';
    return {
        url,
        header,
        reason: typeof raw.reason === 'string' ? raw.reason.trim() : '',
        cancelLabel: typeof raw.cancelLabel === 'string' && raw.cancelLabel.trim()
            ? raw.cancelLabel.trim()
            : 'Cancel',
        harness: loginHarness({ header, url }),
    };
}

/** The host, for a line under the link that says where it goes. */
export function hostOf(url: string): string {
    const match = /^https:\/\/([^/?#]+)/.exec(url);
    return match ? match[1] : url;
}

/**
 * What the clipboard is holding, judged before any of it reaches the Mac
 * (DROVE-335).
 *
 * Clay: "for the login I was kinda expecting a paste and submit button instead
 * of having to paste in a field and submit." One tap is the feature; this
 * function is the part that keeps one tap from being worse than four.
 *
 * A pasted answer is sent straight to a `claude auth login` that is BLOCKED on
 * stdin with two tries and no more, so a clipboard holding the sign-in URL, a
 * paragraph, or whatever was copied an hour ago does not merely fail — it
 * spends one of Clay's attempts and comes back as "Invalid code". Refusing it
 * here costs nothing and is undoable; sending it is neither.
 *
 * Deliberately NOT a shape test for Claude Code's `<code>#<state>`. That format
 * is Anthropic's to change, and a validator that knows it too well is a login
 * that breaks on their next release. What is refused is only what CANNOT be a
 * code: nothing, a link, more than one word, and lengths no token has.
 */
export type ClipboardCode = { code: string } | { refused: string };

/** Shorter than any authorization code, and short enough to be a mis-copy. */
const minClipboardCodeLength = 8;
/** Longer than any of them, and about where a paste is really a document. */
const maxClipboardCodeLength = 512;

export function clipboardCode(raw: string | null | undefined): ClipboardCode {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) {
        return { refused: 'There is nothing on the clipboard to send.' };
    }
    // Checked before the whitespace rule so the commonest wrong paste — the
    // sign-in link itself, one tap away on the row above — is named for what
    // it is rather than lumped in with a paragraph.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
        return { refused: 'That is the sign-in link, not the code. Sign in on that page first, then copy the code it gives you.' };
    }
    if (/\s/.test(text)) {
        return { refused: 'That is more than one word, so it is not the code. Copy just the code the sign-in page shows.' };
    }
    if (text.length < minClipboardCodeLength) {
        return { refused: `That is ${text.length} characters, which is too short to be the code.` };
    }
    if (text.length > maxClipboardCodeLength) {
        return { refused: 'That is far too long to be the code. Copy just the code the sign-in page shows.' };
    }
    // The characters a URL-safe token and its state fragment can carry, and no
    // others. Anything else is a sentence, a filename or a JSON blob.
    if (!/^[\w.~#%+/=:-]+$/.test(text)) {
        return { refused: 'That has characters no login code carries, so it was not sent.' };
    }
    return { code: text };
}
