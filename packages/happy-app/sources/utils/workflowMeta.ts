export interface WorkflowMeta {
    name?: string;
    description?: string;
}

const metaBlock = /export\s+const\s+meta\s*=\s*\{([\s\S]{0,4000}?)\n\}/;

// Matches `key: 'value'`, `key: "value"` or a backtick literal, honouring a backslash-escaped
// quote inside the value so `'the drover\'s gates'` survives intact.
function matchField(block: string, key: string): string | undefined {
    const re = new RegExp(`\\b${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`);
    const raw = re.exec(block)?.[2];
    if (raw === undefined) {
        return undefined;
    }
    return raw.replace(/\\(.)/g, '$1');
}

/**
 * Pulls `name` and `description` out of a Workflow script's `export const meta = { ... }`
 * block using regex only. No eval, no JS parser. Malformed or truncated input yields `{}`.
 *
 * `phases` is deliberately not parsed: it is a nested array, and scraping it breaks on any
 * script that computes its phases or nests a `name:` inside a step.
 */
export function parseWorkflowMeta(script: unknown): WorkflowMeta {
    if (typeof script !== 'string' || script.length === 0) {
        return {};
    }
    const block = metaBlock.exec(script)?.[1];
    if (!block) {
        return {};
    }
    return {
        name: matchField(block, 'name'),
        description: matchField(block, 'description'),
    };
}
