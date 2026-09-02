/**
 * What a machine may say about the files in a worktree and the text on a
 * terminal pane (DROVE-330).
 *
 * Clay, from his phone: "another tab that opens the terminal, and another tab
 * that lets us browse the files; and if I click on a specific worktree it
 * opens the terminal in that worktree, or lets me browse the files in that
 * worktree." READ-ONLY, all of it. Nothing on this type writes, and adding a
 * write is a decision rather than a field.
 *
 * Three processes touch these shapes and share no runtime, which is the
 * DROVE-274 arrangement again: cattle-drover's `engine/files.js` builds them in
 * plain JS, happy-cli's daemon relays them over the machine RPC, and the app
 * draws them. So the shape lives on the wire, and `droverFilesLeaks` below is
 * the runtime half of the type, because a type cannot stop a producer from
 * hanging an extra key on an object.
 *
 * THE RISK IS THE CONTENT, not the keys. An MCP report could be made safe by
 * allowlisting three fields; a file is arbitrary text and a pane is whatever
 * was on screen, and either can carry a credential in the clear. The drover
 * refuses secret-shaped paths outright and runs every line through the
 * DROVE-304 vocabulary before it answers. This file carries the second net:
 * `redactSecretsInText`, applied AGAIN by the daemon on what came back, so a
 * drover from before a pattern was added still cannot put that pattern on the
 * wire. The count of what the net caught is on the payload, because a net that
 * catches something silently is a producer nobody fixes.
 */

import { redactSecretsInText } from './redact';

/** What one directory entry is. `other` covers sockets, devices, symlinks. */
export type DroverFileType = 'file' | 'directory' | 'other';

/**
 * One row of a listing. Five fields, and the count is deliberate: a name, what
 * it is, how big, when, and whether the drover will serve it. No absolute path
 * (the phone already holds the root it asked about) and no owner or mode.
 */
export interface DroverFileEntry {
    name: string;
    type: DroverFileType;
    /** Bytes, for a file. Null where a size means nothing. */
    size: number | null;
    /** mtime, epoch ms. Null when the stat failed. */
    modified: number | null;
    /**
     * The drover will not read this, and will not descend into it. Listed
     * rather than hidden: a `.env` that simply is not there reads as "you have
     * no .env", which sends somebody looking in the wrong place.
     */
    refused: boolean;
}

/** A directory listing, as `GET /v1/files` answers it. */
export interface DroverFilesList {
    /** The worktree the listing is scoped to, as the phone sent it. */
    root: string;
    /** Relative to `root`; empty for the root itself. */
    path: string;
    entries: DroverFileEntry[];
    /** When the machine read the directory, epoch ms. */
    readAt: number;
}

/** One file's text, as `GET /v1/files/read` answers it. */
export interface DroverFileRead {
    root: string;
    path: string;
    /** Null when the file is binary; the app says so rather than drawing it. */
    content: string | null;
    /** The file's size on disk, whatever was served. */
    size: number;
    /** Only the first part came, because the file is bigger than the cap. */
    truncated: boolean;
    binary: boolean;
    /**
     * How many secret-shaped spans were replaced with the marker, on the
     * drover and on the daemon combined. Shown, so a file that reads
     * `[redacted]` is understood as a file the drover edited.
     */
    redacted: number;
    readAt: number;
}

/** A pane capture, as `GET /v1/pane` answers it. */
export interface DroverPane {
    /** The harness's own session id the pane belongs to. */
    sessionId: string;
    /** The tmux pane id, `%12`. */
    pane: string;
    /** The pane's text, bottom-most last, already through the redactor. */
    lines: string[];
    redacted: number;
    capturedAt: number;
}

export type DroverFilesListResult =
    | { ok: true; listing: DroverFilesList }
    | { ok: false; error: string };

export type DroverFileReadResult =
    | { ok: true; file: DroverFileRead }
    | { ok: false; error: string };

export type DroverPaneResult =
    | { ok: true; pane: DroverPane }
    | { ok: false; error: string };

/** What the app sends the daemon for a listing or a read. */
export interface DroverFilesRequest {
    root: string;
    path: string;
}

/**
 * What the app sends the daemon for a pane. One of the two: a session the bus
 * knows by the harness's id, or a cwd, for a worktree whose session id the
 * phone does not hold.
 */
export type DroverPaneRequest =
    | { sessionId: string; lines?: number }
    | { cwd: string; lines?: number };

/**
 * Every key that may appear at each level. Allowlists, for the same reason
 * `mcpServerAllowedKeys` is one: a denylist passes the first key nobody
 * thought of, and the failure guarded against here is an EXTRA key — a drover
 * that started attaching the absolute path, or the owner, or a symlink target.
 */
export const droverFileEntryAllowedKeys: readonly string[] = Object.freeze(['name', 'type', 'size', 'modified', 'refused']);
export const droverFilesListAllowedKeys: readonly string[] = Object.freeze(['root', 'path', 'entries', 'readAt']);
export const droverFileReadAllowedKeys: readonly string[] = Object.freeze(['root', 'path', 'content', 'size', 'truncated', 'binary', 'redacted', 'readAt']);
export const droverPaneAllowedKeys: readonly string[] = Object.freeze(['sessionId', 'pane', 'lines', 'redacted', 'capturedAt']);

function extraKeys(value: unknown, allowed: readonly string[], where: string, problems: string[]): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        problems.push(`${where} is not an object`);
        return;
    }
    const ok = new Set(allowed);
    for (const key of Object.keys(value)) {
        if (!ok.has(key)) problems.push(`${where}.${key} is not one of ${allowed.join(', ')}`);
    }
}

/**
 * Everything structurally wrong with a listing, as sentences. Empty means the
 * shape is the shape. Called by the daemon on what the bus returned and by the
 * app on what the daemon returned.
 */
export function droverFilesListLeaks(listing: unknown): string[] {
    const problems: string[] = [];
    extraKeys(listing, droverFilesListAllowedKeys, 'listing', problems);
    const entries = (listing as DroverFilesList | null)?.entries;
    if (!Array.isArray(entries)) {
        problems.push('listing.entries is not a list');
        return problems;
    }
    entries.forEach((entry, i) => {
        extraKeys(entry, droverFileEntryAllowedKeys, `listing.entries[${i}]`, problems);
        const name = (entry as DroverFileEntry | null)?.name;
        // A name is one path segment. A producer that started returning
        // `sub/dir/file` or `../x` would be handing the phone a path to
        // resolve, and the phone must never resolve one.
        if (typeof name !== 'string' || name === '' || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
            problems.push(`listing.entries[${i}].name is not a single path segment`);
        }
    });
    return problems;
}

/** The same, for a read. */
export function droverFileReadLeaks(file: unknown): string[] {
    const problems: string[] = [];
    extraKeys(file, droverFileReadAllowedKeys, 'file', problems);
    const content = (file as DroverFileRead | null)?.content;
    if (content !== null && content !== undefined && typeof content !== 'string') {
        problems.push('file.content is neither text nor null');
    }
    return problems;
}

/** And for a pane. */
export function droverPaneLeaks(pane: unknown): string[] {
    const problems: string[] = [];
    extraKeys(pane, droverPaneAllowedKeys, 'pane', problems);
    const lines = (pane as DroverPane | null)?.lines;
    if (!Array.isArray(lines) || lines.some((line) => typeof line !== 'string')) {
        problems.push('pane.lines is not a list of strings');
    }
    return problems;
}

/**
 * The net under the drover's redactor.
 *
 * Runs `redactSecretsInText` over the text and says how many spans it changed.
 * Zero is the expected answer: the drover has already been over this text with
 * a superset of these patterns. A non-zero count means the two vocabularies
 * have drifted, which is worth a log line on the machine and a number on the
 * payload, and is never a reason to refuse — a source file that mentions
 * `token: "…"` is a source file, not a leak, and refusing it teaches nobody
 * anything.
 */
export function redactTextCounting(text: string): { text: string; count: number } {
    const out = redactSecretsInText(text);
    if (out === text) return { text, count: 0 };
    // Count the marker's appearances that were not already there. The marker
    // is one fixed string, so this is a subtraction rather than a diff.
    const marker = '[redacted]';
    const before = text.split(marker).length - 1;
    const after = out.split(marker).length - 1;
    return { text: out, count: Math.max(1, after - before) };
}
