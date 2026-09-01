/**
 * Reading the account-login card's input (DROVE-61).
 *
 * Split out of the view for the usual reason: the rules about what is a usable
 * login link, and what a code has to look like before the Send button lights
 * up, are worth testing without a renderer.
 */

export interface AccountLoginCard {
    url: string;
    header: string;
    reason: string;
    cancelLabel: string;
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
    return {
        url,
        header: typeof raw.header === 'string' && raw.header.trim()
            ? raw.header.trim()
            : 'Log in to Claude',
        reason: typeof raw.reason === 'string' ? raw.reason.trim() : '',
        cancelLabel: typeof raw.cancelLabel === 'string' && raw.cancelLabel.trim()
            ? raw.cancelLabel.trim()
            : 'Cancel',
    };
}

/**
 * What actually gets sent, or null when there is nothing to send yet.
 *
 * Trimmed, because a code copied off a web page arrives with whitespace on it
 * more often than not, and the bus refuses a blank text resolution — which
 * would surface as a submit that silently did nothing.
 *
 * Not otherwise touched. A Claude Code login code is `<code>#<state>`, and
 * "tidying" the middle of an opaque token is how a correct paste becomes a 400.
 */
export function codeToSend(typed: string): string | null {
    const trimmed = typed.trim();
    return trimmed.length > 0 ? trimmed : null;
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
