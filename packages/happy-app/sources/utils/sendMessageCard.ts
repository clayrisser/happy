/**
 * What a SendMessage card says (DROVE-51). Claude Code's SendMessage tool
 * carries the recipient under `to` (older sessions: `recipient`) and the body
 * under `message` (older: `content`), plus an optional `summary`. The card
 * reads as `Message to <to>: <first line>` and unfolds to the whole body.
 * Every decision about the words lives here so it can be tested without a
 * renderer.
 */

const toKeys = ['to', 'recipient'];
const bodyKeys = ['message', 'content'];

/** The keys the card writes in its own hand, so generic rows must skip them. */
export const sendMessageOwnKeys = [...toKeys, ...bodyKeys, 'summary'];

/** Past this the collapsed row elides the first line. */
export const sendMessageSummaryChars = 80;

function asRecord(input: unknown): Record<string, unknown> {
    return input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim().length > 0) {
            return value;
        }
    }
    return undefined;
}

export function sendMessageRecipient(input: unknown): string | undefined {
    return firstString(asRecord(input), toKeys)?.trim();
}

export function sendMessageBody(input: unknown): string | undefined {
    return firstString(asRecord(input), bodyKeys);
}

export function sendMessageSummaryField(input: unknown): string | undefined {
    return firstString(asRecord(input), ['summary'])?.trim();
}

/** Cuts at a word boundary where one is near, so the row does not end mid-word. */
export function elide(text: string, max: number): string {
    if (text.length <= max) {
        return text;
    }
    const head = text.slice(0, max);
    const space = head.lastIndexOf(' ');
    const cut = space > max * 0.6 ? head.slice(0, space) : head;
    return `${cut.trimEnd()}…`;
}

/**
 * The first non-empty line of the body, trimmed to the row's width. Leading
 * markdown furniture (a heading marker, a bullet) is dropped so the row reads
 * as prose. The summary field is NOT used here: it is the sender's gloss and
 * is shown in the expanded card, while the row shows what was actually said.
 */
export function sendMessageFirstLine(input: unknown, max: number = sendMessageSummaryChars): string | undefined {
    const body = sendMessageBody(input);
    if (!body) {
        return undefined;
    }
    for (const rawLine of body.split('\n')) {
        const line = rawLine
            .trim()
            .replace(/^(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+)/, '')
            .replace(/\s+/g, ' ')
            .trim();
        if (line.length > 0) {
            return elide(line, max);
        }
    }
    return undefined;
}

/** `Message to <to>`; `Message` when the recipient is missing. */
export function sendMessageTitle(input: unknown, words: { to: (to: string) => string; untitled: string }): string {
    const to = sendMessageRecipient(input);
    return to ? words.to(to) : words.untitled;
}

export function sendMessageLineCount(input: unknown): number {
    const body = sendMessageBody(input);
    return body ? body.split('\n').length : 0;
}

export interface SendMessageOutcome {
    ok: boolean;
    /** What the bus said back, when it said anything readable. */
    text?: string;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
        return undefined;
    }
    try {
        const parsed: unknown = JSON.parse(trimmed);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The result of a SendMessage, measured from transcripts:
 * `{success:true, message:'Message queued for delivery to … at its next tool round.', pin:{…}}`
 * or a plain error string. Null when there is no result yet.
 */
export function sendMessageOutcome(result: unknown): SendMessageOutcome | null {
    if (result === null || result === undefined) {
        return null;
    }
    const record = typeof result === 'string'
        ? parseJsonObject(result)
        : (result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>) : undefined);
    if (record) {
        const ok = record.success !== false && record.error === undefined;
        const text = typeof record.message === 'string' && record.message.trim().length > 0
            ? record.message.trim()
            : typeof record.error === 'string' && record.error.trim().length > 0
                ? record.error.trim()
                : undefined;
        return { ok, text };
    }
    if (typeof result === 'string') {
        const text = result.trim();
        if (text.length === 0) {
            return null;
        }
        return { ok: !/^error\b/i.test(text), text };
    }
    return { ok: true };
}
