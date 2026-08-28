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
