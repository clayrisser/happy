/**
 * What a session is CALLED. One owner, for every surface that names one
 * (DROVE-127, DROVE-129).
 *
 * Clay, two photos side by side: the wrist said `cattle-drover`, the phone
 * header said `DROVER`, and they were the same session. The wrist was naming
 * it by its working directory — `path.split('/').pop()` in droverWatchFeed —
 * while the phone read the name the session had actually been given. Two
 * implementations, one session, two answers, and no way to tell from the wrist
 * which session you were looking at.
 *
 * So the derivation lives here and nowhere else. `getSessionName` calls it and
 * the watch feed calls it; neither owns it. Copying these four lines into a
 * third surface is the bug, not the fix.
 *
 * The order is the order the name was decided in:
 *
 * 1. `summary.text` — what `/rename` and the change_title MCP tool both write,
 *    and the field the phone has always read. A user-given name lives here.
 * 2. `metadata.name` — the CLI's own copy of the same string (applyCustomTitle
 *    writes both). Only reachable when a client wrote one and not the other.
 * 3. The working directory basename — the wrist's old answer, kept as a
 *    FALLBACK rather than a rule. It is a better last word than "New chat"
 *    because it says which checkout, so the phone takes it too.
 * 4. `New chat`, for a session that has neither a name nor a path.
 *
 * Nothing here reads React or the store, so both surfaces and their specs can
 * call it directly.
 */

import { t } from '@/text';

/** Only the fields a title is built from, so a test can hand in two keys. */
export interface SessionTitleSource {
    metadata?: {
        summary?: { text?: string | null } | null;
        name?: string | null;
        path?: string | null;
    } | null;
}

/**
 * The last segment of a working directory.
 *
 * Both separators, because a session can run on Windows and the phone reading
 * it does not. Empty for a path that is only separators.
 */
export function sessionPathBasename(path: string | null | undefined): string {
    if (!path) return '';
    const segments = path.split(/[/\\]/).filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : '';
}

/**
 * The title every surface shows for this session.
 *
 * Trimmed at each step: a name that is only whitespace is not a name, and
 * rendering one leaves a row that looks like it lost its title.
 */
export function sessionDisplayTitle(session: SessionTitleSource): string {
    const summary = session.metadata?.summary?.text?.trim();
    if (summary) return summary;
    const name = session.metadata?.name?.trim();
    if (name) return name;
    const basename = sessionPathBasename(session.metadata?.path).trim();
    if (basename) return basename;
    return t('session.newChat');
}
