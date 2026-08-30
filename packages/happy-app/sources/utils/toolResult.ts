/**
 * What a tool result IS, so a card can show it instead of saying nothing
 * (DROVE-51). A Read of an image used to reach the detail screen as
 * "No output was produced": the result block existed, the screen only knew
 * how to print strings.
 *
 * Shapes measured from the session transcripts:
 * - a plain string (Bash, most Claude tools, MCP tools that return text)
 * - Claude's content-block array: `[{type:'text',text}]` or
 *   `[{type:'image',source:{type:'base64',media_type,data}}]`
 * - Claude's `toolUseResult` for Read: `{type:'text', file:{content,...}}`
 *   or `{type:'image', file:{base64, type, dimensions}}`
 * - a JSON string, or an object (MCP results, AskUserQuestion's answers)
 */

export type ToolResultPresentation =
    | { kind: 'empty' }
    | { kind: 'image'; uri: string; mediaType: string; width?: number; height?: number }
    | { kind: 'text'; text: string }
    | { kind: 'structured'; value: object }
    | { kind: 'mixed'; parts: ToolResultPresentation[] };

interface ContentBlock {
    type: string;
    text?: unknown;
    source?: { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isContentBlockArray(value: unknown): value is ContentBlock[] {
    return Array.isArray(value)
        && value.length > 0
        && value.every((item) => isRecord(item) && (item.type === 'text' || item.type === 'image'));
}

function parseJson(text: string): object | undefined {
    const trimmed = text.trim();
    const looksStructured = (trimmed.startsWith('{') && trimmed.endsWith('}'))
        || (trimmed.startsWith('[') && trimmed.endsWith(']'));
    if (!looksStructured) {
        return undefined;
    }
    try {
        const parsed: unknown = JSON.parse(trimmed);
        return parsed && typeof parsed === 'object' ? parsed : undefined;
    } catch {
        return undefined;
    }
}

function presentText(text: string): ToolResultPresentation {
    if (text.trim().length === 0) {
        return { kind: 'empty' };
    }
    const parsed = parseJson(text);
    if (parsed) {
        return { kind: 'structured', value: parsed };
    }
    return { kind: 'text', text };
}

function presentImageBlock(block: ContentBlock): ToolResultPresentation | null {
    const source = block.source;
    if (!isRecord(source)) {
        return null;
    }
    const mediaType = typeof source.media_type === 'string' ? source.media_type : 'image/png';
    if (source.type === 'base64' && typeof source.data === 'string' && source.data.length > 0) {
        return { kind: 'image', uri: `data:${mediaType};base64,${source.data}`, mediaType };
    }
    if (source.type === 'url' && typeof source.url === 'string') {
        return { kind: 'image', uri: source.url, mediaType };
    }
    return null;
}

function presentBlocks(blocks: ContentBlock[]): ToolResultPresentation {
    const parts: ToolResultPresentation[] = [];
    let pendingText: string[] = [];
    const flushText = () => {
        if (pendingText.length > 0) {
            parts.push(presentText(pendingText.join('\n')));
            pendingText = [];
        }
    };
    for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string') {
            pendingText.push(block.text);
            continue;
        }
        if (block.type === 'image') {
            flushText();
            const image = presentImageBlock(block);
            if (image) {
                parts.push(image);
            }
        }
    }
    flushText();
    const kept = parts.filter((part) => part.kind !== 'empty');
    if (kept.length === 0) {
        return { kind: 'empty' };
    }
    if (kept.length === 1) {
        return kept[0];
    }
    return { kind: 'mixed', parts: kept };
}

/** Claude's on-disk `toolUseResult` for Read carries the file under `file`. */
function presentFileResult(record: Record<string, unknown>): ToolResultPresentation | null {
    const file = record.file;
    if (!isRecord(file)) {
        return null;
    }
    if (record.type === 'image' && typeof file.base64 === 'string' && file.base64.length > 0) {
        const mediaType = typeof file.type === 'string' ? file.type : 'image/png';
        const dimensions = isRecord(file.dimensions) ? file.dimensions : undefined;
        const width = typeof dimensions?.originalWidth === 'number' ? dimensions.originalWidth : undefined;
        const height = typeof dimensions?.originalHeight === 'number' ? dimensions.originalHeight : undefined;
        return { kind: 'image', uri: `data:${mediaType};base64,${file.base64}`, mediaType, width, height };
    }
    if (typeof file.content === 'string') {
        return presentText(file.content);
    }
    return null;
}

export function presentToolResult(result: unknown): ToolResultPresentation {
    if (result === null || result === undefined) {
        return { kind: 'empty' };
    }
    if (typeof result === 'string') {
        return presentText(result);
    }
    if (isContentBlockArray(result)) {
        return presentBlocks(result);
    }
    if (Array.isArray(result)) {
        return result.length === 0 ? { kind: 'empty' } : { kind: 'structured', value: result };
    }
    if (isRecord(result)) {
        const asFile = presentFileResult(result);
        if (asFile) {
            return asFile;
        }
        return Object.keys(result).length === 0 ? { kind: 'empty' } : { kind: 'structured', value: result };
    }
    return presentText(String(result));
}

/** True when there is nothing at all to show, which is the only time "no output" is honest. */
export function isEmptyToolResult(result: unknown): boolean {
    return presentToolResult(result).kind === 'empty';
}

/** The result as one string, for an error banner or a raw fold. Base64 image data is elided. */
export function toolResultText(result: unknown): string {
    if (typeof result === 'string') {
        return result;
    }
    const presentation = presentToolResult(result);
    if (presentation.kind === 'text') {
        return presentation.text;
    }
    if (presentation.kind === 'image') {
        return `[${presentation.mediaType}]`;
    }
    try {
        return JSON.stringify(result, (_key, value: unknown) => {
            if (typeof value === 'string' && value.length > 4096) {
                return `${value.slice(0, 64)}… (${value.length} chars)`;
            }
            return value;
        }, 2) ?? String(result);
    } catch {
        return String(result);
    }
}
