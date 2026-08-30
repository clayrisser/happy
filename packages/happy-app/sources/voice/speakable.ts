import type { Message } from '@/sync/typesMessage';

/**
 * Turning what a session emits into what is worth HEARING (DROVE-30).
 *
 * The filter is the product here, not the synthesiser. A coding session emits
 * mostly tool calls, diffs, file listings and stack traces, and reading those
 * aloud is unbearable, so only assistant prose ever reaches the speaker and
 * the code comes out of the prose too.
 *
 * On chunking: there is no token-level stream to ride. The CLI tails the
 * Claude Code JSONL transcript (happy-cli src/claude/utils/sessionScanner.ts)
 * and forwards each COMPLETE line, so the smallest unit that ever arrives is
 * one finished assistant text block. "As it streams" therefore means the block
 * is spoken the moment it lands, split into sentences so speech starts on the
 * first one and can be cut mid-block.
 */

/** Force-cut a run with no punctuation at all, so prose still starts speaking. */
const maxUtteranceLength = 220;

/**
 * Abbreviations whose full stop is not the end of a sentence. Matched against
 * the text up to and including the dot, so `e.g.` matches on its second dot.
 */
const abbreviationPattern =
    /(?:^|[\s("'[])(?:e\.g|i\.e|etc|vs|al|cf|approx|fig|figs|no|nos|vol|est|dept|inc|ltd|co|corp|mr|mrs|ms|dr|prof|sr|jr|st|resp|ca|pp|ed|eds|min|max|sec|ref|repo|env)\.$/i;

/** A lone initial — `J. Smith`, `A. B. Turing` — is not a sentence end either. */
const initialPattern = /(?:^|\s)[A-Z]\.$/;

function isFenceLine(line: string): boolean {
    return /^\s*(?:```|~~~)/.test(line);
}

function isTableLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) return false;
    // A single leading pipe is enough: markdown tables always open with one,
    // and prose almost never does.
    return true;
}

function isHorizontalRule(line: string): boolean {
    return /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
}

/**
 * A 4-space (or tab) indent is a code block UNLESS the dedented line is itself
 * a list item or a quote — nested bullets are indented exactly the same way and
 * are ordinary prose.
 */
function isIndentedCode(line: string): boolean {
    if (!/^(?: {4,}|\t)/.test(line)) return false;
    const dedented = line.replace(/^(?: {4,}|\t+)/, '');
    if (/^[-*+]\s/.test(dedented)) return false;
    if (/^\d+[.)]\s/.test(dedented)) return false;
    if (/^>/.test(dedented)) return false;
    return true;
}

/**
 * Whether an inline-code span is worth saying.
 *
 * The design said drop every one of them. Measuring 4000 real assistant blocks
 * said otherwise: most inline code is a short identifier sitting inside a
 * sentence — "11 in `SessionView`, 2 in `AgentInput`" — and dropping it leaves
 * "11 in, 2 in", which is worse to listen to than the filename. So a short,
 * word-shaped span is spoken and everything else — commands, hashes, anything
 * with shell punctuation in it — still goes.
 */
function isSayableCode(code: string): boolean {
    const trimmed = code.trim();
    if (trimmed.length === 0 || trimmed.length > 24) return false;
    // One or two words shaped like an identifier, a path, a flag or a short
    // command. Anything with a brace, bracket, colon or quote in it is CSS, a
    // type parameter or a shell line, and those measured badly out loud.
    return /^[-.@/]{0,2}[A-Za-z0-9][\w./@#+-]*(?: [\w./@#+-]+)?$/.test(trimmed);
}

function stripInline(text: string): string {
    return text
        // Images carry nothing sayable.
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        // Links keep the label and lose the href.
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
        // Inline code: kept when it is a short identifier, dropped when it is a
        // command or a blob. See isSayableCode.
        .replace(/``([^`]*)``/g, (_m, code: string) => (isSayableCode(code) ? code : ' '))
        .replace(/`([^`]*)`/g, (_m, code: string) => (isSayableCode(code) ? code : ' '))
        // Bare URLs, once the link labels above are already safe. The tail is
        // \S* rather than \S+ because inline-code removal above can leave a
        // naked `https://` behind, which read out loud as "h t t p s colon".
        .replace(/\b(?:https?|ftp):\/\/\S*/gi, ' ')
        .replace(/\bwww\.\S*/gi, ' ')
        .replace(/<[^>\s]+@[^>\s]+>/g, ' ')
        // Raw HTML the markdown renderer would have swallowed.
        .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
        // A pipe in prose is a table cell or an alternation, never a word. It
        // survives the line-level table check when the row is the tail of a
        // longer line, so it is flattened to a pause here.
        .replace(/\s*\|+\s*/g, ', ')
        // A slash left standing alone is the gap where inline code used to be.
        .replace(/\s+\/+(?=\s)/g, ' ')
        // Emphasis markers are punctuation to the eye and gibberish to the ear.
        .replace(/~~([^~]+)~~/g, '$1')
        .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*\n]+)\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,!?;:])/g, '$1$2')
        // Backslash escapes, now that nothing downstream reads them.
        .replace(/\\([\\`*_{}[\]()#+\-.!>])/g, '$1')
        .replace(/[ \t]+/g, ' ')
        .trim();
}

/**
 * Clean up after the removals above.
 *
 * Measured on 4000 real assistant blocks from ~/.claude-shared/projects:
 * dropping inline code leaves holes that read terribly out loud — "laptop
 * client ( , amber)", "Service ( ): if -> =", "vars.yaml supplies the values,
 * every {{ }} marker fills in". The words are fine; the punctuation the code
 * used to sit inside is not.
 */
function tidyPunctuation(text: string): string {
    let out = text;
    for (let pass = 0; pass < 3; pass++) {
        const before = out;
        out = out
            // Brackets whose whole contents were code.
            .replace(/\(\s*[,;:·|/=+\-—–]*\s*\)/g, ' ')
            .replace(/\[\s*[,;:·|/=+\-—–]*\s*\]/g, ' ')
            .replace(/\{\s*[,;:·|/=+\-—–]*\s*\}/g, ' ')
            // A dash introducing nothing: "via vars/tags: —." after the code
            // it pointed at was dropped.
            .replace(/[:;,]?\s*[—–]\s*(?=[.!?]|$)/g, '')
            // A bracket that lost its opening half, or kept a stray separator.
            .replace(/\(\s*,\s*/g, '(')
            .replace(/\s*,\s*\)/g, ')')
            // Separators with nothing left between them.
            .replace(/([,;:])\s*(?=[,;:])/g, '')
            // A bracket left gaping where its contents were dropped, inside a
            // group whose other half is still meaningful: "2 in )".
            .replace(/\(\s+/g, '(')
            .replace(/\s+\)/g, ')')
            // Only when the punctuation really is trailing. Without the
            // lookahead this ate the space in front of a kept identifier that
            // starts with a dot, turning "the .env file" into "the.env file".
            .replace(/\s+([,;:.!?])(?=\s|$)/g, '$1')
            .replace(/\s{2,}/g, ' ');
        if (out === before) break;
    }
    return out.trim();
}

/**
 * A line that is only leftover punctuation says nothing. Two letters is the
 * floor because "ok" and "no" are real answers.
 */
function hasWords(text: string): boolean {
    return /[A-Za-z]{2,}/.test(text);
}

/**
 * Reduce a markdown assistant reply to the prose a person would want read out.
 * Fenced and indented code, tables, rules, inline code and URLs are dropped;
 * headings, list markers and quote markers lose their punctuation and keep
 * their words.
 */
export function stripToSpeakableProse(markdown: string): string {
    const out: string[] = [];
    let fenced = false;

    for (const rawLine of markdown.split('\n')) {
        if (isFenceLine(rawLine)) {
            fenced = !fenced;
            continue;
        }
        if (fenced) continue;
        if (isTableLine(rawLine)) continue;
        if (isHorizontalRule(rawLine)) continue;
        if (isIndentedCode(rawLine)) continue;

        let line = rawLine;
        line = line.replace(/^\s*#{1,6}\s+/, '');
        line = line.replace(/^\s*(?:>\s?)+/, '');
        line = line.replace(/^\s*[-*+]\s+/, '');
        line = line.replace(/^\s*\d+[.)]\s+/, '');
        line = line.replace(/^\s*\[[ xX]\]\s+/, '');

        const cleaned = tidyPunctuation(stripInline(line));
        // The table check above runs on the raw line, but stripping inline code
        // can UNCOVER a pipe-delimited row — `a` | `b` | delete the div becomes
        // "| | delete the div". Measured on real transcripts, not imagined.
        if (isTableLine(cleaned)) continue;
        if (!hasWords(cleaned)) continue;
        out.push(cleaned.replace(/^\|+\s*/, ''));
    }

    return out.join('\n');
}

/**
 * True when a terminator at `index` really ends a sentence, rather than sitting
 * inside a version number, a filename, an ellipsis or an abbreviation.
 */
function isSentenceBoundary(text: string, index: number): boolean {
    const char = text[index];
    if (char === '!' || char === '?') return true;

    // Ellipsis: consume the whole run, and never break inside one.
    if (text[index + 1] === '.') return false;
    if (text[index - 1] === '.') return false;

    // 1.2.3, 0.5 — a digit either side.
    if (/\d/.test(text[index - 1] ?? '') && /\d/.test(text[index + 1] ?? '')) return false;

    // .ts, .json, foo.bar — a letter immediately after, with no space.
    if (/[A-Za-z]/.test(text[index + 1] ?? '')) return false;

    const upToDot = text.slice(0, index + 1);
    if (abbreviationPattern.test(upToDot)) return false;
    if (initialPattern.test(upToDot)) return false;

    return true;
}

function pushUtterance(into: string[], candidate: string): void {
    const trimmed = candidate.trim();
    if (trimmed.length === 0) return;
    // A stray fragment of punctuation has nothing to say; glue it to the last
    // utterance rather than making the synthesiser stutter on it.
    if (!/[A-Za-z0-9]/.test(trimmed)) {
        if (into.length > 0) into[into.length - 1] += ' ' + trimmed;
        return;
    }
    into.push(trimmed);
}

/** Break a line at the last space before `limit`, or hard-cut if there is none. */
function forceCut(line: string, limit: number): [string, string] {
    const window = line.slice(0, limit);
    const space = window.lastIndexOf(' ');
    if (space > limit / 2) {
        return [line.slice(0, space), line.slice(space + 1)];
    }
    return [window, line.slice(limit)];
}

/**
 * Split prose into the utterances the synthesiser speaks one at a time. A
 * newline is a hard boundary — two bullets are two thoughts — and inside a line
 * the split is on sentence terminators that survive `isSentenceBoundary`.
 */
export function splitIntoSentences(prose: string): string[] {
    const utterances: string[] = [];

    for (const line of prose.split('\n')) {
        let rest = line;

        while (rest.length > 0) {
            let cut = -1;
            for (let i = 0; i < rest.length; i++) {
                const char = rest[i];
                if (char !== '.' && char !== '!' && char !== '?') continue;
                if (!isSentenceBoundary(rest, i)) continue;
                // A terminator only ends a sentence when whitespace or the end
                // of the line follows; anything else is still one token.
                const next = rest[i + 1];
                if (next !== undefined && !/[\s"'”’)\]]/.test(next)) continue;
                let end = i + 1;
                while (end < rest.length && /["'”’)\]]/.test(rest[end])) end++;
                cut = end;
                break;
            }

            if (cut === -1) {
                if (rest.length > maxUtteranceLength) {
                    const [head, tail] = forceCut(rest, maxUtteranceLength);
                    pushUtterance(utterances, head);
                    rest = tail.trimStart();
                    continue;
                }
                pushUtterance(utterances, rest);
                break;
            }

            const sentence = rest.slice(0, cut);
            if (sentence.length > maxUtteranceLength) {
                const [head, tail] = forceCut(sentence, maxUtteranceLength);
                pushUtterance(utterances, head);
                rest = (tail + rest.slice(cut)).trimStart();
                continue;
            }
            pushUtterance(utterances, sentence);
            rest = rest.slice(cut).trimStart();
        }
    }

    return utterances;
}

/**
 * The utterances a single message is worth. Empty for everything that is not
 * assistant prose — tool calls, diffs, mode switches, the user's own messages,
 * and thinking, which the reducer marks with `isThinking` and wraps in
 * asterisks (sync/reducer/reducer.ts:808).
 */
export function speakableChunks(message: Message): string[] {
    if (message.kind !== 'agent-text') return [];
    if (message.isThinking) return [];
    if (typeof message.text !== 'string' || message.text.length === 0) return [];
    const prose = stripToSpeakableProse(message.text);
    if (prose.length === 0) return [];
    return splitIntoSentences(prose);
}
