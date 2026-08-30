/**
 * The Huly ticket ops as one card: identifier, title, and what changed
 * (DROVE-51). The MCP tools are `mcp__huly__huly_<op>`; their results are a
 * text block holding JSON with `identifier`, `title`, `status`, `url` and,
 * for a write, `updated: [field]` / `commented: true`. Measured from the
 * cattle-drover transcripts.
 */
import { presentToolResult } from './toolResult';

export interface HulyChange {
    key: string;
    value: unknown;
}

export interface HulyListItem {
    identifier: string;
    title: string;
    status?: string;
}

export interface HulySummary {
    op: string;
    identifier?: string;
    title?: string;
    status?: string;
    priority?: string;
    url?: string;
    /** The fields this op wrote, with the values it wrote. */
    changes: HulyChange[];
    /** A body the op carried: a comment, a description. */
    text?: string;
    /** The tickets a search or list came back with. */
    items: HulyListItem[];
}

const hulyPrefix = 'mcp__huly__';

export function isHulyTool(name: string): boolean {
    return name.startsWith(hulyPrefix);
}

/** `mcp__huly__huly_update` reads as `update`. */
export function hulyOp(name: string): string {
    return name.slice(hulyPrefix.length).replace(/^huly_/, '') || 'huly';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
    const value = record?.[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function resultRecord(result: unknown): Record<string, unknown> | undefined {
    const presentation = presentToolResult(result);
    if (presentation.kind === 'structured' && isRecord(presentation.value)) {
        return presentation.value;
    }
    return undefined;
}

function listItems(rows: unknown): HulyListItem[] {
    if (!Array.isArray(rows)) {
        return [];
    }
    const items: HulyListItem[] = [];
    for (const row of rows) {
        if (!isRecord(row)) {
            continue;
        }
        const identifier = stringField(row, 'identifier');
        const title = stringField(row, 'title');
        if (identifier && title) {
            items.push({ identifier, title, status: stringField(row, 'status') });
        }
    }
    return items;
}

/** Keys that name the ticket or the op itself rather than a change to it. */
const addressKeys = new Set(['identifier', 'project', 'op']);
/** Keys whose value is a body shown as text, not a change row. */
const bodyKeys = new Set(['text', 'description', 'comment']);

export function summarizeHulyTool(name: string, input: unknown, result: unknown): HulySummary {
    const op = hulyOp(name);
    const inputRecord = isRecord(input) ? input : undefined;
    const record = resultRecord(result);

    const summary: HulySummary = {
        op,
        identifier: stringField(record, 'identifier') ?? stringField(inputRecord, 'identifier'),
        title: stringField(record, 'title') ?? (op === 'create' ? stringField(inputRecord, 'title') : undefined),
        status: stringField(record, 'status'),
        priority: stringField(record, 'priority'),
        url: stringField(record, 'url'),
        changes: [],
        items: [],
    };

    if (inputRecord) {
        for (const [key, value] of Object.entries(inputRecord)) {
            if (addressKeys.has(key) || value === undefined || value === null) {
                continue;
            }
            if (bodyKeys.has(key) && typeof value === 'string') {
                summary.text = summary.text ? `${summary.text}\n\n${value}` : value;
                continue;
            }
            if (op === 'create' && key === 'title') {
                continue;
            }
            summary.changes.push({ key, value });
        }
    }

    if (record) {
        // A read shows the ticket body; a write already shows what it sent.
        if (op === 'show') {
            summary.text = stringField(record, 'description');
        }
        summary.items = listItems(record.matches ?? record.issues ?? record.rows);
    }

    return summary;
}

/** The card header: `Huly · update DROVE-51`. */
export function hulyToolTitle(name: string, input: unknown): string {
    const op = hulyOp(name);
    const identifier = isRecord(input) ? stringField(input, 'identifier') : undefined;
    const project = isRecord(input) ? stringField(input, 'project') : undefined;
    const target = identifier ?? project;
    return target ? `Huly · ${op} ${target}` : `Huly · ${op}`;
}
