/**
 * `drover approval-parse` — read Claude Code's OWN approval dialog off a tmux
 * pane capture (DROVE-198, ported under DROVE-315).
 *
 * The node twin of libexec/drover-approval-parse, which is an awk program
 * piped into jq. It is the easiest file in the login/gate family to move and
 * the one with the least excuse for drift: it is PURE. stdin to stdout, no
 * bus, no tmux, no clock. So this is a transliteration of that awk, function
 * for function, and the test drives both and compares bytes.
 *
 * It also has no startup budget to answer to. It runs when the Notification
 * hook fires with notification_type "permission_prompt" — once, while a human
 * is already looking at a dialog — not on every tool call. The per-tool-call
 * path stays shell; see the note in docs/node-port.md and the timing table on
 * DROVE-315.
 *
 * READS THE OPTIONS IT IS GIVEN, never a known list of them. The dialog has
 * had two, three and four options in the last month, and a parser that
 * enumerated shapes would go silent again the next time one was added. So:
 * find the last run of `N.` lines, take however many there are, and refuse the
 * whole read rather than return a partial one if the numbers are not 1..N in
 * order.
 *
 * `unknown` is the important half. A shape this cannot read must still reach a
 * human, so the caller publishes the raw text rather than dropping it —
 * silence on an unmatched shape is the bug class DROVE-198 is about, and it is
 * a bigger bug than any single shape.
 */

export interface ApprovalOption {
    id: string
    label: string
}

export interface ApprovalRead {
    shape: 'numbered' | 'unknown'
    title: string
    question: string
    preview: string
    options: ApprovalOption[]
}

export interface ApprovalLimits {
    /**
     * Lines of context to consider above the options: enough for a command,
     * its description and the "requires approval" line, not so many that an
     * unrelated earlier dialog is dragged in.
     */
    context: number
    /**
     * How far from the bottom of the pane the last option may sit. A dialog
     * that has been answered and scrolled up is not a live prompt, and its
     * leftover option lines must not be read as one.
     */
    tail: number
    /**
     * How much raw pane text an unreadable shape carries. The card has to say
     * enough for a human to recognise what his terminal is asking.
     */
    raw: number
    /**
     * The pane's width in columns, when the caller knows it. It is the only
     * way to tell the dialog's two kinds of line wrap apart: Claude Code
     * breaks a long option at a space when it can and MID-TOKEN when it
     * cannot, and only a line that filled the pane was broken mid-token.
     * Rejoining the second kind with a space puts one inside a path. Unknown
     * (0) joins with a space, which is right for every wrap at a word.
     */
    width: number
}

/** The env names and defaults the shell reads, unchanged. */
export function approvalLimits(env: NodeJS.ProcessEnv = process.env): ApprovalLimits {
    const num = (name: string, fallback: number): number => {
        const raw = env[name]
        if (raw === undefined || raw === '') return fallback
        const n = Number(raw)
        // awk's -v takes whatever it is given and coerces; a non-number there
        // becomes 0, and that is the behaviour a caller who typed nonsense got.
        return Number.isFinite(n) ? n : 0
    }
    return {
        context: num('DROVER_APPROVAL_CONTEXT', 40),
        tail: num('DROVER_APPROVAL_TAIL', 30),
        raw: num('DROVER_APPROVAL_RAW_LINES', 24),
        width: num('DROVER_APPROVAL_WIDTH', 0),
    }
}

const rtrim = (s: string): string => s.replace(/[ \t\r]+$/, '')
const ltrim = (s: string): string => s.replace(/^[ \t]+/, '')
const trim = (s: string): string => ltrim(rtrim(s))
/** awk's flat(): a tab inside a value would break the record separator. */
const flat = (s: string): string => s.replace(/\t/g, ' ')

/**
 * The selection caret is not part of the option. Claude Code draws U+276F;
 * other builds have used >, and stripping a leading one costs nothing.
 */
function unmark(s: string): string {
    return ltrim(s).replace(/^(❯|>|›|▸|▶|»)[ \t]+/, '')
}

/**
 * The number of an option line, or 0. "3.14 is pi" is not an option: the dot
 * must be followed by a space.
 */
function optnum(s: string): number {
    const t = unmark(s)
    if (!t.match(/^[0-9]+\.[ \t]/)) return 0
    return Number(t.replace(/\..*$/, ''))
}

function optlabel(s: string): string {
    const t = unmark(s).replace(/^[0-9]+\.[ \t]+/, '')
    return flat(rtrim(t))
}

/**
 * The printed width of a line, or -1 when it cannot be counted. The shell's
 * awk counts BYTES, so a line carrying the caret or a box rule measures long;
 * it guards that with an all-printable-ASCII test, where bytes and characters
 * are the same number. Same test, same answer.
 */
function cols(s: string): number {
    return s.match(/^[ -~]*$/) ? s.length : -1
}

/**
 * A continuation the dialog produced by running out of room mid-token carries
 * no space of its own. One it wrapped at a word does.
 */
function joiner(prev: string, width: number): string {
    if (width <= 0) return ' '
    const n = cols(prev)
    if (n < 0) return ' '
    return n >= width - 1 ? '' : ' '
}

function indentof(s: string): number {
    let n = 0
    while (s[n] === ' ' || s[n] === '\t') n++
    return n
}

/**
 * The rule Claude Code draws above the dialog. Also matches a box top, for a
 * build that frames it instead.
 */
function isrule(s: string): boolean {
    const t = trim(s)
    if (t.match(/^[╭┌╔][─━═]*/)) return true
    if (t.length < 10) return false
    return Boolean(t.match(/^[─━═—=_-]+$/))
}

/**
 * Read a capture. `text` is exactly what `tmux capture-pane -p` wrote.
 *
 * The awk reads records, so a trailing newline does not make a final empty
 * line; splitting has to drop it the same way or `lastfull` moves.
 */
export function parseApproval(text: string, limits: ApprovalLimits): ApprovalRead {
    const body = text.endsWith('\n') ? text.slice(0, -1) : text
    // An empty input is zero records to awk, not one empty one.
    const line: string[] = body === '' ? [] : body.split('\n')
    const last = line.length
    // awk indexes from 1; keep that so the arithmetic below reads like the
    // original rather than being silently off by one.
    const at = (i: number): string => line[i - 1] ?? ''

    const bodies: string[] = []
    const out: ApprovalRead = { shape: 'unknown', title: '', question: '', preview: '', options: [] }
    const finish = (): ApprovalRead => ({ ...out, preview: bodies.join('\n') })

    // The last line with anything on it. tmux pads the capture to the pane
    // height, so the record count is the pane, not the content.
    let lastfull = 0
    for (let i = 1; i <= last; i++) if (trim(at(i)) !== '') lastfull = i
    if (lastfull === 0) return finish()

    const unknown = (): ApprovalRead => {
        out.shape = 'unknown'
        let from = lastfull - limits.raw + 1
        if (from < 1) from = 1
        let printed = false
        for (let i = from; i <= lastfull; i++) {
            if (trim(at(i)) === '' && !printed) continue
            printed = true
            bodies.push(flat(rtrim(at(i))))
        }
        return finish()
    }

    let start = 0
    for (let i = 1; i <= last; i++) if (optnum(at(i)) === 1) start = i
    if (start === 0) return unknown()

    const lbl: string[] = []
    let cnt = 0
    let bad = false
    let stop = start
    for (let i = start; i <= last; i++) {
        const n = optnum(at(i))
        if (n > 0) {
            cnt++
            // Out of sequence: this is not one list, or it is one list with
            // something in the middle we cannot see. Refuse the whole read
            // rather than offer a card with options missing.
            if (n !== cnt) { bad = true; break }
            lbl[cnt] = optlabel(at(i))
            stop = i
            continue
        }
        if (trim(at(i)) === '') break
        if (cnt === 0) break
        // The dialog wraps a long option onto an indented continuation.
        if (indentof(at(i)) < 2) break
        lbl[cnt] = lbl[cnt] + joiner(at(stop), limits.width) + trim(flat(at(i)))
        stop = i
    }
    // Two is the smallest real choice, and a lone "1." in prose is not one.
    if (bad || cnt < 2) return unknown()
    // An answered dialog scrolls up and leaves its option lines behind. A live
    // prompt is at the bottom of the pane.
    if (lastfull - stop > limits.tail) return unknown()

    // The question is the last thing said before the list.
    let qline = 0
    for (let i = start - 1; i >= 1 && start - i <= limits.context; i--) {
        if (trim(at(i)) !== '') { qline = i; break }
    }

    // The dialog block runs back to the rule Claude Code draws above it.
    let head = 1
    const from = qline > 0 ? qline : start
    for (let i = from; i >= 1 && from - i <= limits.context; i--) {
        if (isrule(at(i))) { head = i + 1; break }
        if (i === 1 || from - i === limits.context) head = i
    }

    let tline = 0
    for (let i = head; i > 0 && i < from; i++) {
        if (trim(at(i)) !== '') { tline = i; break }
    }

    out.shape = 'numbered'
    if (tline > 0) out.title = flat(trim(at(tline)))
    if (qline > 0) out.question = flat(trim(at(qline)))
    let blank = false
    let seen = 0
    for (let i = tline > 0 ? tline + 1 : head; i <= (qline > 0 ? qline : start - 1); i++) {
        if (trim(at(i)) === '') { blank = true; continue }
        if (blank && seen > 0) bodies.push('')
        blank = false
        seen++
        bodies.push(flat(trim(at(i))))
    }
    for (let i = 1; i <= cnt; i++) out.options.push({ id: String(i), label: lbl[i] })
    return finish()
}

/**
 * The verb. Reads the capture on stdin and prints one compact JSON object,
 * with the keys in the order `jq -c` emitted them, and one newline — which is
 * what makes the shell's output and this one comparable byte for byte.
 */
export async function run(args: string[]): Promise<number> {
    if (args.includes('-h') || args.includes('--help')) {
        process.stdout.write(
            'drover approval-parse — read Claude Code\'s own approval dialog off a pane capture.\n'
            + '\n'
            + 'USAGE\n'
            + '  drover approval-parse < capture   # tmux capture-pane -p output\n'
            + '\n'
            + 'Prints one JSON object: {"shape","title","question","preview","options"}.\n'
            + '"unknown" carries the tail of the pane verbatim in preview, so a shape this\n'
            + 'cannot read still reaches a human.\n',
        )
        return 0
    }
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
    const read = parseApproval(Buffer.concat(chunks).toString('utf8'), approvalLimits())
    process.stdout.write(JSON.stringify(read) + '\n')
    return 0
}
