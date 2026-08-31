import { getRepoPath } from './worktreePaths';

/**
 * The one line under the session's name in the header pill (DROVE-213).
 *
 * The repository, and nothing else. It used to be the folder and the branch,
 * `cattle-drover · ...D-98-cattle-drover`, in a centred pill with room for
 * about one of them, so the branch was cut from the left until it named
 * nothing. Clay struck that half out: "Don't show the name of the work tree in
 * here there's not a space for it anyways if you wanna see it you click on
 * that which opens all the work trees in the sheet." The pill opens
 * WorktreeSheet (DROVE-205), which lists every worktree with its branch and
 * checks the one this session is in, so the fact is not lost.
 *
 * The REPO, not the last path segment: a session in `<repo>/.dev/worktree/foo`
 * has `foo` on the end of its cwd, and `foo` is the worktree, which is the
 * thing being dropped. `getRepoPath` returns a plain checkout unchanged.
 *
 * The session list is a different string built in `flatSessionList.ts`, and it
 * keeps its worktree line: a full-width row has the space this pill does not,
 * and its job is telling rows apart rather than naming where you already are.
 */
export function sessionHeaderSubtitle(path: string | null | undefined): string | undefined {
    const repo = getRepoPath((path ?? '').trim());
    return repo.split(/[/\\]/).filter(Boolean).at(-1);
}
