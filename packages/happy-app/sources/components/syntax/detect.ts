/**
 * Guessing a language from the text itself (DROVE-159).
 *
 * Most of what the transcript shows carries no label: a Bash tool call is a
 * command, a fence is often bare, a heredoc body is whatever the delimiter felt
 * like. Detection is scored rather than first-match, and it refuses to answer
 * unless one language wins clearly, because the wrong grammar is worse than
 * none: a paragraph of English tokenised as bash paints half the words.
 *
 * The refusal is the important half of this file. `null` means "render exactly
 * as before", which is the acceptance criterion.
 */
import { resolveLanguage } from './grammars';

/** A win needs this much evidence, and this much daylight over the runner-up. */
const minScore = 4;
const minMargin = 2;

/** Sniffing a novel is pointless and slow; the head is representative. */
const sniffLimit = 4000;

interface Rule {
    lang: string;
    re: RegExp;
    points: number;
}

const rules: Rule[] = [
    // Python
    { lang: 'python', re: /^[ \t]*def\s+\w+\s*\(.*\)\s*(->.*)?:/m, points: 4 },
    { lang: 'python', re: /^[ \t]*(?:from\s+[\w.]+\s+)?import\s+[\w.]+/m, points: 3 },
    { lang: 'python', re: /^[ \t]*class\s+\w+\s*(\(.*\))?\s*:/m, points: 3 },
    { lang: 'python', re: /^[ \t]*(if|for|while|with|elif|else|try|except|finally)\b[^;{]*:[ \t]*$/m, points: 2 },
    { lang: 'python', re: /\b__(name|main|init)__\b/, points: 3 },
    { lang: 'python', re: /\bself\./, points: 2 },
    { lang: 'python', re: /\bprint\s*\(/, points: 1 },
    { lang: 'python', re: /\b(True|False|None)\b/, points: 1 },
    { lang: 'python', re: /^[ \t]*(?:async\s+)?def\s/m, points: 2 },

    // JavaScript
    { lang: 'javascript', re: /\b(const|let|var)\s+[\w{[$]/, points: 2 },
    { lang: 'javascript', re: /=>\s*[{(]/, points: 3 },
    { lang: 'javascript', re: /\bfunction\s*\w*\s*\(/, points: 2 },
    { lang: 'javascript', re: /\brequire\s*\(\s*['"]/, points: 3 },
    { lang: 'javascript', re: /^\s*import\s+.*\s+from\s+['"]/m, points: 3 },
    { lang: 'javascript', re: /\bconsole\.(log|error|warn)\s*\(/, points: 3 },
    { lang: 'javascript', re: /\b(module\.exports|export\s+(default|const|function))\b/, points: 3 },
    { lang: 'javascript', re: /\bnew\s+Promise\b|\bawait\s+\w/, points: 1 },

    // TypeScript sits on top of the JavaScript evidence, so its own markers
    // have to outweigh them rather than merely match.
    { lang: 'typescript', re: /\b(interface|type)\s+\w+\s*(<[^>]*>)?\s*[={]/, points: 5 },
    { lang: 'typescript', re: /:\s*(string|number|boolean|void|unknown|any)\b/, points: 4 },
    { lang: 'typescript', re: /\bas\s+(const|unknown|string|number)\b/, points: 3 },
    { lang: 'typescript', re: /\b(readonly|implements|enum|namespace)\s+\w/, points: 3 },
    { lang: 'typescript', re: /\b(Record|Partial|Promise|Array)\s*</, points: 2 },

    // Shell
    { lang: 'bash', re: /^\s*\$\s+\S/m, points: 4 },
    { lang: 'bash', re: /^\s*(cd|echo|export|git|grep|sed|awk|curl|mkdir|rm|ls|cat|cp|mv|touch|chmod|sudo|kill|ps|find|tar|ssh|scp)\s/m, points: 3 },
    { lang: 'bash', re: /^\s*(npm|pnpm|yarn|bun|npx|docker|kubectl|make|brew|apt|pip|uv|cargo|go|gradle|mvn)\s/m, points: 3 },
    { lang: 'bash', re: /\|\s*(grep|head|tail|jq|awk|sed|wc|xargs|sort|uniq|less|tee)\b/, points: 3 },
    { lang: 'bash', re: /2>&1|>\/dev\/null|&&\s|\|\|\s/, points: 2 },
    { lang: 'bash', re: /\$\{?\w+\}?|\$\(/, points: 1 },
    { lang: 'bash', re: /\s--?[a-zA-Z][\w-]*(\s|=|$)/, points: 1 },
    { lang: 'bash', re: /<<-?\s*['"]?\w+/, points: 2 },

    // SQL
    { lang: 'sql', re: /\bSELECT\b[\s\S]{0,400}\bFROM\b/i, points: 5 },
    { lang: 'sql', re: /\b(INSERT\s+INTO|CREATE\s+(TABLE|INDEX|VIEW)|ALTER\s+TABLE|DELETE\s+FROM)\b/i, points: 5 },
    { lang: 'sql', re: /\b(INNER|LEFT|RIGHT)\s+JOIN\b|\bGROUP\s+BY\b|\bORDER\s+BY\b/i, points: 2 },

    // Markup
    { lang: 'markup', re: /^\s*<(\?xml|!DOCTYPE|html|head|body|svg|div|span|section)\b/im, points: 5 },
    { lang: 'markup', re: /<\/[a-zA-Z][\w-]*>/, points: 2 },

    // CSS
    { lang: 'css', re: /^[.#]?[\w-]+(\s*[,>+~]\s*[.#]?[\w-]+)*\s*\{[^}]*:[^}]*(;|\})/m, points: 4 },
    { lang: 'css', re: /@(media|import|keyframes|supports)\b/, points: 2 },

    // YAML
    { lang: 'yaml', re: /^---\s*$/m, points: 3 },
    { lang: 'yaml', re: /^[ \t]*[\w.-]+:\s*(\S|$)/m, points: 2 },
    { lang: 'yaml', re: /^[ \t]*-\s+[\w.-]+:\s/m, points: 3 },

    // Go
    { lang: 'go', re: /^package\s+\w+\s*$/m, points: 5 },
    { lang: 'go', re: /\bfunc\s+(\(\w+\s+\*?\w+\)\s*)?\w+\s*\(/, points: 3 },
    { lang: 'go', re: /:=|\bnil\b/, points: 1 },

    // Rust
    { lang: 'rust', re: /\bfn\s+\w+\s*(<[^>]*>)?\s*\(/, points: 4 },
    { lang: 'rust', re: /\blet\s+mut\s+\w/, points: 4 },
    { lang: 'rust', re: /\b(impl|pub\s+fn|use\s+std::|-> Result<)/, points: 3 },

    // Ruby
    { lang: 'ruby', re: /^\s*(def|class|module)\s+\w+[\s\S]{0,400}^\s*end\s*$/m, points: 4 },
    { lang: 'ruby', re: /\b(puts|require_relative|attr_accessor)\b|\bdo\s*\|/, points: 3 },
];

/**
 * `json` is not scored: it is either parseable or it is not, and a parse is
 * both cheaper and exact. Same for JSON Lines, which is what most CLIs emit.
 */
function looksLikeJson(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.length < 2) return false;
    const head = trimmed[0];
    if (head !== '{' && head !== '[') return false;
    if (trimmed.length > 200_000) return false;
    try {
        JSON.parse(trimmed);
        return true;
    } catch {
        return false;
    }
}

const shebangs: Array<[RegExp, string]> = [
    [/^#!.*\bpython[\d.]*\b/, 'python'],
    [/^#!.*\b(node|bun|deno)\b/, 'javascript'],
    [/^#!.*\b(bash|sh|zsh|ksh|dash)\b/, 'bash'],
    [/^#!.*\bruby\b/, 'ruby'],
];

/**
 * A diff belongs to the diff view, which owns its own red and green. Detecting
 * one here would put those hues inside a code block, which is the collision the
 * ticket asks us to avoid, so we detect it in order to decline it.
 */
const diffMarker = /^(diff --git |@@ -\d|[+-]{3} [ab/])/m;

/** The language of a block, or null when nothing wins clearly enough. */
export function detectLanguage(code: string): string | null {
    if (!code) return null;
    const sample = code.length > sniffLimit ? code.slice(0, sniffLimit) : code;

    for (const [re, lang] of shebangs) {
        if (re.test(sample)) return lang;
    }
    if (diffMarker.test(sample)) return null;
    if (looksLikeJson(code)) return 'json';

    const scores = new Map<string, number>();
    for (const rule of rules) {
        if (rule.re.test(sample)) {
            scores.set(rule.lang, (scores.get(rule.lang) ?? 0) + rule.points);
        }
    }
    // TypeScript is JavaScript plus annotations, so a TS win should not be
    // beaten by the JS evidence it necessarily also matched.
    const ts = scores.get('typescript') ?? 0;
    if (ts >= minScore) scores.set('javascript', 0);

    let best: string | null = null;
    let bestScore = 0;
    let runnerUp = 0;
    for (const [lang, score] of scores) {
        if (score > bestScore) {
            runnerUp = bestScore;
            bestScore = score;
            best = lang;
        } else if (score > runnerUp) {
            runnerUp = score;
        }
    }

    if (!best || bestScore < minScore || bestScore - runnerUp < minMargin) return null;
    return resolveLanguage(best);
}

/**
 * Terminal output is not code and must never be guessed at: a stack trace, a
 * test report or a paragraph of English all match a shell rule or two. The one
 * shape worth colouring is a JSON payload, because it is exact and because a
 * `curl | jq` wall is the reason this ticket exists.
 */
export function detectOutputLanguage(text: string): string | null {
    if (!text) return null;
    return looksLikeJson(text) ? 'json' : null;
}
