import * as z from 'zod';
import type { ToolCall } from '@/sync/typesMessage';
import { presentToolResult, toolResultText } from '@/utils/toolResult';

/**
 * What a Bash card prints (DROVE-95), from whichever shape the result took.
 *
 * Measured on session 19c2f0a8, tool_use toolu_0173G9EJ… (the "File the
 * push-tap routing ticket" Bash, 01:37:56Z): the transcript's tool_result had
 * `content` as a plain string, `is_error: false`, and Claude's structured
 * `toolUseResult` as `{stdout, stderr: '', interrupted, isImage,
 * noOutputExpected}`. The app's parser already read both; what it never got
 * was the result at all, because the CLI's tool-call-end named the call and
 * nothing else. That is fixed on the wire; this helper is the one reader the
 * compact card and the full view share so they cannot disagree again.
 *
 * Shapes:
 * - Claude's structured Bash result: `{stdout, stderr, …}`
 * - a plain string (the tool_result content, or the folded text blocks)
 * - an array of content blocks: `[{type:'text', text}]`, folded to one string
 * - a permission refusal: `{error}`
 */

const bashResultSchema = z.object({
    stdout: z.string(),
    stderr: z.string(),
}).partial().passthrough();

export interface BashResultText {
    stdout: string | null;
    stderr: string | null;
    error: string | null;
}

const nothing: BashResultText = { stdout: null, stderr: null, error: null };

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Every text block joined, for a content-block array; anything else as the util prints it. */
function foldBlocks(result: unknown[]): string | null {
    const texts = result
        .filter((block): block is { type: 'text'; text: string } =>
            isRecord(block) && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text);
    if (texts.length > 0) {
        return texts.join('\n');
    }
    return presentToolResult(result).kind === 'empty' ? null : toolResultText(result);
}

export function readBashResult(tool: Pick<ToolCall, 'state' | 'result'>): BashResultText {
    const { state, result } = tool;
    if (state === 'error') {
        if (typeof result === 'string') {
            return { ...nothing, error: result };
        }
        if (isRecord(result) && typeof result.error === 'string') {
            return { ...nothing, error: result.error };
        }
        if (result === null || result === undefined || presentToolResult(result).kind === 'empty') {
            return nothing;
        }
        return { ...nothing, error: toolResultText(result) };
    }
    if (state !== 'completed' || result === null || result === undefined) {
        return nothing;
    }
    if (typeof result === 'string') {
        return { ...nothing, stdout: result };
    }
    if (Array.isArray(result)) {
        return { ...nothing, stdout: foldBlocks(result) };
    }
    const parsed = bashResultSchema.safeParse(result);
    if (parsed.success && (typeof parsed.data.stdout === 'string' || typeof parsed.data.stderr === 'string')) {
        return {
            stdout: parsed.data.stdout ?? null,
            stderr: parsed.data.stderr ?? null,
            error: null,
        };
    }
    return { ...nothing, stdout: JSON.stringify(result) };
}
