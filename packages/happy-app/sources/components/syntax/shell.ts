/**
 * Cutting a shell command into the languages it actually contains (DROVE-159).
 *
 * The block Clay photographed is a shell call whose body is Python, fed in on a
 * heredoc. Tokenising the whole thing as bash is the naive answer and it is
 * worse than leaving it alone: bash's grammar paints `import`, `def` and `:` as
 * plain text and paints the Python string quotes as shell quoting, so the wall
 * stays a wall and now it lies. So the command is segmented first, and each
 * segment gets its own grammar.
 *
 * Two shapes carry another language:
 *   python3 - <<'PY' ... PY        a heredoc body
 *   python3 -c 'import os; ...'    an inline script argument
 *
 * A segment we cannot place comes back with `lang: null` and renders plain.
 */
import { detectLanguage } from './detect';
import { resolveLanguage } from './grammars';

export interface ShellSegment {
    text: string;
    lang: string | null;
}

/** `<<EOF`, `<<'EOF'`, `<<-EOF`, `<<~EOF`. Never `<<<`, which is a herestring. */
const heredocOpener = /<<(?!<)([-~]?)[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([A-Za-z_][A-Za-z0-9_]*))/g;

/** What reads the heredoc. Only interpreters we have a grammar for. */
const interpreters: Record<string, string> = {
    python: 'python',
    python2: 'python',
    python3: 'python',
    py: 'python',
    ipython: 'python',
    node: 'javascript',
    nodejs: 'javascript',
    bun: 'javascript',
    deno: 'javascript',
    'ts-node': 'typescript',
    tsx: 'typescript',
    ruby: 'ruby',
    irb: 'ruby',
    psql: 'sql',
    mysql: 'sql',
    sqlite: 'sql',
    sqlite3: 'sql',
    duckdb: 'sql',
    bash: 'bash',
    sh: 'bash',
    zsh: 'bash',
    ksh: 'bash',
    dash: 'bash',
};

/** `cat > thing.py <<EOF` names the language in the redirect instead. */
const extensions: Record<string, string> = {
    py: 'python',
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    ts: 'typescript',
    tsx: 'tsx',
    jsx: 'jsx',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    ini: 'ini',
    cfg: 'ini',
    conf: 'ini',
    sql: 'sql',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    html: 'markup',
    xml: 'markup',
    svg: 'markup',
    css: 'css',
    go: 'go',
    rs: 'rust',
    rb: 'ruby',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    swift: 'swift',
    kt: 'kotlin',
    tf: 'hcl',
    graphql: 'graphql',
};

/** `<<'PYEOF'` says Python out loud. Suffix noise is stripped first. */
const delimiterHints: Record<string, string> = {
    PY: 'python',
    PYTHON: 'python',
    PYSCRIPT: 'python',
    PYCODE: 'python',
    JS: 'javascript',
    NODE: 'javascript',
    JAVASCRIPT: 'javascript',
    TS: 'typescript',
    TYPESCRIPT: 'typescript',
    SQL: 'sql',
    JSON: 'json',
    YAML: 'yaml',
    YML: 'yaml',
    RB: 'ruby',
    RUBY: 'ruby',
    SH: 'bash',
    BASH: 'bash',
    SHELL: 'bash',
    HTML: 'markup',
    XML: 'markup',
    CSS: 'css',
    GO: 'go',
    RS: 'rust',
    RUST: 'rust',
    TOML: 'toml',
    INI: 'ini',
    CONF: 'ini',
};

/** An interpreter reading a script argument rather than a heredoc. */
const inlineScript =
    /\b(python[\d.]*|node|bun|deno|ruby|ts-node|tsx)\b((?:\s+-{1,2}[\w-]+)*)\s+-(?:c|e)\s+(?:'([^']*)'|"([^"]*)")/g;

function basename(word: string): string {
    const cut = word.lastIndexOf('/');
    return cut === -1 ? word : word.slice(cut + 1);
}

/** `python3.11` and `python3` are both python. */
function normaliseInterpreter(word: string): string {
    return basename(word).toLowerCase().replace(/[\d.]+$/, '') || basename(word).toLowerCase();
}

function interpreterLanguage(prefix: string): string | null {
    const words = prefix.split(/[\s|;&()]+/).filter(Boolean);
    // Last wins: `sudo python3` and `env python3` both mean python.
    for (let i = words.length - 1; i >= 0; i--) {
        const raw = basename(words[i]).toLowerCase();
        const direct = interpreters[raw];
        if (direct) return direct;
        const stripped = normaliseInterpreter(words[i]);
        if (interpreters[stripped]) return interpreters[stripped];
    }
    return null;
}

function redirectLanguage(prefix: string): string | null {
    const targets = prefix.match(/(?:>>?|\btee\b(?:\s+-a)?)\s*["']?([^\s"'|>&;]+)/g);
    if (!targets) return null;
    for (let i = targets.length - 1; i >= 0; i--) {
        const dot = targets[i].lastIndexOf('.');
        if (dot === -1) continue;
        const ext = targets[i].slice(dot + 1).toLowerCase();
        if (extensions[ext]) return extensions[ext];
    }
    return null;
}

function delimiterLanguage(delimiter: string): string | null {
    let name = delimiter.toUpperCase();
    // PYEOF, PY_EOF, PYTHON-EOT all mean the same thing as PY.
    for (let i = 0; i < 4; i++) {
        const next = name.replace(/(?:EOF|EOT|END|DOC|HEREDOC|[_\-.])$/, '');
        if (next === name) break;
        name = next;
    }
    return delimiterHints[name] ?? null;
}

/**
 * A structured manifest beats a sniff: `kubectl apply -f -` is always YAML,
 * whatever the delimiter says.
 */
function stdinFormat(prefix: string): string | null {
    if (/\b(kubectl|oc)\b[\s\S]*\s-f\s+-(?:\s|$)/.test(prefix)) return 'yaml';
    if (/\bdocker(?:\s+compose)?\b[\s\S]*\s-f\s+-(?:\s|$)/.test(prefix)) return 'yaml';
    return null;
}

function heredocLanguage(prefix: string, delimiter: string, body: string): string | null {
    const guess =
        stdinFormat(prefix) ??
        interpreterLanguage(prefix) ??
        redirectLanguage(prefix) ??
        delimiterLanguage(delimiter) ??
        detectLanguage(body);
    return resolveLanguage(guess);
}

/** Lines with their terminators kept, so joining the pieces rebuilds the input. */
function splitLines(text: string): string[] {
    const out: string[] = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') {
            out.push(text.slice(start, i + 1));
            start = i + 1;
        }
    }
    if (start < text.length) out.push(text.slice(start));
    return out;
}

interface Opener {
    delimiter: string;
    /** `<<-` lets the terminator be indented with tabs. */
    indented: boolean;
    prefix: string;
}

/**
 * Split one bash segment further where an interpreter is handed a script as an
 * argument. Runs after the heredoc walk so the walk stays a line machine.
 */
function splitInlineScripts(text: string): ShellSegment[] {
    inlineScript.lastIndex = 0;
    let match: RegExpExecArray | null;
    let cursor = 0;
    const out: ShellSegment[] = [];
    while ((match = inlineScript.exec(text)) !== null) {
        const body = match[3] ?? match[4] ?? '';
        const lang = resolveLanguage(interpreters[normaliseInterpreter(match[1])] ?? null);
        if (!body.trim() || !lang) continue;
        const bodyStart = match.index + match[0].length - body.length - 1;
        if (bodyStart < cursor) continue;
        if (bodyStart > cursor) out.push({ text: text.slice(cursor, bodyStart), lang: 'bash' });
        out.push({ text: body, lang });
        cursor = bodyStart + body.length;
    }
    if (out.length === 0) return [{ text, lang: 'bash' }];
    if (cursor < text.length) out.push({ text: text.slice(cursor), lang: 'bash' });
    return out;
}

/**
 * A shell command as an ordered run of segments. Concatenating `text` returns
 * the input unchanged, which is what keeps the rendered block byte-for-byte
 * what the agent ran.
 */
export function segmentShell(command: string): ShellSegment[] {
    if (!command) return [];

    const lines = splitLines(command);
    const segments: ShellSegment[] = [];
    const pending: Opener[] = [];

    let shellBuffer = '';
    let bodyBuffer = '';
    let current: Opener | null = null;

    const flushShell = () => {
        if (!shellBuffer) return;
        segments.push(...splitInlineScripts(shellBuffer));
        shellBuffer = '';
    };
    const flushBody = (opener: Opener) => {
        if (!bodyBuffer) return;
        const lang = heredocLanguage(opener.prefix, opener.delimiter, bodyBuffer);
        segments.push({ text: bodyBuffer, lang });
        bodyBuffer = '';
    };

    for (const line of lines) {
        if (current) {
            const bare = line.replace(/\n$/, '');
            const candidate = current.indented ? bare.replace(/^[\t ]+/, '') : bare;
            if (candidate === current.delimiter) {
                flushBody(current);
                shellBuffer += line;
                // Two heredocs opened on one line run back to back: the first
                // terminator is immediately followed by the second body, so
                // the terminator has to be emitted before we switch, or it
                // comes out after the text that follows it.
                const next = pending.shift() ?? null;
                if (next) flushShell();
                current = next;
            } else {
                bodyBuffer += line;
            }
            continue;
        }

        shellBuffer += line;
        heredocOpener.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = heredocOpener.exec(line)) !== null) {
            const delimiter = match[2] ?? match[3] ?? match[4];
            if (!delimiter) continue;
            pending.push({
                delimiter,
                indented: match[1] === '-' || match[1] === '~',
                prefix: line.slice(0, match.index),
            });
        }
        if (pending.length > 0) {
            flushShell();
            current = pending.shift() ?? null;
        }
    }

    // A truncated command can end mid-heredoc. The body still gets its grammar.
    if (current) flushBody(current);
    flushShell();

    return segments.filter((segment) => segment.text.length > 0);
}
