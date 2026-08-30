/**
 * Cattle Drover account filtering (BASED-98).
 *
 * A drover account is one CLAUDE_CONFIG_DIR — one subscription login. The CLI
 * stamps `metadata.droverAccount` on every session it starts under
 * `claude-acct`, so the app can group and filter by which account is doing the
 * work. Sessions with no stamp are "unaccounted" and are always visible: a
 * filter must never hide work just because it predates the feature.
 */

import type { SessionListViewItem, SessionRowData } from '@/sync/storage';

/** Every account present in the list, sorted, excluding unaccounted rows. */
export function collectDroverAccounts(items: SessionListViewItem[] | null): string[] {
    if (!items) return [];
    const found = new Set<string>();
    const addRow = (row: SessionRowData) => {
        if (row.droverAccount) found.add(row.droverAccount);
    };
    for (const item of items) {
        if (item.type === 'session') addRow(item.session);
        else if (item.type === 'active-sessions') item.sessions.forEach(addRow);
        else if (item.type === 'project') {
            for (const ws of item.project.workspaces) ws.sessions.forEach(addRow);
        }
    }
    return [...found].sort();
}

const matches = (row: SessionRowData, account: string) => (
    // Unaccounted sessions stay visible under every filter.
    !row.droverAccount || row.droverAccount === account
);

/**
 * Keep only rows belonging to `account` (plus unaccounted ones). Section
 * headers whose content filtered away are dropped with them, and project
 * cards recompute their counts so the badges do not lie about what is shown.
 */
export function filterByDroverAccount(
    items: SessionListViewItem[],
    account: string,
): SessionListViewItem[] {
    if (!account) return items;
    const out: SessionListViewItem[] = [];
    for (const item of items) {
        if (item.type === 'session') {
            if (matches(item.session, account)) out.push(item);
        } else if (item.type === 'active-sessions') {
            const sessions = item.sessions.filter((s) => matches(s, account));
            if (sessions.length > 0) out.push({ ...item, sessions });
        } else if (item.type === 'project') {
            const workspaces = item.project.workspaces
                .map((ws) => ({ ...ws, sessions: ws.sessions.filter((s) => matches(s, account)) }))
                .filter((ws) => ws.sessions.length > 0);
            if (workspaces.length === 0) continue;
            const kept = workspaces.reduce((n, ws) => n + ws.sessions.length, 0);
            const active = workspaces.reduce(
                (n, ws) => n + ws.sessions.filter((s) => s.active).length,
                0,
            );
            out.push({
                ...item,
                project: { ...item.project, workspaces, sessionCount: kept, activeCount: active },
            });
        } else {
            out.push(item);
        }
    }
    // Drop headers left with nothing under them.
    return out.filter((item, i) => {
        if (item.type !== 'header' && item.type !== 'projects-header') return true;
        const next = out[i + 1];
        return !!next && next.type !== 'header' && next.type !== 'projects-header';
    });
}

/**
 * Every drover account stamped on any known session, sorted.
 *
 * The chip row (SessionsList) works off the built list view; the flip action
 * runs per session row, where rebuilding that view would be wasteful, so it
 * reads the raw session map instead. Same rule either way: only a stamped
 * account counts, unaccounted sessions contribute nothing.
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
