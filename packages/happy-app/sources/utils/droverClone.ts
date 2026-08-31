/**
 * Clone lineage, as a phone can read it (DROVE-58).
 *
 * A FLIP is one session moving between Claude accounts: same id, same row,
 * nothing to say. A CLONE is two sessions, because no harness but Claude Code
 * can read a Claude Code transcript — cloning into OpenCode or Cursor starts a
 * NEW session seeded with a summary of the old one. The app therefore has two
 * rows and neither can say on its own what it is, which is what these lines
 * are for: "cloned from …" on the clone, "cloned into …" on the source.
 *
 * The CLI publishes `metadata.droverClone` from the ledger `drover clone`
 * writes, so both ends read one file and cannot disagree.
 *
 * Pure, so the wording is testable without a renderer. The one thing worth
 * getting right is the row for a clone that has NOT started yet: `drover
 * clone` writes the ledger row before the window opens, and the bus fills the
 * id in from the clone's first hook, so for those seconds the source has a
 * descendant with no id. It renders as "starting" rather than disappearing —
 * dropping it would make a session that was just cloned look un-cloned.
 */

export interface DroverCloneLinkLike {
    session?: string | null;
    harness?: string | null;
    at?: string | null;
}

export interface DroverCloneLike {
    from?: DroverCloneLinkLike | null;
    to?: DroverCloneLinkLike[] | null;
}

export interface CloneLineageRow {
    /** `from` = this session was seeded from it; `to` = it was seeded from this. */
    direction: 'from' | 'to';
    title: string;
    subtitle: string;
    /** The other session's Claude id, or null when it has not started yet. */
    claudeSessionId: string | null;
}

const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 8) : id);

const harnessName = (harness: string | null | undefined): string => {
    switch (harness) {
        case 'claude': return 'Claude Code';
        case 'opencode': return 'OpenCode';
        case 'cursor': return 'Cursor';
        default: return harness ? harness : 'another harness';
    }
};

/**
 * The lineage lines for one session, in reading order: where it came from
 * first, then everything it was cloned into.
 */
export function cloneLineageRows(clone: DroverCloneLike | null | undefined): CloneLineageRow[] {
    if (!clone) return [];
    const rows: CloneLineageRow[] = [];
    const from = clone.from;
    if (from?.session) {
        rows.push({
            direction: 'from',
            title: 'Cloned from',
            subtitle: `${shortId(from.session)} in ${harnessName(from.harness)}`,
            claudeSessionId: from.session,
        });
    }
    for (const to of clone.to ?? []) {
        if (!to) continue;
        rows.push({
            direction: 'to',
            title: 'Cloned into',
            subtitle: to.session
                ? `${shortId(to.session)} in ${harnessName(to.harness)}`
                : `${harnessName(to.harness)} — starting`,
            claudeSessionId: to.session ?? null,
        });
    }
    return rows;
}

/**
 * One line for a session row, when there is room for one line and no more.
 *
 * Null when the session has no lineage, so a caller can render nothing rather
 * than an empty label.
 */
export function cloneLineageSummary(clone: DroverCloneLike | null | undefined): string | null {
    const rows = cloneLineageRows(clone);
    if (rows.length === 0) return null;
    const from = rows.find((r) => r.direction === 'from');
    const to = rows.filter((r) => r.direction === 'to');
    const parts: string[] = [];
    if (from) parts.push(`cloned from ${from.subtitle}`);
    if (to.length === 1) parts.push(`cloned into ${to[0].subtitle}`);
    else if (to.length > 1) parts.push(`cloned into ${to.length} sessions`);
    return parts.join(' · ');
}
