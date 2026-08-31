/**
 * What the session in front of you can actually be asked to run (DROVE-170).
 *
 * Typing `/` used to offer five entries — compact, clear, goal, mcp, skills —
 * off a constant in this app, on a machine with dozens of commands and skills.
 * `/skills` sitting in that list was the tell: the app knew skills existed and
 * offered a command that PRINTS them rather than offering the skills.
 *
 * Three sources, in order, so the list degrades instead of emptying:
 *
 *   1. the `sessionInventory` RPC — the machine the session runs on walks its
 *      own commands/ and skills/ trees and answers with kinds and one-line
 *      descriptions. Per machine, per account and per project by construction,
 *      because the answer is computed where the session lives at the moment it
 *      is asked, not cached against a session id.
 *   2. `metadata.slashCommands` / `metadata.skills` — the flat lists a harness
 *      publishes on the snapshot from its own `system.init` or
 *      `available_commands`. Names only, and skills appear in BOTH lists, so
 *      the kinds are recovered by set difference.
 *   3. `commandFallback` — the five this file used to hardcode. A harness with
 *      no way to enumerate lands here rather than on an empty dropdown.
 *
 * Everything in this file is pure. The RPC, its cache and its lifetime live in
 * suggestionCommands.ts.
 */

export type InventoryKind = 'command' | 'skill';

export interface InventoryEntry {
    name: string;
    kind: InventoryKind;
    description?: string;
    /** 'user' | 'project' | 'plugin' | 'builtin' | 'harness' */
    origin?: string;
}

/** The shape the CLI's `sessionInventory` RPC answers with. */
export interface SessionInventoryPayload {
    commands?: { name?: unknown; description?: unknown; origin?: unknown }[];
    skills?: { name?: unknown; description?: unknown; origin?: unknown }[];
    source?: unknown;
    updatedAt?: unknown;
}

/**
 * What is offered when nothing can be enumerated: exactly what shipped before
 * this change. Not a floor under the real inventory — a replacement for it when
 * there is none, so an offline or unknown harness is no worse off than it was.
 */
export const commandFallback: InventoryEntry[] = [
    { name: 'compact', kind: 'command', description: 'Compact the conversation history', origin: 'builtin' },
    { name: 'clear', kind: 'command', description: 'Clear the conversation', origin: 'builtin' },
    { name: 'goal', kind: 'command', description: 'Set a session goal', origin: 'builtin' },
    { name: 'mcp', kind: 'command', description: 'Show connected MCP servers', origin: 'builtin' },
    { name: 'skills', kind: 'command', description: 'Show available skills', origin: 'builtin' },
];

/**
 * Names a harness reports that cannot mean anything from a phone: they drive
 * the local terminal, manage the install, or log you in and out.
 *
 * Applied ONLY to the flat `metadata.slashCommands` list, where these are
 * Claude Code's own built-ins. A skill discovered on disk is never filtered by
 * it, so somebody's own `/review` or `/init` still reaches the list.
 */
const terminalOnlyCommands = new Set([
    'add-dir', 'bashes', 'bug', 'config', 'doctor', 'exit', 'export', 'help', 'hooks', 'ide',
    'install-github-app', 'login', 'logout', 'migrate-installer', 'permissions', 'pr-comments',
    'release-notes', 'resume', 'settings', 'statusline', 'terminal-setup', 'upgrade', 'vim',
]);

const knownDescriptions: Record<string, string> = {
    compact: 'Compact the conversation history',
    clear: 'Clear the conversation',
    goal: 'Set a session goal',
    mcp: 'Show connected MCP servers',
    skills: 'Show available skills',
    context: 'Show what is filling the context window',
    usage: 'Show usage against the current limits',
    model: 'Change the model for this session',
    effort: 'Change the reasoning effort for this session',
    rename: 'Rename this session',
    init: 'Write a CLAUDE.md for this project',
};

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** Entries out of the RPC reply. Anything malformed is dropped, not thrown on. */
export function inventoryFromPayload(payload: SessionInventoryPayload | null | undefined): InventoryEntry[] {
    if (!payload) return [];
    const read = (rows: SessionInventoryPayload['commands'], kind: InventoryKind): InventoryEntry[] => {
        if (!Array.isArray(rows)) return [];
        const out: InventoryEntry[] = [];
        for (const row of rows) {
            const name = text(row?.name);
            if (!name) continue;
            out.push({
                name,
                kind,
                description: text(row?.description) ?? knownDescriptions[name],
                origin: text(row?.origin),
            });
        }
        return out;
    };
    return [...read(payload.commands, 'command'), ...read(payload.skills, 'skill')];
}

/**
 * Entries out of the snapshot's flat lists.
 *
 * A harness reports its skills inside `slashCommands` as well as in `skills` —
 * measured on Claude Code 2.1.251, where 95 of the 137 slash commands were
 * skills — so the set difference is what tells the two kinds apart here.
 */
export function inventoryFromMetadata(metadata: {
    slashCommands?: string[] | null;
    skills?: string[] | null;
} | null | undefined): InventoryEntry[] {
    const skillNames = (metadata?.skills ?? []).filter((name) => typeof name === 'string' && name.length > 0);
    const skills = new Set(skillNames);
    const commands = (metadata?.slashCommands ?? []).filter((name) => (
        typeof name === 'string'
        && name.length > 0
        && !skills.has(name)
        && !terminalOnlyCommands.has(name)
    ));
    return [
        ...commands.map((name): InventoryEntry => ({
            name,
            kind: 'command',
            description: knownDescriptions[name],
            origin: 'harness',
        })),
        ...skillNames.map((name): InventoryEntry => ({
            name,
            kind: 'skill',
            origin: 'harness',
        })),
    ];
}

function rank(entry: InventoryEntry): number {
    if (entry.kind === 'command') return entry.origin === 'builtin' ? 0 : 1;
    return 2;
}

/**
 * One list out of however many sources answered, first occurrence winning.
 *
 * Kind is part of the identity: a name can legitimately be both a command and a
 * skill, and collapsing them would hide one of the two.
 */
export function mergeInventory(...sources: InventoryEntry[][]): InventoryEntry[] {
    const seen = new Set<string>();
    const out: InventoryEntry[] = [];
    for (const source of sources) {
        for (const entry of source) {
            const key = `${entry.kind}:${entry.name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(entry);
        }
    }
    // The five everyone types stay at the top of an unfiltered list; the rest
    // keeps the order its source gave, which is alphabetical from the scan.
    return out
        .map((entry, index) => ({ entry, index }))
        .sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index)
        .map(({ entry }) => entry);
}

/**
 * Where a query matches an entry. Lower is better; `noMatch` drops it.
 *
 * Plain prefix and substring scans rather than a fuzzy index. Two reasons: it
 * is what every command palette does, so `/sup` puts `superpowers--*` at the
 * top instead of whatever scored best across the descriptions; and it costs one
 * pass of indexOf over a few hundred short strings, with no index to rebuild on
 * each keystroke.
 */
const noMatch = 99;

export function matchScore(entry: InventoryEntry, query: string): number {
    if (!query) return 0;
    const name = entry.name.toLowerCase();
    if (name === query) return 0;
    if (name.startsWith(query)) return 1;

    // A namespaced or hyphenated name matches on any of its parts, so `/brain`
    // finds `superpowers--brainstorming` and `/plan` finds `agent-os:plan-new-product`.
    let cursor = 0;
    while (cursor < name.length) {
        const next = name.slice(cursor).search(/[:\-_]/);
        if (next < 0) break;
        cursor += next + 1;
        if (name.startsWith(query, cursor)) return 2;
    }

    if (name.includes(query)) return 3;
    if (entry.description && entry.description.toLowerCase().includes(query)) return 4;
    return noMatch;
}

export function searchInventory(
    entries: InventoryEntry[],
    query: string,
    limit = 50,
): InventoryEntry[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return entries.slice(0, limit);

    const scored: { entry: InventoryEntry; score: number; index: number }[] = [];
    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        const score = matchScore(entry, needle);
        if (score === noMatch) continue;
        scored.push({ entry, score, index });
    }
    scored.sort((a, b) => (
        a.score - b.score
        || a.entry.name.length - b.entry.name.length
        || a.index - b.index
    ));
    return scored.slice(0, limit).map(({ entry }) => entry);
}
