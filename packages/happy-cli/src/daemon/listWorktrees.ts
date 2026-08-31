/**
 * The worktrees of a repo, for the branch sheet on the phone (DROVE-90).
 *
 * Tapping the branch in the session header lists every worktree of that
 * repo so a session can be opened in any of them. The phone cannot run git,
 * so the daemon does: `git worktree list --porcelain` from the session's
 * directory (git answers the same from any worktree of the repo), then a
 * `git status --porcelain` in each one for the dirty mark. A bare main has
 * no working tree to be dirty, so it is reported clean without asking.
 *
 * Only reads. Starting a session in one of them goes through the ordinary
 * spawn RPC with that path as the directory.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { logger } from '@/ui/logger';

const execFileAsync = promisify(execFile);

export interface WorktreeEntry {
    /** Absolute path of the worktree. */
    path: string;
    /** Short branch name, or null when the worktree is detached or bare. */
    branch: string | null;
    /** The commit checked out there; empty for a bare worktree. */
    head: string;
    /** `git status --porcelain` printed something. Always false for a bare worktree. */
    dirty: boolean;
    /** The first entry git lists: the main worktree the others hang off. */
    isMain: boolean;
    bare: boolean;
    detached: boolean;
}

export interface ListWorktreesRequest {
    /** Any directory inside the repo; the session's cwd is what the app sends. */
    repoRoot?: string;
}

export type ListWorktreesResponse =
    | { ok: true; worktrees: WorktreeEntry[] }
    | { ok: false; error: string };

/** Runs `git <args>` in `cwd` and resolves stdout; rejects when git does. */
export type GitRunner = (args: string[], cwd: string) => Promise<string>;

export const runGit: GitRunner = async (args, cwd) => {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
};

type ParsedWorktree = Omit<WorktreeEntry, 'dirty' | 'isMain'>;

/**
 * One block per worktree, blank-line separated. A block is `worktree <path>`
 * then `HEAD <sha>` and one of `branch refs/heads/<name>` / `detached`, or
 * only `bare` for a bare repository's main entry.
 */
export function parseWorktreeList(porcelain: string): ParsedWorktree[] {
    const entries: ParsedWorktree[] = [];
    for (const block of porcelain.split(/\n\s*\n/)) {
        let path: string | null = null;
        let head = '';
        let branch: string | null = null;
        let bare = false;
        let detached = false;
        for (const rawLine of block.split('\n')) {
            const line = rawLine.trimEnd();
            if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
            else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length);
            else if (line.startsWith('branch ')) branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
            else if (line === 'bare') bare = true;
            else if (line === 'detached') detached = true;
        }
        if (path) entries.push({ path, head, branch, bare, detached });
    }
    return entries;
}

export async function listWorktrees(
    request: ListWorktreesRequest,
    git: GitRunner = runGit,
): Promise<ListWorktreesResponse> {
    const repoRoot = typeof request?.repoRoot === 'string' ? request.repoRoot.trim() : '';
    if (!repoRoot) return { ok: false, error: 'repoRoot is required' };

    let parsed: ParsedWorktree[];
    try {
        parsed = parseWorktreeList(await git(['worktree', 'list', '--porcelain'], repoRoot));
    } catch (error) {
        return { ok: false, error: describeGitError(error) };
    }

    const worktrees = await Promise.all(parsed.map(async (entry, index): Promise<WorktreeEntry> => {
        let dirty = false;
        if (!entry.bare) {
            try {
                dirty = (await git(['status', '--porcelain'], entry.path)).trim().length > 0;
            } catch (error) {
                // A worktree whose directory is gone (prunable) still lists;
                // it is not dirty, it is missing, and the row can say so by
                // its path. Do not fail the whole list over it.
                logger.debug(`[worktrees] status failed in ${entry.path}: ${describeGitError(error)}`);
            }
        }
        return { ...entry, dirty, isMain: index === 0 };
    }));

    return { ok: true, worktrees };
}

function describeGitError(error: unknown): string {
    if (error && typeof error === 'object' && 'stderr' in error) {
        const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim();
        if (stderr) return stderr;
    }
    return error instanceof Error ? error.message : String(error);
}

export function registerListWorktreesHandler(rpcHandlerManager: RpcHandlerManager, git: GitRunner = runGit): void {
    rpcHandlerManager.registerHandler<ListWorktreesRequest, ListWorktreesResponse>(
        'list-worktrees',
        async (request) => {
            logger.debug('[API MACHINE] Received list-worktrees RPC request');
            return listWorktrees(request ?? {}, git);
        },
    );
}
