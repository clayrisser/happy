/**
 * The script out of a Workflow tool input. The key has moved around between
 * agent flavours, so try the ones that have actually shown up. Lives here
 * rather than in knownTools because the card, the subtitle and the detail
 * screen all need the same answer (DROVE-51).
 */
export function getWorkflowScript(input: unknown): string | undefined {
    if (!input || typeof input !== 'object') {
        return undefined;
    }
    const record = input as Record<string, unknown>;
    for (const key of ['script', 'code', 'source', 'workflow', 'content']) {
        const value = record[key];
        if (typeof value === 'string') {
            return value;
        }
    }
    return undefined;
}

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

export interface WorkflowPhase {
    title: string;
    detail?: string;
}

/**
 * The phases of a Workflow script's meta block, for the card (DROVE-51).
 * Same regex-only rule as parseWorkflowMeta, and the same limit applies: a
 * script that computes its phases yields [] here, which the card takes as
 * "no phases to show", never as an error. Each phase is one `{ ... }` literal
 * carrying `title` (or `name`) and optionally `detail`.
 */
export function parseWorkflowPhases(script: unknown): WorkflowPhase[] {
    if (typeof script !== 'string' || script.length === 0) {
        return [];
    }
    const block = metaBlock.exec(script)?.[1];
    if (!block) {
        return [];
    }
    const start = /\bphases\s*:\s*\[/.exec(block);
    if (!start) {
        return [];
    }
    const from = start.index + start[0].length;
    const end = block.indexOf(']', from);
    const list = block.slice(from, end === -1 ? undefined : end);
    const phases: WorkflowPhase[] = [];
    for (const match of list.matchAll(/\{([^{}]*)\}/g)) {
        const title = matchField(match[1], 'title') ?? matchField(match[1], 'name');
        if (!title) {
            continue;
        }
        phases.push({ title, detail: matchField(match[1], 'detail') });
    }
    return phases;
}
