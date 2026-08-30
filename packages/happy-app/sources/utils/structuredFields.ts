/**
 * A tool's structured input laid out as rows instead of a JSON blob (DROVE-51).
 *
 * Every tool input is a JSON-schema'd object, so a card can show it as
 * labelled fields without knowing the tool: one row per top-level key, the
 * value typed so the renderer can pick inline text, a folded block, bullets or
 * nested rows. The same rows feed the inline card and the tool detail screen,
 * which is what keeps the two from drifting apart again.
 */

export type StructuredValue =
    | { kind: 'empty' }
    | { kind: 'text'; text: string; long: boolean }
    | { kind: 'path'; path: string }
    | { kind: 'number'; text: string }
    | { kind: 'boolean'; value: boolean }
    | { kind: 'list'; items: StructuredValue[] }
    | { kind: 'object'; rows: StructuredRow[] };

export interface StructuredRow {
    key: string;
    /** The key as a muted label: `file_path` reads "file path", `subagentType` reads "subagent type". */
    label: string;
    /** Other keys that carried the same value and were folded into this row. */
    aliases: string[];
    value: StructuredValue;
}

/** Past this a string is a block to fold, not a value to read inline. */
export const longTextChars = 140;

/** Nested objects fold one level; anything deeper is shown as compact JSON text. */
const maxDepth = 2;

export function humanizeKey(key: string): string {
    return key
        .replace(/[_-]+/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

/** An absolute, home-relative, dot-relative or Windows path with no whitespace. */
export function isPathLike(text: string): boolean {
    if (text.length < 2 || text.length > 400 || /\s/.test(text)) {
        return false;
    }
    return /^(\/|~\/|\.{1,2}\/|[A-Za-z]:\\)\S*$/.test(text);
}

function parseJsonText(text: string): object | undefined {
    const trimmed = text.trim();
    const looksLikeObject = trimmed.startsWith('{') && trimmed.endsWith('}');
    const looksLikeArray = trimmed.startsWith('[') && trimmed.endsWith(']');
    if (!looksLikeObject && !looksLikeArray) {
        return undefined;
    }
    try {
        const parsed: unknown = JSON.parse(trimmed);
        return parsed && typeof parsed === 'object' ? parsed : undefined;
    } catch {
        return undefined;
    }
}

function compactJson(value: unknown): StructuredValue {
    let text: string;
    try {
        text = JSON.stringify(value) ?? String(value);
    } catch {
        text = String(value);
    }
    return { kind: 'text', text, long: text.length > longTextChars };
}

export function structuredValue(value: unknown, depth: number = 0): StructuredValue {
    if (value === null || value === undefined) {
        return { kind: 'empty' };
    }
    if (typeof value === 'boolean') {
        return { kind: 'boolean', value };
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
        return { kind: 'number', text: String(value) };
    }
    if (typeof value === 'string') {
        if (value.trim().length === 0) {
            return { kind: 'empty' };
        }
        // A Workflow's `args` is a JSON string; the reader wants its fields, not
        // a wall of escaped quotes.
        const parsed = parseJsonText(value);
        if (parsed !== undefined && depth < maxDepth) {
            return structuredValue(parsed, depth);
        }
        if (isPathLike(value)) {
            return { kind: 'path', path: value };
        }
        return { kind: 'text', text: value, long: value.length > longTextChars || value.includes('\n') };
    }
    if (Array.isArray(value)) {
        if (value.length === 0) {
            return { kind: 'empty' };
        }
        if (depth >= maxDepth) {
            return compactJson(value);
        }
        return { kind: 'list', items: value.map((item) => structuredValue(item, depth + 1)) };
    }
    if (typeof value === 'object') {
        if (Object.keys(value).length === 0) {
            return { kind: 'empty' };
        }
        if (depth >= maxDepth) {
            return compactJson(value);
        }
        return { kind: 'object', rows: rowsOf(value as Record<string, unknown>, depth + 1) };
    }
    return { kind: 'text', text: String(value), long: false };
}

/**
 * Two keys carrying the same value are one fact, so they share one row.
 * SendMessage sends `message`/`content` and `to`/`recipient` in pairs.
 * Only strings and containers collapse: two flags both `true` are not the
 * same fact twice.
 */
function collapseFingerprint(raw: unknown): string | null {
    if (typeof raw === 'string') {
        return raw.trim().length > 0 ? `s:${raw}` : null;
    }
    if (raw && typeof raw === 'object') {
        try {
            const serialized = JSON.stringify(raw);
            return serialized && serialized.length > 2 ? `o:${serialized}` : null;
        } catch {
            return null;
        }
    }
    return null;
}

function rowsOf(record: Record<string, unknown>, depth: number): StructuredRow[] {
    const rows: StructuredRow[] = [];
    const seen = new Map<string, StructuredRow>();
    for (const [key, raw] of Object.entries(record)) {
        const fingerprint = collapseFingerprint(raw);
        if (fingerprint) {
            const previous = seen.get(fingerprint);
            if (previous) {
                previous.aliases.push(key);
                continue;
            }
        }
        const row: StructuredRow = { key, label: humanizeKey(key), aliases: [], value: structuredValue(raw, depth) };
        if (fingerprint) {
            seen.set(fingerprint, row);
        }
        rows.push(row);
    }
    return rows;
}

/**
 * Whether a value sits on the label's own line or needs a block beneath it.
 * The card and the detail screen must agree, and it is the one layout decision
 * worth a test, so it lives here rather than in the renderer (DROVE-51).
 */
export function isInlineValue(value: StructuredValue): boolean {
    switch (value.kind) {
        case 'text':
            return !value.long;
        case 'path':
        case 'number':
        case 'boolean':
        case 'empty':
            return true;
        default:
            return false;
    }
}

/**
 * Rows for a tool input. A non-object input (a bare string, an array) still
 * yields one unlabelled row: fold, never drop.
 */
export function structuredRows(input: unknown): StructuredRow[] {
    if (input === null || input === undefined) {
        return [];
    }
    if (typeof input === 'object' && !Array.isArray(input)) {
        return rowsOf(input as Record<string, unknown>, 0);
    }
    return [{ key: '', label: '', aliases: [], value: structuredValue(input, 0) }];
}

/** The raw JSON that stays reachable behind a tap. */
export function rawJson(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    try {
        return JSON.stringify(value, null, 2) ?? String(value);
    } catch {
        return String(value);
    }
}

/**
 * Rows for the fields a dedicated card has NOT already spelled out itself.
 * SendMessage's card writes the recipient and the body in its own hand, so
 * those keys must not come back a second time as generic rows — but anything
 * the card does not know about still has to appear. Fold, never drop.
 */
export function structuredRowsOmitting(input: unknown, omit: string[]): StructuredRow[] {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return structuredRows(input);
    }
    const dropped = new Set(omit);
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        if (!dropped.has(key)) {
            kept[key] = value;
        }
    }
    return rowsOf(kept, 0);
}
