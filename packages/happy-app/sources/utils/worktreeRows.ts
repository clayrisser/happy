/**
 * The rows of the worktree sheet (DROVE-90), as data.
 *
 * The daemon answers `list-worktrees` with what git knows: path, branch,
 * head, dirty. The app knows the rest: which of those paths is this session's
 * cwd, which sessions on that machine are live in each one, and the machine's
 * home so `/Users/clay/...` reads as `~/...`. This joins the two into what a
 * row shows, and nothing here touches React so the sheet's logic is testable
 * with plain vitest.
 */

export interface WorktreeSource {
    path: string;
    branch: string | null;
    head: string;
    dirty: boolean;
    isMain: boolean;
    bare: boolean;
    detached: boolean;
}

export interface WorktreeSessionSource {
    id: string;
    /** The session's cwd on the machine. */
    path: string;
    /** Still has a CLI behind it. A dead session does not count as running there. */
    live: boolean;
    updatedAt: number;
}

export interface WorktreeRow {
    /** Absolute path on the machine; what a spawn is given as its directory. */
    path: string;
    /** The path with the machine's home collapsed to `~`. */
    label: string;
    /** Branch name, or `detached <short sha>` / `bare` when there is none. */
    branch: string;
    dirty: boolean;
    bare: boolean;
    detached: boolean;
    /** The worktree this session is in. */
    current: boolean;
    isMain: boolean;
    /** Live sessions running in this worktree, newest first. */
    liveSessionIds: string[];
}

export function collapseHome(path: string, homeDir: string | null | undefined): string {
    const home = normalizePath(homeDir ?? '');
    if (!home) return path;
    const normalized = normalizePath(path);
    if (normalized === home) return '~';
    if (normalized.startsWith(home + '/')) return '~' + normalized.slice(home.length);
    return path;
}

/** Trailing slashes off, so `/a/b/` and `/a/b` are one place. */
export function normalizePath(path: string): string {
    const trimmed = path.trim().replace(/\/+$/, '');
    return trimmed === '' && path.trim().startsWith('/') ? '/' : trimmed;
}

export function describeBranch(worktree: Pick<WorktreeSource, 'branch' | 'head' | 'bare' | 'detached'>): string {
    if (worktree.branch) return worktree.branch;
    if (worktree.bare) return 'bare';
    const short = worktree.head.slice(0, 7);
    return short ? `detached ${short}` : 'detached';
}

export function buildWorktreeRows(input: {
    worktrees: WorktreeSource[];
    currentPath: string | null | undefined;
    homeDir: string | null | undefined;
    sessions: WorktreeSessionSource[];
}): WorktreeRow[] {
    const current = input.currentPath ? normalizePath(input.currentPath) : null;
    const liveByPath = new Map<string, WorktreeSessionSource[]>();
    for (const session of input.sessions) {
        if (!session.live) continue;
        const key = normalizePath(session.path);
        const bucket = liveByPath.get(key) ?? [];
        bucket.push(session);
        liveByPath.set(key, bucket);
    }
    return input.worktrees.map((worktree) => {
        const key = normalizePath(worktree.path);
        const live = [...(liveByPath.get(key) ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
        return {
            path: worktree.path,
            label: collapseHome(worktree.path, input.homeDir),
            branch: describeBranch(worktree),
            dirty: worktree.dirty,
            bare: worktree.bare,
            detached: worktree.detached,
            current: current !== null && key === current,
            isMain: worktree.isMain,
            liveSessionIds: live.map((session) => session.id),
        };
    });
}
