/**
 * Cattle Drover accounts (BASED-98).
 *
 * A drover account is one CLAUDE_CONFIG_DIR, one subscription login. The CLI
 * stamps `metadata.droverAccount` on every session it starts under
 * `claude-acct`, so the app can tell which account is doing the work. Sessions
 * with no stamp are "unaccounted".
 *
 * The sessions list used to filter itself by account from a chip row. That row
 * is gone (DROVE-135) and so are the two helpers that served only it; account
 * management belongs in Settings, not on top of the list.
 */

/**
 * Every drover account stamped on any known session, sorted.
 *
 * The flip action runs per session row, where rebuilding the list view would
 * be wasteful, so it reads the raw session map instead. Only a stamped account
 * counts; unaccounted sessions contribute nothing.
 */
export function collectDroverAccountsFromSessions(
    sessions: Iterable<{ metadata?: { droverAccount?: string | null } | null }>,
): string[] {
    const found = new Set<string>();
    for (const session of sessions) {
        const account = session.metadata?.droverAccount;
        if (account) found.add(account);
    }
    return [...found].sort();
}

/**
 * The chat message that moves a session to another account.
 *
 * There is no flip RPC and there must not be one: happy-cli parses `/flip` out
 * of the message stream before the queue (drover/flip/controller.ts), so a
 * plain message is the whole mechanism. Bare `/flip` lets the CLI pick the next
 * account with headroom; naming one asks for that account. The watch builds the
 * exact same string (sync/droverWatchFeed.ts).
 */
export function droverFlipMessage(account?: string | null): string {
    const name = account?.trim();
    return name ? `/flip ${name}` : '/flip';
}
