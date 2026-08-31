import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';

/**
 * What a session can actually be asked to run, read off the machine it runs on
 * (DROVE-170).
 *
 * Before this the app's `/` autocomplete offered five hardcoded entries and one
 * of them was `/skills`, a command that PRINTS the skills rather than offering
 * them. The list a harness publishes on the snapshot
 * (`metadata.slashCommands` / `metadata.skills`) is written from the SDK's
 * `system.init`, and only the remote launcher ever runs a query, so under one
 * mode (DROVE-1) every session is a tmux pane and that list is empty for all of
 * them.
 *
 * Nothing on disk holds the answer either — Claude Code's own enumeration is
 * emitted in `system.init` and never written to the transcript or a cache — so
 * this walks the same directories Claude Code resolves from. Measured against a
 * real `system.init` on 2.1.251: the walk reproduces every user, project and
 * plugin entry, name for name, including the `dir:name` namespacing a
 * subdirectory gets. What it cannot see is the built-ins baked into the binary,
 * which is what `builtinCommandFloor` is for.
 *
 * COMMANDS and SKILLS are kept apart. `system.init` reports skills inside
 * `slash_commands` as well, so one flat list cannot tell them back apart; the
 * directory an entry came from can, and that is the distinction the app draws.
 */

/** A command or skill, with whatever one-line description its file carries. */
export interface SessionInventoryEntry {
    name: string;
    description?: string;
    /** 'user' | 'project' | 'plugin' | 'builtin' — where it was found. */
    origin?: string;
}

export interface SessionInventory {
    commands: SessionInventoryEntry[];
    skills: SessionInventoryEntry[];
    /** How it was derived: 'scan' for a disk walk, 'harness' when an agent enumerated it. */
    source: string;
    updatedAt: number;
}

export interface SessionInventoryResponse {
    success: boolean;
    inventory?: SessionInventory;
    error?: string;
}

export interface DiscoverSessionInventoryOptions {
    /** Session flavor: 'codex' walks Codex's layout, anything else walks Claude Code's. */
    flavor?: string | null;
    cwd?: string;
    /** CLAUDE_CONFIG_DIR / CODEX_HOME for this session. A flip changes it, so pass it. */
    configDir?: string | null;
    homeDir?: string;
}

const skillFile = 'SKILL.md';
const maxScanDepth = 8;
/** One line in a dropdown row. Longer descriptions are the norm and are useless there. */
const maxDescriptionLength = 160;
/** A ceiling so a pathological tree cannot turn one RPC reply into megabytes. */
const maxEntriesPerKind = 500;

/**
 * Claude Code's own commands, which live inside the binary and cannot be
 * walked to. Captured from a real `system.init` on 2.1.251 and trimmed to the
 * ones that mean something from a phone: nothing that drives the local
 * terminal (`/vim`, `/terminal-setup`, `/ide`), nothing that manages the
 * install (`/upgrade`, `/migrate-installer`, `/doctor`), nothing internal
 * (`/__remote-workflow`, `/heapdump`).
 *
 * It is a floor, not the answer. The scan supplies the real inventory and this
 * only fills in what the scan structurally cannot see. Refresh it by hand when
 * Claude Code adds a command worth reaching from the app.
 *
 * Claude Code's built-in SKILLS (`/dataviz`, `/code-review`, `/run`, …) are
 * deliberately absent. That roster moves version to version, and a stale entry
 * would offer a skill the harness answers "unknown command" to — the failure
 * mode this whole change exists to end. A remote session gets them anyway: its
 * `system.init` publishes them and the app merges that list in behind the scan.
 */
export function builtinCommandFloor(): SessionInventoryEntry[] {
    return [
        { name: 'compact', description: 'Compact the conversation history', origin: 'builtin' },
        { name: 'clear', description: 'Clear the conversation', origin: 'builtin' },
        { name: 'goal', description: 'Set a session goal', origin: 'builtin' },
        { name: 'mcp', description: 'Show connected MCP servers', origin: 'builtin' },
        { name: 'skills', description: 'Show available skills', origin: 'builtin' },
        { name: 'context', description: 'Show what is filling the context window', origin: 'builtin' },
        { name: 'usage', description: 'Show usage against the current limits', origin: 'builtin' },
        { name: 'recap', description: 'Recap what this session has done', origin: 'builtin' },
        { name: 'insights', description: 'Show session insights', origin: 'builtin' },
        { name: 'model', description: 'Change the model for this session', origin: 'builtin' },
        { name: 'effort', description: 'Change the reasoning effort for this session', origin: 'builtin' },
        { name: 'rename', description: 'Rename this session', origin: 'builtin' },
        { name: 'init', description: 'Write a CLAUDE.md for this project', origin: 'builtin' },
        { name: 'review', description: 'Review the pending changes', origin: 'builtin' },
        { name: 'security-review', description: 'Security review of the pending changes', origin: 'builtin' },
    ];
}

function expandHomePath(path: string, homeDir: string): string {
    if (path === '~') return homeDir;
    if (path.startsWith(`~${sep}`)) return join(homeDir, path.slice(2));
    return path;
}

/**
 * The `description:` out of a Markdown file's YAML frontmatter.
 *
 * Deliberately not a YAML parser: a skill's frontmatter is two or three scalar
 * keys, and pulling a dependency in to read one of them would put a parser on
 * the RPC path for no gain. Handles the three shapes that actually occur — a
 * plain scalar, a quoted scalar, and a folded block (`>-` / `|`) whose
 * continuation lines are indented.
 */
export function frontmatterDescription(text: string): string | undefined {
    if (!text.startsWith('---')) return undefined;
    const end = text.indexOf('\n---', 3);
    if (end < 0) return undefined;
    const block = text.slice(3, end);
    const match = block.match(/^description:[ \t]*(.*)$/m);
    if (!match) return undefined;

    let value = match[1].trim();
    if (value === '' || value === '>' || value === '>-' || value === '|' || value === '|-') {
        const after = block.slice(block.indexOf(match[0]) + match[0].length);
        const lines: string[] = [];
        for (const line of after.split('\n').slice(1)) {
            if (!/^\s+\S/.test(line)) break;
            lines.push(line.trim());
        }
        value = lines.join(' ');
    }
    if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
    ) {
        value = value.slice(1, -1);
    }
    value = value.replace(/\s+/g, ' ').trim();
    if (!value) return undefined;
    return value.length > maxDescriptionLength
        ? `${value.slice(0, maxDescriptionLength - 1).trimEnd()}…`
        : value;
}

/**
 * Files under a root, FOLLOWING symlinks.
 *
 * Following them is not incidental. A skill directory is very often a link:
 * this repo's own `.claude/skills/release` points at `.agents/skills/release`,
 * and 5 of its 7 project skills are links like it. Claude Code resolves them
 * and so must this, or the scan reports a third of a project's skills.
 * `visited` holds real paths, which is what keeps a link back up the tree from
 * walking forever.
 */
async function walkFiles(
    dir: string,
    depth: number,
    found: string[],
    visited: Set<string>,
): Promise<void> {
    if (found.length > maxEntriesPerKind * 4) return;

    let real: string;
    try {
        real = await realpath(dir);
    } catch {
        return;
    }
    if (visited.has(real)) return;
    visited.add(real);

    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;

        let isDirectory = entry.isDirectory();
        let isFile = entry.isFile();
        if (entry.isSymbolicLink()) {
            try {
                const target = await stat(full);
                isDirectory = target.isDirectory();
                isFile = target.isFile();
            } catch {
                continue;
            }
        }

        if (isFile) {
            found.push(full);
        } else if (isDirectory && depth > 0) {
            await walkFiles(full, depth - 1, found, visited);
        }
    }
}

/**
 * Commands under one root. A subdirectory namespaces its commands with a colon,
 * which is what Claude Code itself reports: `commands/agent-os/plan.md` is
 * `/agent-os:plan`, `commands/flip.md` is `/flip`.
 */
async function scanCommandRoot(
    root: string,
    origin: string,
    namePrefix?: string,
): Promise<SessionInventoryEntry[]> {
    const files: string[] = [];
    await walkFiles(root, maxScanDepth, files, new Set());
    const out: SessionInventoryEntry[] = [];
    for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const stem = relative(root, file).replace(/\.md$/, '');
        if (!stem || stem.startsWith('..')) continue;
        const name = `${namePrefix ?? ''}${stem.split(sep).join(':')}`;
        out.push({ name, description: await describeFile(file), origin });
    }
    return out;
}

/** Skills under one root: every SKILL.md, named for the directory holding it. */
async function scanSkillRoot(
    root: string,
    origin: string,
    namePrefix?: string,
): Promise<SessionInventoryEntry[]> {
    const files: string[] = [];
    await walkFiles(root, maxScanDepth, files, new Set());
    const out: SessionInventoryEntry[] = [];
    for (const file of files) {
        if (basename(file) !== skillFile) continue;
        const name = basename(dirname(file));
        if (!name) continue;
        out.push({ name: `${namePrefix ?? ''}${name}`, description: await describeFile(file), origin });
    }
    return out;
}

async function describeFile(file: string): Promise<string | undefined> {
    try {
        return frontmatterDescription(await readFile(file, 'utf8'));
    } catch {
        return undefined;
    }
}

interface InstalledPlugins {
    plugins?: Record<string, Array<{ installPath?: string }> | undefined>;
}

/** Where each installed plugin was unpacked, per Claude Code's own manifest. */
async function installedPluginRoots(configDir: string): Promise<string[]> {
    let parsed: InstalledPlugins;
    try {
        parsed = JSON.parse(
            await readFile(join(configDir, 'plugins', 'installed_plugins.json'), 'utf8'),
        ) as InstalledPlugins;
    } catch {
        return [];
    }
    const roots: string[] = [];
    for (const installs of Object.values(parsed.plugins ?? {})) {
        for (const install of installs ?? []) {
            if (install?.installPath) roots.push(install.installPath);
        }
    }
    return roots;
}

/** First name wins, so a project entry shadows the user one of the same name. */
function dedupe(entries: SessionInventoryEntry[]): SessionInventoryEntry[] {
    const seen = new Set<string>();
    const out: SessionInventoryEntry[] = [];
    for (const entry of entries) {
        if (!entry.name || seen.has(entry.name)) continue;
        seen.add(entry.name);
        out.push(entry);
        if (out.length >= maxEntriesPerKind) break;
    }
    return out;
}

function byName(a: SessionInventoryEntry, b: SessionInventoryEntry): number {
    return a.name.localeCompare(b.name);
}

/**
 * Everything this session can run, read off the machine it is running on.
 *
 * Never throws and never rejects: an unreadable directory is simply not part of
 * the answer, because a broken plugin cache must not cost the app its
 * autocomplete.
 */
export async function discoverSessionInventory(
    opts: DiscoverSessionInventoryOptions = {},
): Promise<SessionInventory> {
    const homeDir = opts.homeDir ?? homedir();
    const cwd = opts.cwd ?? process.cwd();
    const commands: SessionInventoryEntry[] = [];
    const skills: SessionInventoryEntry[] = [];

    if (opts.flavor === 'codex') {
        const codexHome = expandHomePath(
            opts.configDir || process.env.CODEX_HOME || join('~', '.codex'),
            homeDir,
        );
        skills.push(...await scanSkillRoot(join(cwd, '.agents', 'skills'), 'project'));
        skills.push(...await scanSkillRoot(join(codexHome, 'skills'), 'user'));
        skills.push(...await scanSkillRoot(join(codexHome, 'plugins', 'cache'), 'plugin'));
    } else {
        const configDir = expandHomePath(
            opts.configDir || process.env.CLAUDE_CONFIG_DIR || join(homeDir, '.claude'),
            homeDir,
        );
        const projectDir = join(cwd, '.claude');
        commands.push(...await scanCommandRoot(join(projectDir, 'commands'), 'project'));
        commands.push(...await scanCommandRoot(join(configDir, 'commands'), 'user'));
        skills.push(...await scanSkillRoot(join(projectDir, 'skills'), 'project'));
        skills.push(...await scanSkillRoot(join(configDir, 'skills'), 'user'));
        for (const root of await installedPluginRoots(configDir)) {
            const plugin = basename(dirname(root));
            commands.push(...await scanCommandRoot(join(root, 'commands'), 'plugin', `${plugin}:`));
            skills.push(...await scanSkillRoot(join(root, 'skills'), 'plugin', `${plugin}:`));
        }
    }

    // The floor goes LAST so a command of the user's own with the same name
    // wins the dedupe: their `/clear` is the one that runs.
    const withFloor = opts.flavor === 'codex'
        ? commands.sort(byName)
        : [...commands.sort(byName), ...builtinCommandFloor()];

    return {
        commands: dedupe(withFloor),
        skills: dedupe(skills.sort(byName)),
        source: 'scan',
        updatedAt: Date.now(),
    };
}
