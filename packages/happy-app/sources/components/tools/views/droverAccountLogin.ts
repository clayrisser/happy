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
