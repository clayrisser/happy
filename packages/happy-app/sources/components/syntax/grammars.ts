/**
 * Prism grammars, loaded once, with no DOM (DROVE-159).
 *
 * `prismjs/components/prism-core` is the bare tokenizer. The package's default
 * entry is the browser bundle, which drags in the auto-highlight and
 * file-highlight plugins; those are guarded against a missing `document`, but
 * there is no reason to ship them to a phone. Core plus the grammars we
 * actually render is the whole dependency.
 *
 * Prism is already in the tree (CodeEditor.web.tsx uses it), so this adds a
 * platform, not a package.
 */
// Must come first: it sets the flags Prism reads while its own body runs.
import './prismSetup';
import Prism from 'prismjs/components/prism-core';

// Order matters: a grammar that extends another has to come after it.
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-clike';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-toml';
import 'prismjs/components/prism-ini';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-ruby';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-swift';
import 'prismjs/components/prism-kotlin';
import 'prismjs/components/prism-docker';
import 'prismjs/components/prism-hcl';
import 'prismjs/components/prism-graphql';
import 'prismjs/components/prism-markdown';

/**
 * What a fence label, a file extension or an interpreter name resolves to.
 * Anything absent resolves to null, and null renders plain.
 */
const aliases: Record<string, string> = {
    bash: 'bash',
    sh: 'bash',
    shell: 'bash',
    zsh: 'bash',
    ksh: 'bash',
    console: 'bash',
    'shell-session': 'bash',

    python: 'python',
    py: 'python',
    python3: 'python',

    javascript: 'javascript',
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    node: 'javascript',

    typescript: 'typescript',
    ts: 'typescript',
    jsx: 'jsx',
    tsx: 'tsx',

    json: 'json',
    json5: 'json',
    jsonc: 'json',

    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    ini: 'ini',
    cfg: 'ini',
    conf: 'ini',

    html: 'markup',
    xml: 'markup',
    svg: 'markup',
    markup: 'markup',
    css: 'css',

    go: 'go',
    golang: 'go',
    rust: 'rust',
    rs: 'rust',
    ruby: 'ruby',
    rb: 'ruby',
    java: 'java',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    'c++': 'cpp',
    cc: 'cpp',
    hpp: 'cpp',
    sql: 'sql',
    psql: 'sql',
    swift: 'swift',
    kotlin: 'kotlin',
    kt: 'kotlin',
    dockerfile: 'docker',
    docker: 'docker',
    hcl: 'hcl',
    terraform: 'hcl',
    tf: 'hcl',
    graphql: 'graphql',
    gql: 'graphql',
    markdown: 'markdown',
    md: 'markdown',
};

/**
 * The canonical grammar id for a label, or null when we have no grammar for it.
 * A label we cannot place is not a guess: it renders plain.
 */
export function resolveLanguage(label: string | null | undefined): string | null {
    if (!label) return null;
    const key = label.trim().toLowerCase();
    if (!key) return null;
    const id = aliases[key];
    if (!id) return null;
    return Prism.languages[id] ? id : null;
}

export function grammarFor(id: string | null): Prism.Grammar | null {
    if (!id) return null;
    return (Prism.languages[id] as Prism.Grammar | undefined) ?? null;
}

export { Prism };
