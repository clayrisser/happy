/**
 * The worktree sheet's tabs, and what a tapped worktree hands them (DROVE-330).
 *
 * Clay, from his phone: "In the sheet that comes up, in addition to the
 * worktrees that show, we should have a tab there that shows the todo, but
 * also another tab that opens the terminal, and another tab that lets us
 * browse the files; and if I click on a specific worktree it opens the
 * terminal in that worktree, or lets me browse the files in that worktree."
 *
 * Four tabs, then, and a SCOPE: the Terminal and Files tabs look at one
 * worktree, which is this session's own until a row hands them another.
 * That is written down here as data rather than left in the sheet's
 * callbacks, the way worktreeRows.ts wrote down what a tap does (DROVE-205),
 * so the rules can be pinned with plain vitest and read without a renderer.
 */

import { collapseHome, type WorktreeRow } from './worktreeRows';

export type WorktreeSheetTab = 'worktrees' | 'todos' | 'terminal' | 'files';

export interface WorktreeSheetTabSpec {
    key: WorktreeSheetTab;
    /** Short, because four of these share one segmented control on a phone. */
    label: string;
}

/** In this order, which is the order Clay said them in. */
export const worktreeSheetTabs: readonly WorktreeSheetTabSpec[] = [
    { key: 'worktrees', label: 'Worktrees' },
    { key: 'todos', label: 'Todos' },
    { key: 'terminal', label: 'Terminal' },
    { key: 'files', label: 'Files' },
];

/** The tab the sheet opens on. The pill is about the worktrees (DROVE-205). */
export const worktreeSheetDefaultTab: WorktreeSheetTab = 'worktrees';

export function isWorktreeSheetTab(value: unknown): value is WorktreeSheetTab {
    return worktreeSheetTabs.some((tab) => tab.key === value);
}

/**
 * The worktree a Terminal or Files tab is looking at.
 *
 * `sessionId` is the app's id for the newest live session in it, when there
 * is one: the pane is asked for through that session's harness id, because a
 * pane belongs to a session and not to a directory. Without one the pane is
 * asked for by path and the bus picks whatever is live there.
 */
export interface WorktreeScope {
    /** Absolute path on the machine, what the bus is asked about. */
    path: string;
    /** The path with the machine's home collapsed to `~`. */
    label: string;
    sessionId: string | null;
}

/** The scope a row hands the tabs when its terminal or folder glyph is tapped. */
export function scopeForRow(row: Pick<WorktreeRow, 'path' | 'label' | 'liveSessionIds'>): WorktreeScope {
    return { path: row.path, label: row.label, sessionId: row.liveSessionIds[0] ?? null };
}

/** The sheet's own session, as a scope: what the tabs look at until a row says otherwise. */
export function ownScope(input: {
    sessionId: string;
    path: string | null | undefined;
    homeDir: string | null | undefined;
}): WorktreeScope | null {
    if (!input.path) return null;
    return { path: input.path, label: collapseHome(input.path, input.homeDir), sessionId: input.sessionId };
}

/**
 * Which of a row's two glyphs are live.
 *
 * A bare checkout has no working tree, so neither. A pane belongs to a
 * session, so the terminal glyph needs a live one; the folder needs only the
 * directory. Disabled rather than hidden, so a row without a session still
 * shows what it would offer.
 */
export function worktreeActions(row: Pick<WorktreeRow, 'bare' | 'liveSessionIds'>): { terminal: boolean; files: boolean } {
    if (row.bare) return { terminal: false, files: false };
    return { terminal: row.liveSessionIds.length > 0, files: true };
}

/** What the daemon is asked for a pane. See `WorktreeScope.sessionId`. */
export type PaneTarget = { sessionId: string } | { cwd: string };

/**
 * A scope's pane target, given a way to turn the app's session id into the
 * harness's own. The bus keys its registry by the latter; the app holds it as
 * `metadata.claudeSessionId` for a Claude session and not at all for others,
 * which fall back to the path.
 */
export function paneTargetFor(
    scope: WorktreeScope,
    harnessSessionIdOf: (sessionId: string) => string | null | undefined,
): PaneTarget {
    if (scope.sessionId) {
        const harnessId = harnessSessionIdOf(scope.sessionId);
        if (harnessId) return { sessionId: harnessId };
    }
    return { cwd: scope.path };
}

/**
 * The Terminal tab's line for a pane the bus would not give (DROVE-359).
 *
 * The bus's errors are keyed to its own registry, so each gets a line of the
 * app's own. One fragment each: DROVE-346's rule is that the explanation goes
 * behind a tap, into the docs, or nowhere, and these were three paragraphs
 * about the daemon on a phone-width box. An error the app has no line for is
 * handed through as the bus wrote it.
 */
export function paneTrouble(error: string): string {
    if (error === 'no pane') return 'No terminal pane here';
    if (error === 'no live session in that worktree') return 'Nothing running here';
    if (error === 'no such session') return 'Not seen by the drover yet';
    return error;
}

/** Both tabs, for a session the app cannot place on a machine. */
export const noMachineTrouble = 'No machine for this session';

/**
 * The Terminal tab's status line, built here so the copy is pinned rather
 * than living in a template literal a scan cannot read.
 */
export function paneStatus(input: {
    scopeLabel: string;
    pane: { pane: string; age: string; redacted: number } | null;
    troubled: boolean;
}): string {
    const { scopeLabel, pane, troubled } = input;
    if (!pane) return troubled ? scopeLabel : `${scopeLabel} · capturing`;
    const parts = [scopeLabel, `pane ${pane.pane}`, `${pane.age} ago`];
    if (pane.redacted > 0) parts.push(`${pane.redacted} masked`);
    return parts.join(' · ');
}

// --- the Files tab's path arithmetic ----------------------------------------

/** `rel` joined with one entry name. The root is the empty string. */
export function joinRel(rel: string, name: string): string {
    return rel ? `${rel}/${name}` : name;
}

/** One level up. The root's parent is the root. */
export function parentRel(rel: string): string {
    const i = rel.lastIndexOf('/');
    return i < 0 ? '' : rel.slice(0, i);
}

/** What the crumb line reads: the scope's label, then the path inside it. */
export function breadcrumb(scopeLabel: string, rel: string): string {
    return rel ? `${scopeLabel}/${rel}` : scopeLabel;
}

/** `1.2 KB`, `340 B`, `3.1 MB`. Nothing for a directory. */
export function fileSizeLabel(bytes: number | null): string {
    if (bytes === null || !Number.isFinite(bytes)) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * What a file view says above the text, if anything: that it was cut, that
 * it is binary, that the drover masked something in it. Joined with ` · ` by
 * the caller; empty means the file is exactly what is on disk.
 */
export function fileNotes(file: { truncated: boolean; binary: boolean; redacted: number; size: number }): string[] {
    const notes: string[] = [];
    if (file.binary) notes.push('binary, not shown');
    if (file.truncated) notes.push(`first 256 KB of ${fileSizeLabel(file.size)}`);
    if (file.redacted > 0) notes.push(file.redacted === 1 ? '1 secret masked' : `${file.redacted} secrets masked`);
    return notes;
}
