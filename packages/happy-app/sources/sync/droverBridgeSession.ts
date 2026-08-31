/**
 * Telling the Cattle Drover bridge apart from a session (DROVE-238).
 *
 * happy-cli keeps ONE Happy session per machine whose whole job is to hold the
 * bus gates it mirrors — every question, permission and to-do any local agent
 * raises lands in it as a request. It is not a conversation: it has no
 * transcript, it never sends a keepalive, and nothing can be typed into it.
 *
 * The app listed it anyway. Because it is never `active` and carries no rig
 * metadata, `isSessionArchived` calls it archived, so it sat in Clay's list as
 * a dead row headed "Cattle Drover — pending…" with `happy-cli` under it — and
 * the Accounts screen sent him INTO it to finish a login he had started two
 * screens away. Opening it answered "This session is inactive."
 *
 * His words: "these temporary sessions for login should not be picked up by the
 * mobile app." The tmux side of the login was already invisible — DROVE-212 put
 * it on its own tmux server for exactly this reason, and it worked. This row is
 * the OTHER thing wearing the login's face, and it predates the login.
 *
 * TWO SIGNALS, and both are needed. `metadata.droverBridge` is the real one and
 * the CLI stamps it, on new bridge sessions and on the existing one at every
 * start. The summary prefix is the fallback for a machine whose CLI has not
 * been rebuilt yet, and it is not invented here — the wrist feed has been
 * excluding the bridge on that exact string since DROVE-127. Reading it in one
 * place is the point: three surfaces had three answers.
 *
 * What this does NOT do is hide the CARDS. Every gate the bridge holds is still
 * read straight out of `storage.sessions` by the gates screen, the banner, the
 * inbox and the Accounts screen. Only the row goes.
 */

/** The summary happy-cli gives its bridge session, matched by prefix. */
const bridgeSummaryPrefix = 'Cattle Drover —';

export interface BridgeSessionMetadataLike {
    droverBridge?: boolean;
    summary?: { text?: string } | null;
}

export function isDroverBridgeMetadata(
    metadata: BridgeSessionMetadataLike | null | undefined,
): boolean {
    if (!metadata) return false;
    if (metadata.droverBridge === true) return true;
    return typeof metadata.summary?.text === 'string'
        && metadata.summary.text.startsWith(bridgeSummaryPrefix);
}

export function isDroverBridgeSession(
    session: { metadata?: BridgeSessionMetadataLike | null } | null | undefined,
): boolean {
    return isDroverBridgeMetadata(session?.metadata);
}
