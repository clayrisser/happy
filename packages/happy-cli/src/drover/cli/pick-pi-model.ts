/**
 * `drover-pick-pi-model` — the models pi ACTUALLY reports, picked by lookup
 * (DROVE-253), in node (DROVE-315).
 *
 * A straight port of cattle-drover/libexec/drover-pick-pi-model: the same
 * options, the same exit codes, the same sentences. DROVE-253 settled the rule
 * and this file is it applied one harness over — Cursor's own --help documented
 * a bracket syntax for effort that the CLI rejected outright, so a picker that
 * let a human type a model produced turns that failed at exec with a message
 * about neither the model nor the syntax. A model string is only real if the
 * CLI itself lists it, so every pick is resolved against `pi --list-models` and
 * a miss is refused HERE, where the message can name the alternatives.
 *
 * Same contract as the other pickers: the picked id on stdout and NOTHING
 * else, the list on stderr, exit 1 when there is nothing to pick or nothing was
 * picked, exit 2 on an unknown option or an ambiguous --resolve, 127 when the
 * binary is missing.
 *
 * LOCAL FIRST. pi knows about a great many models it has no key for — this
 * machine's auth.json is empty — and the ones that can actually answer are the
 * ones a local runtime is serving. An unreachable model is a session that fails
 * on its first turn, so `--local` is not a filter for tidiness.
 *
 * Where the shell ran awk, cut, grep and jq this parses in node. The jq check
 * for --default is KEPT as a check, because its 127 is part of the contract,
 * but the settings file is read with JSON.parse rather than by shelling out.
 *
 * Help answers before anything else — no env read, no binary lookup, no
 * subprocess — the way the shell answered it above `set -e`.
 */

import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

const HELP = `drover-pick-pi-model — pick a model pi actually reports.

USAGE
  drover-pick-pi-model                    pick one interactively
  drover-pick-pi-model --list             print them, one per line
  drover-pick-pi-model --local            only locally-served providers
  drover-pick-pi-model --resolve <what>   echo it back if pi knows it, else fail
  drover-pick-pi-model --default          the model pi would use with no flag

  --resolve takes \`provider/id\`, a bare id, or a unique substring, and answers
  with the full \`provider/id\`. Ambiguous or unknown is an error, never a guess.

ENV
  DROVER_PI_BIN         default: pi
  DROVER_PI_LOCAL       comma list of providers counted as local
                        (default: lmstudio,glm,ollama,llamacpp,lmstudio-local)
`;

export type Env = Record<string, string | undefined>;

/** One row of `pi --list-models`: `provider/id`, and whether a local runtime serves it. */
export interface ModelRow {
    ref: string;
    local: boolean;
}

/**
 * Everything the picker needs that is not argv. Injected so a test drives every
 * branch without a pi on PATH, a terminal, a gum, or Clay's real ~/.pi.
 */
export interface ModelIo {
    env: Env;
    home: string;
    out: (line: string) => void;
    err: (line: string) => void;
    /** `command -v <name>` — the resolved path, or null. */
    which: (name: string) => string | null;
    /** `[ -x <path> ]`. */
    isExecutable: (path: string) => boolean;
    /** The file's contents, or null when it is not readable — the shell's `[ -r ]`. */
    readFile: (path: string) => string | null;
    /** `<bin> --list-models 2>/dev/null`; '' on any failure, the shell's `|| true`. */
    listModels: (bin: string) => string;
    /** stdin AND stderr are terminals — gum draws on stderr, stdout is captured. */
    isTty: () => boolean;
    /** gum choose over labelled rows; null when nothing was picked. */
    gumChoose: (header: string, rows: readonly { label: string; value: string }[]) => string | null;
    /** One line off stdin, or null at end of input — the shell's `read -r ans || true`. */
    readLine: () => string | null;
}

/** The install locations a launchd daemon's PATH cannot see. */
function fallbacks(home: string): string[] {
    return [join(home, '.local', 'bin', 'pi'), '/opt/homebrew/bin/pi', '/usr/local/bin/pi'];
}

function whichOnPath(name: string, env: Env): string | null {
    for (const dir of (env.PATH ?? '').split(delimiter)) {
        if (!dir) continue;
        const candidate = join(dir, name);
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

/** One line off fd 0, byte at a time, so a terminal is not drained to EOF. */
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

export function defaultModelIo(): ModelIo {
    return {
        env: process.env,
        home: homedir(),
        out: (line) => process.stdout.write(`${line}\n`),
        err: (line) => process.stderr.write(`${line}\n`),
        which: (name) => whichOnPath(name, process.env),
        isExecutable: (path) => {
            try {
                accessSync(path, constants.X_OK);
                return true;
            } catch {
                return false;
            }
        },
        readFile: (path) => {
            try {
                return readFileSync(path, 'utf8');
            } catch {
                return null;
            }
        },
        listModels: (bin) => {
            const r = spawnSync(bin, ['--list-models'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            if (r.error) return '';
            return r.stdout ?? '';
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
 * The awk pass over `pi --list-models`. Column 1 is the provider, column 2 the
 * id. The header row spells its first column "provider", which is not one, so
 * it is dropped BY NAME rather than by position — a table that grows a title
 * line above it would break a `tail -n +2` and not this.
 */
export function parseModels(text: string, locals: string): ModelRow[] {
    const localSet = locals.split(',');
    const rows: ModelRow[] = [];
    for (const raw of text.split('\n')) {
        const f = raw.trim().split(/\s+/).filter((w) => w !== '');
        if (f[0] === 'provider') continue;
        if (f.length < 2) continue;
        rows.push({ ref: `${f[0]}/${f[1]}`, local: localSet.includes(f[0]) });
    }
    return rows;
}

/** What a resolve answers with: a value on stdout, or lines on stderr and a code. */
export interface Resolution {
    code: number;
    value: string;
    errors: string[];
}

/**
 * `--resolve`. Exact first, so `lmstudio/openai/gpt-oss-120b` never loses to a
 * substring. Ambiguous or unknown is an error, never a guess.
 */
export function resolveModel(rows: readonly ModelRow[], want: string): Resolution {
    if (rows.some((r) => r.ref === want)) return { code: 0, value: want, errors: [] };
    const hits = rows.filter((r) => r.ref.includes(want)).map((r) => r.ref);
    if (hits.length === 1) return { code: 0, value: hits[0], errors: [] };
    if (hits.length === 0) {
        const errors = [
            `drover pi: pi does not report a model matching '${want}'.`,
            '  what it does report locally:',
            ...rows.filter((r) => r.local).map((r) => `    ${r.ref}`),
            '  everything: drover-pick-pi-model --list',
        ];
        return { code: 2, value: '', errors };
    }
    return {
        code: 2,
        value: '',
        errors: [`drover pi: '${want}' matches ${hits.length} models. Name one exactly:`, ...hits.map((h) => `    ${h}`)],
    };
}

/** Local models sort first: they are the ones that can answer on this machine. */
export function sortedRows(rows: readonly ModelRow[]): { label: string; value: string }[] {
    return [
        ...rows.filter((r) => r.local).map((r) => ({ value: r.ref, label: `${r.ref} (local)` })),
        ...rows.filter((r) => !r.local).map((r) => ({ value: r.ref, label: r.ref })),
    ];
}

export interface ModelOptions {
    io?: ModelIo;
}

export async function run(args: string[], opts: ModelOptions = {}): Promise<number> {
    // Answered above everything, the way the shell answers it above `set -e`.
    if (args[0] === '--help' || args[0] === '-h') {
        process.stdout.write(HELP);
        return 0;
    }
    const io = opts.io ?? defaultModelIo();

    let mode: 'choose' | 'list' | 'local' | 'default' | 'resolve' = 'choose';
    let want = '';
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--help' || a === '-h') {
            io.out(HELP.replace(/\n$/, ''));
            return 0;
        } else if (a === '--list') {
            mode = 'list';
        } else if (a === '--local') {
            mode = 'local';
        } else if (a === '--default') {
            mode = 'default';
        } else if (a === '--resolve') {
            mode = 'resolve';
            want = args[i + 1] ?? '';
            if (want === '') {
                io.err('drover-pick-pi-model: --resolve needs a model');
                return 2;
            }
            i++;
        } else {
            io.err(`drover-pick-pi-model: unknown option '${a}'`);
            return 2;
        }
    }

    let bin = io.env.DROVER_PI_BIN || 'pi';
    // Same rule as libexec/drover-pi: the fallback is for the default name
    // only, so a DROVER_PI_BIN that is wrong fails under its own name.
    if (bin === 'pi' && !io.which(bin)) {
        for (const c of fallbacks(io.home)) {
            if (io.isExecutable(c)) {
                bin = c;
                break;
            }
        }
    }
    if (!io.which(bin) && !io.isExecutable(bin)) {
        io.err(`drover-pick-pi-model: '${bin}' is not on PATH.`);
        return 127;
    }

    const locals = io.env.DROVER_PI_LOCAL || 'lmstudio,glm,ollama,llamacpp,lmstudio-local';
    const rows = parseModels(io.listModels(bin), locals);
    if (rows.length === 0) {
        io.err('drover-pick-pi-model: pi listed no models. Is it configured?');
        return 1;
    }

    if (mode === 'default') {
        // What pi would use unasked, from its OWN settings rather than a guess
        // here. defaultProvider and defaultModel are the two keys that decide it.
        let s = join(io.home, '.pi', 'agent', 'settings.json');
        if (io.env.PI_AGENT_DIR) s = join(io.env.PI_AGENT_DIR, 'settings.json');
        const text = io.readFile(s);
        if (text === null) {
            io.err(`drover-pick-pi-model: no pi settings at ${s}`);
            return 1;
        }
        // The jq CHECK survives the port, because its 127 is part of the
        // contract; the parsing does not, because node has JSON.
        if (!io.which('jq')) {
            io.err('drover-pick-pi-model: jq is required for --default');
            return 127;
        }
        let rec: { defaultProvider?: unknown; defaultModel?: unknown } = {};
        try {
            rec = JSON.parse(text);
        } catch {
            // jq on a malformed file prints nothing and the shell exits 0.
            return 0;
        }
        if (rec && rec.defaultProvider && rec.defaultModel) io.out(`${String(rec.defaultProvider)}/${String(rec.defaultModel)}`);
        return 0;
    }

    if (mode === 'resolve') {
        const r = resolveModel(rows, want);
        if (r.code === 0) io.out(r.value);
        else for (const line of r.errors) io.err(line);
        return r.code;
    }

    if (mode === 'local') {
        for (const r of rows) if (r.local) io.out(r.ref);
        return 0;
    }

    if (mode === 'list') {
        for (const r of rows) io.out(r.ref);
        return 0;
    }

    const sorted = sortedRows(rows);
    const picker = io.env.DROVER_PICKER || (io.isTty() && io.which('gum') ? 'gum' : 'plain');

    let picked = '';
    if (picker === 'gum') {
        picked = io.gumChoose('pi model', sorted) ?? '';
    } else {
        let i = 0;
        for (const row of sorted) {
            i++;
            io.err(`${String(i).padStart(3, ' ')}) ${row.label}`);
        }
        process.stderr.write(`pick a model [1-${i}]: `);
        const ans = io.readLine();
        if (ans !== null && ans !== '' && !/[^0-9]/.test(ans)) {
            // `sed -n "${ans}p"` — one-based, and nothing at all out of range.
            picked = sorted[Number(ans) - 1]?.value ?? '';
        }
    }

    if (picked === '') {
        io.err('drover: no pi model picked');
        return 1;
    }
    io.out(picked);
    return 0;
}
