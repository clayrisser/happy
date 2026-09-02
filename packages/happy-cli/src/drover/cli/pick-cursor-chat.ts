/**
 * `drover pick-cursor-chat` — pick a Cursor chat to resume (DROVE-253), in node
 * (DROVE-315).
 *
 * A straight port of cattle-drover/libexec/drover-pick-cursor-chat: the same
 * options, the same exit codes, the same rows.
 *
 * WHY THIS EXISTS RATHER THAN SHELLING OUT TO CURSOR. cursor-agent HAS a
 * picker: `ls` resumes a chosen session and `resume` takes the latest. Both are
 * Ink TUIs and both refuse a non-TTY, so neither can be asked for an id from a
 * script. What they read, though, is a plain directory:
 *
 *   <config dir>/chats/<32 hex>/<uuid>/meta.json
 *   {"schemaVersion":1,"createdAtMs":..,"updatedAtMs":..,"cwd":"..","hasConversation":true}
 *
 * The <uuid> is exactly what `--resume <chatId>` takes. Same contract as the
 * other pickers: the picked id on stdout and NOTHING else, the list on stderr,
 * exit 1 when there is nothing to pick or nothing was picked, 2 on an unknown
 * argument.
 *
 * WHAT A ROW CANNOT SAY. meta.json carries no title. The conversation lives
 * beside it in store.db, a SQLite content-addressed blob DAG whose messages are
 * part JSON and part protobuf; digging the first prompt out is a guess at a
 * private encoding that would break the next time Cursor changes it, so this
 * does not try. A row is the id, how long ago the chat last moved, and its
 * directory.
 *
 * `hasConversation:false` rows are DROPPED. Those are minted-and-abandoned
 * chats — `create-chat` writes one every time a drover Cursor session starts —
 * and resuming one is indistinguishable from starting fresh, except that it
 * looks like history.
 *
 * CONFIG DIR, not data dir — this was believed the other way round and it was
 * wrong. `chats = join(configDir(), "chats")`, where `configDir()` is
 * CURSOR_CONFIG_DIR || XDG_CONFIG_HOME/cursor || ~/.cursor. Only `projects/`
 * follows CURSOR_DATA_DIR. It matters because a drover session runs under its
 * OWN config dir, whose chats/ the fork CLI symlinks back to the shared store
 * (cursorConfig.ts, linkSharedChats) — so resolving from the config dir lands
 * on the shared store either way, and resolving from CURSOR_DATA_DIR only
 * happened to work while that variable was unset.
 *
 * The jq label program is reimplemented in node, padding included: printf's
 * %-Ns counts bytes and jq's length counts codepoints, so an accented path
 * would skew the row. The `command -v jq` CHECK survives, because its exit 1 is
 * part of the contract.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';

const HELP = `drover pick-cursor-chat — pick a Cursor chat in this directory to resume.

USAGE
  drover pick-cursor-chat            Show the picker, print the id picked
  drover pick-cursor-chat --latest   The most recent one, no picker
  drover pick-cursor-chat --list     The rows, newest first, and nothing else
      --cwd <dir>                    ... for a directory other than $PWD
      --all                          ... every directory, with the dir shown

Reads ~/.cursor/chats/*/*/meta.json, because \`cursor-agent ls\` and
\`cursor-agent resume\` are Ink TUIs that refuse a non-TTY and so cannot be
asked for an id. Chats with no conversation yet are not listed.
`;

export type Env = Record<string, string | undefined>;

/** One chat, as the first jq pass' `@tsv` wrote it. */
export interface ChatRow {
    id: string;
    /** Epoch SECONDS — `(.updatedAtMs // .createdAtMs // 0) / 1000 | floor`. */
    at: number;
    cwd: string;
}

export interface ChatIo {
    env: Env;
    home: string;
    cwd: string;
    /** Epoch seconds; the shell's `$(date +%s)`. */
    now: () => number;
    out: (line: string) => void;
    err: (line: string) => void;
    /** Written without a newline — the numbered fallback's prompt. */
    errRaw: (text: string) => void;
    which: (name: string) => string | null;
    isDirectory: (path: string) => boolean;
    /** Every `<chats>/*<slash>*<slash>meta.json`, the way the shell's glob is. */
    listMetas: (chats: string) => string[];
    readFile: (path: string) => string | null;
    isTty: () => boolean;
    gumChoose: (
        header: string,
        height: number,
        rows: readonly { label: string; value: string }[],
    ) => string | null;
    readLine: () => string | null;
}

function whichOnPath(name: string, env: Env): string | null {
    for (const dir of (env.PATH ?? '').split(delimiter)) {
        if (!dir) continue;
        const candidate = join(dir, name);
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

function readStdinLine(): string | null {
    const buf = Buffer.alloc(1);
    let line = '';
    for (;;) {
        let n = 0;
        try {
            n = readSync(0, buf, 0, 1, null);
        } catch {
            return line === '' ? null : line;
        }
        if (n === 0) return line === '' ? null : line;
        const c = buf.toString('utf8');
        if (c === '\n') return line;
        line += c;
    }
}

export function defaultChatIo(): ChatIo {
    return {
        env: process.env,
        home: homedir(),
        cwd: process.cwd(),
        now: () => Math.floor(Date.now() / 1000),
        out: (line) => process.stdout.write(`${line}\n`),
        err: (line) => process.stderr.write(`${line}\n`),
        errRaw: (text) => process.stderr.write(text),
        which: (name) => whichOnPath(name, process.env),
        isDirectory: (path) => {
            try {
                return statSync(path).isDirectory();
            } catch {
                return false;
            }
        },
        listMetas: (chats) => {
            const out: string[] = [];
            let outer: string[];
            try {
                outer = readdirSync(chats).sort();
            } catch {
                return out;
            }
            for (const a of outer) {
                let inner: string[];
                try {
                    inner = readdirSync(join(chats, a)).sort();
                } catch {
                    continue;
                }
                for (const b of inner) {
                    const meta = join(chats, a, b, 'meta.json');
                    if (existsSync(meta)) out.push(meta);
                }
            }
            return out;
        },
        readFile: (path) => {
            try {
                return readFileSync(path, 'utf8');
            } catch {
                return null;
            }
        },
        isTty: () => Boolean(process.stdin.isTTY) && Boolean(process.stderr.isTTY),
        gumChoose: (header, height, rows) => {
            const input = rows.map((r) => `${r.label}\t${r.value}`).join('\n');
            const r = spawnSync(
                'gum',
                ['choose', '--header', header, '--height', String(height), '--cursor', '> ', '--label-delimiter', '\t'],
                { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'inherit'] },
            );
            if (r.error || r.status !== 0) return null;
            const picked = (r.stdout ?? '').trim();
            return picked === '' ? null : picked;
        },
        readLine: readStdinLine,
    };
}

/**
 * `configDir()`: CURSOR_CONFIG_DIR || XDG_CONFIG_HOME/cursor || ~/.cursor. The
 * config-dir-not-data-dir fix, kept exactly as the shell resolves it.
 */
export function cursorChatsDir(env: Env, home: string): string {
    let configDir = env.CURSOR_CONFIG_DIR || (env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, 'cursor') : '');
    if (!configDir) configDir = join(home, '.cursor');
    return join(configDir, 'chats');
}

/** One meta.json. Null when it is unreadable or has no conversation yet. */
export function readChatMeta(id: string, text: string): ChatRow | null {
    let m: { hasConversation?: unknown; updatedAtMs?: unknown; createdAtMs?: unknown; cwd?: unknown };
    try {
        m = JSON.parse(text);
    } catch {
        return null;
    }
    if (!m || typeof m !== 'object') return null;
    if ((m.hasConversation ?? false) !== true) return null;
    const ms = Number(m.updatedAtMs ?? m.createdAtMs ?? 0);
    return { id, at: Math.floor((Number.isFinite(ms) ? ms : 0) / 1000), cwd: typeof m.cwd === 'string' ? m.cwd : '' };
}

/** jq's `age`: the coarsest unit that is not zero, exactly as it spelled it. */
export function age(seconds: number): string {
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

/** jq's `head($n)`: an over-long path keeps its TAIL, with a leading ellipsis. */
export function head(s: string, n: number): string {
    const cp = [...s];
    return cp.length > n ? `…${cp.slice(cp.length - n + 1).join('')}` : s;
}

/** `~` for $HOME, the way the label pass abbreviates it. */
export function tildify(dir: string, home: string): string {
    if (dir.startsWith(`${home}/`)) return `~${dir.slice(home.length)}`;
    if (dir === home) return '~';
    return dir;
}

/**
 * The jq label pass. Output is `<id>\t<label>` — the id for the caller, the
 * label for the human — with the age column padded to the widest age so the
 * rows line up whatever the mix of units.
 */
export function labelRows(rows: readonly ChatRow[], now: number, home: string, scope: 'cwd' | 'all'): { value: string; label: string }[] {
    const ages = rows.map((r) => age(now - r.at));
    const wage = ages.reduce((max, a) => ([...a].length > max ? [...a].length : max), 0);
    return rows.map((r, i) => {
        const a = ages[i];
        const pad = ' '.repeat(Math.max(0, wage - [...a].length));
        const dir = head(tildify(r.cwd, home), 48);
        return { value: r.id, label: `${r.id.slice(0, 8)}  ${a}${pad}${scope === 'all' ? `  ${dir}` : ''}` };
    });
}

export interface ChatOptions {
    io?: ChatIo;
}

export async function run(args: string[], opts: ChatOptions = {}): Promise<number> {
    // Answered first and touching nothing, the way every other drover verb
    // answers it — the shell reached it a few lines later, with the same text.
    if (args[0] === '--help' || args[0] === '-h') {
        process.stdout.write(HELP);
        return 0;
    }
    const io = opts.io ?? defaultChatIo();

    const chats = cursorChatsDir(io.env, io.home);
    const limit = Number(io.env.DROVER_PICK_LIMIT || '40');
    let mode: 'pick' | 'latest' | 'list' = 'pick';
    let cwd = io.cwd;
    let scope: 'cwd' | 'all' = 'cwd';

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--latest') {
            mode = 'latest';
        } else if (a === '--list') {
            mode = 'list';
        } else if (a === '--all') {
            scope = 'all';
        } else if (a === '--cwd') {
            if (i + 1 >= args.length) {
                io.err('drover pick-cursor-chat: --cwd needs a directory');
                return 2;
            }
            cwd = args[i + 1];
            i++;
        } else if (a === '-h' || a === '--help') {
            io.out(HELP.replace(/\n$/, ''));
            return 0;
        } else {
            io.err(`drover pick-cursor-chat: unknown argument: ${a}`);
            return 2;
        }
    }

    // The CHECK survives the port; the jq programs do not. Its exit is 1 here
    // and not 127, which is the shell's own choice and is kept.
    if (!io.which('jq')) {
        io.err('drover pick-cursor-chat: jq not found.');
        return 1;
    }

    if (!io.isDirectory(chats)) {
        io.err(`drover pick-cursor-chat: no Cursor chats at ${chats}`);
        return 1;
    }

    let rows: ChatRow[] = [];
    for (const meta of io.listMetas(chats)) {
        const text = io.readFile(meta);
        if (text === null) continue;
        const row = readChatMeta(basename(dirname(meta)), text);
        if (row) rows.push(row);
    }

    if (scope === 'cwd') rows = rows.filter((r) => r.cwd === cwd);

    // Newest first, THEN capped, so the cap keeps the newest and not whatever
    // the directory happened to list first.
    rows.sort((a, b) => b.at - a.at);
    rows = rows.slice(0, limit);
    const n = rows.length;

    if (n === 0) {
        if (scope === 'cwd') {
            io.err(`drover: no Cursor chat with messages in ${cwd}`);
            io.err('        try --all to see every directory');
        } else {
            io.err('drover: no Cursor chat has messages yet');
        }
        return 1;
    }

    const labelled = labelRows(rows, io.now(), io.home, scope);

    if (mode === 'list') {
        for (const r of labelled) io.out(r.label);
        return 0;
    }

    if (mode === 'latest') {
        io.out(labelled[0].value);
        return 0;
    }

    // gum when a human is at a terminal and gum is installed, the numbered list
    // otherwise. stdin AND stderr have to be terminals: the caller captures
    // stdout with $(...), so stdout is never one here, and gum draws on stderr.
    const picker = io.env.DROVER_PICKER || (io.isTty() && io.which('gum') ? 'gum' : 'plain');

    const homeCwd = tildify(cwd, io.home);
    const header = scope === 'cwd' ? `resume which Cursor chat?  ${homeCwd}` : 'resume which Cursor chat?';

    let picked = '';
    if (picker === 'gum') {
        picked = io.gumChoose(header, n <= 15 ? n : 15, labelled) ?? '';
    } else {
        io.err(header);
        labelled.forEach((r, i) => io.err(`  ${String(i + 1).padStart(2, ' ')}) ${r.label}`));
        io.errRaw(`number [1-${n}], or q: `);
        const ans = io.readLine();
        io.err('');
        if (ans !== null && ans !== '' && !/[^0-9]/.test(ans)) {
            const k = Number(ans);
            if (k >= 1 && k <= n) picked = labelled[k - 1].value;
        }
    }

    if (picked === '') {
        io.err('drover: no Cursor chat picked');
        return 1;
    }
    io.out(picked);
    return 0;
}
