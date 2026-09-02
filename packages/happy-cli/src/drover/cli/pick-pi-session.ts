/**
 * `drover-pick-pi-session` — pick a pi session to resume, for this project, in
 * node (DROVE-315).
 *
 * A straight port of cattle-drover/libexec/drover-pick-pi-session: the same
 * options, the same exit codes, the same lines. The contract is the one every
 * drover picker keeps — the picked id on stdout and NOTHING else, the list on
 * stderr, exit 1 when there is nothing to pick or nothing was picked, 2 on an
 * unknown option, 127 when jq is missing.
 *
 * WHAT pi RESUMES WITH, measured on 0.80.3 rather than read off the flag list.
 * All three of `--continue`, `--session <partial-uuid>` and `--session-id
 * <full-uuid>` reopen the same conversation with its messages intact. What does
 * NOT survive is being killed: pi writes its jsonl on a clean exit and NOTHING
 * at all on SIGTERM, so a session that looked resumable and is not is almost
 * always one that was killed. The id printed here is the uuid, which is what
 * `--session` takes.
 *
 * WHERE THEY LIVE. ~/.pi/agent/sessions/--<cwd with / as ->--/<iso>_<uuid>.jsonl
 * — project-nested, like Claude Code and unlike Codex. The directory name is
 * reconstructed rather than scanned for, but the cwd is VERIFIED out of each
 * file's own session header before a row is offered: the munge collapses `/`
 * and `-` into the same character, so two real projects can share a directory
 * name and a picker that trusted the name alone would offer one project's
 * conversations inside another.
 *
 * The jq program is reimplemented in node rather than shelled out to — one
 * streaming pass per file, reading only far enough to answer which project,
 * when, and what it was about. The `command -v jq` CHECK survives, because its
 * 127 is part of the contract.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

const HELP = `drover-pick-pi-session — pick a pi session to resume.

USAGE
  drover-pick-pi-session              pick one interactively
  drover-pick-pi-session --latest     print the newest id and exit
  drover-pick-pi-session --list       print the rows, one per line
  drover-pick-pi-session --all        every project, not just this one
  drover-pick-pi-session --cwd <dir>  a project other than $PWD

ENV
  PI_AGENT_DIR    default: ~/.pi/agent
  DROVER_PICKER   gum | plain
`;

export type Env = Record<string, string | undefined>;

/** One row, as the jq program's `@tsv` wrote it. */
export interface SessionRow {
    id: string;
    ts: string;
    first: string;
    cwd: string;
}

export interface SessionIo {
    env: Env;
    home: string;
    cwd: string;
    out: (line: string) => void;
    err: (line: string) => void;
    which: (name: string) => string | null;
    isDirectory: (path: string) => boolean;
    /** Every `<sessions>/*<slash>*.jsonl`, sorted the way the shell's glob is. */
    listSessionFiles: (sessions: string) => string[];
    readFile: (path: string) => string | null;
    isTty: () => boolean;
    gumChoose: (header: string, rows: readonly { label: string; value: string }[]) => string | null;
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

export function defaultSessionIo(): SessionIo {
    return {
        env: process.env,
        home: homedir(),
        cwd: process.cwd(),
        out: (line) => process.stdout.write(`${line}\n`),
        err: (line) => process.stderr.write(`${line}\n`),
        which: (name) => whichOnPath(name, process.env),
        isDirectory: (path) => {
            try {
                return readdirSync(path) !== null;
            } catch {
                return false;
            }
        },
        listSessionFiles: (sessions) => {
            const out: string[] = [];
            let dirs: string[];
            try {
                dirs = readdirSync(sessions).sort();
            } catch {
                return out;
            }
            for (const d of dirs) {
                let names: string[];
                try {
                    names = readdirSync(join(sessions, d)).sort();
                } catch {
                    continue;
                }
                for (const n of names) if (n.endsWith('.jsonl')) out.push(join(sessions, d, n));
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
        gumChoose: (header, rows) => {
            const input = rows.map((r) => `${r.label}\t${r.value}`).join('\n');
            const r = spawnSync('gum', ['choose', '--header', header, '--label-delimiter', '\t'], {
                encoding: 'utf8',
                input,
                stdio: ['pipe', 'pipe', 'inherit'],
            });
            if (r.error || r.status !== 0) return null;
            const picked = (r.stdout ?? '').trim();
            return picked === '' ? null : picked;
        },
        readLine: readStdinLine,
    };
}

/**
 * The jq reduce, one file at a time. `-n` with `inputs` streamed the jsonl
 * rather than slurping a conversation that can be megabytes; this reads the
 * file once and stops caring after the first user message.
 *
 * Null when the file names no session — jq's `select(.id != null)`.
 */
export function scanSessionFile(text: string): SessionRow | null {
    let id: string | null = null;
    let cwd: string | null = null;
    let ts: string | null = null;
    let first: string | null = null;
    for (const line of text.split('\n')) {
        if (line === '') continue;
        let e: any;
        try {
            e = JSON.parse(line);
        } catch {
            continue;
        }
        if (e && e.type === 'session') {
            id = e.id ?? null;
            cwd = e.cwd ?? null;
            ts = e.timestamp ?? null;
        } else if (e && e.type === 'message' && e.message && e.message.role === 'user' && first === null) {
            const content = e.message.content;
            const parts = Array.isArray(content)
                ? content.filter((b: any) => b && b.type === 'text').map((b: any) => String(b.text ?? ''))
                : [];
            first = parts.join(' ');
        }
    }
    if (id === null) return null;
    // `(.first // "(no prompt)") | gsub("\\s+"; " ") | .[0:70]` — codepoints,
    // not bytes, because jq's slice counts codepoints.
    const clipped = [...(first ?? '(no prompt)').replace(/\s+/g, ' ')].slice(0, 70).join('');
    return { id, ts: ts ?? '', first: clipped, cwd: cwd ?? '' };
}

/** `sort -t '\t' -k2,2r` then `head -n <limit>`: newest timestamp first. */
export function sortRows(rows: readonly SessionRow[], limit: number): SessionRow[] {
    const line = (r: SessionRow): string => [r.id, r.ts, r.first, r.cwd].join('\t');
    return [...rows]
        .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : line(a) < line(b) ? -1 : line(a) > line(b) ? 1 : 0))
        .slice(0, limit);
}

export interface SessionOptions {
    io?: SessionIo;
}

export async function run(args: string[], opts: SessionOptions = {}): Promise<number> {
    if (args[0] === '--help' || args[0] === '-h') {
        process.stdout.write(HELP);
        return 0;
    }
    const io = opts.io ?? defaultSessionIo();

    const agentDir = io.env.PI_AGENT_DIR || join(io.home, '.pi', 'agent');
    const sessions = join(agentDir, 'sessions');
    let limit = 20;
    let mode: 'choose' | 'latest' | 'list' = 'choose';
    let scope: 'cwd' | 'all' = 'cwd';
    let cwd = io.cwd;

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--help' || a === '-h') {
            io.out(HELP.replace(/\n$/, ''));
            return 0;
        } else if (a === '--latest') {
            mode = 'latest';
        } else if (a === '--list') {
            mode = 'list';
        } else if (a === '--all') {
            scope = 'all';
        } else if (a === '--cwd') {
            cwd = args[i + 1] ?? '';
            if (cwd === '') {
                io.err('drover-pick-pi-session: --cwd needs a directory');
                return 2;
            }
            i++;
        } else if (a === '--limit') {
            limit = Number(args[i + 1] ?? '');
            i++;
        } else {
            io.err(`drover-pick-pi-session: unknown option '${a}'`);
            return 2;
        }
    }

    // The CHECK survives the port; the jq program does not.
    if (!io.which('jq')) {
        io.err('drover-pick-pi-session: jq is required.');
        return 127;
    }

    if (!io.isDirectory(sessions)) {
        io.err(`drover: no pi sessions on this machine yet (${sessions})`);
        return 1;
    }

    const rows: SessionRow[] = [];
    for (const f of io.listSessionFiles(sessions)) {
        const text = io.readFile(f);
        if (text === null) continue;
        const row = scanSessionFile(text);
        if (!row) continue;
        // The cwd is verified out of the file's own header, never from the path.
        if (scope !== 'all' && row.cwd !== cwd) continue;
        rows.push(row);
    }

    if (rows.length === 0) {
        if (scope === 'all') {
            io.err('drover: no pi sessions on this machine yet.');
        } else {
            io.err(`drover: no pi sessions for ${cwd}.`);
            io.err('  every project:  drover-pick-pi-session --all');
        }
        return 1;
    }

    const sorted = sortRows(rows, limit);

    if (mode === 'latest') {
        io.out(sorted[0].id);
        return 0;
    }

    if (mode === 'list') {
        for (const r of sorted) io.out(`${r.id}  ${r.ts}  ${r.first}`);
        return 0;
    }

    const labelled = sorted.map((r) => ({ value: r.id, label: `${r.ts.slice(0, 16)}  ${r.first}` }));
    const picker = io.env.DROVER_PICKER || (io.isTty() && io.which('gum') ? 'gum' : 'plain');

    let picked = '';
    if (picker === 'gum') {
        picked = io.gumChoose('pi session', labelled) ?? '';
    } else {
        let i = 0;
        for (const row of labelled) {
            i++;
            io.err(`${String(i).padStart(3, ' ')}) ${row.label}`);
        }
        process.stderr.write(`pick a session [1-${i}]: `);
        const ans = io.readLine();
        if (ans !== null && ans !== '' && !/[^0-9]/.test(ans)) {
            picked = labelled[Number(ans) - 1]?.value ?? '';
        }
    }

    if (picked === '') {
        io.err('drover: no pi session picked');
        return 1;
    }
    io.out(picked);
    return 0;
}
