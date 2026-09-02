/**
 * `drover ask` — raise a prompt on the bus and BLOCK until a human answers it
 * (BASED-115, ported under DROVE-315).
 *
 * The node twin of libexec/drover-ask. One line to put a decision in front of
 * Clay, on whatever surface he happens to be near:
 *
 *     if drover ask --confirm "Roll the keycloak stack?"; then ./roll.sh; fi
 *     case "$(drover ask 'Which region?' use1 euw1 apse1)" in ...
 *
 * It needs no drover session, no Claude, no tmux and no hook.
 *
 * NOT A GATE. lib/drover-gate.sh is the gate shim: it owes its caller a
 * decision, so with no answer it writes a DENY, and it has a result file, an
 * allow body and a deny body. This has none of that. With no answer it exits
 * nonzero and prints nothing, because a script that asked a question and got
 * no answer must decide for itself what silence means. There used to be a
 * second gate shim called lib/drover-ask.sh; it was deleted because a fork of
 * the gate is how a fix lands where nothing runs. This is not that file and
 * must never grow into it.
 *
 * THE GATE SHIM ITSELF STAYS SHELL, and that is a measurement rather than a
 * preference (DROVE-315, DROVE-288/314). The per-tool-call hook path costs
 * 39.9 ms in sh today; the same decision reached through this bundle's verb
 * table costs 86.3 ms, which is +46 ms on every tool call — inside the 50 ms
 * bound at the median and outside it at the tail. So lib/drover-gate.sh keeps
 * its shell shim and speaks to the bus over HTTP, and what moved here is the
 * logic BEHIND the bus: this verb, which blocks on a human and has no startup
 * budget to answer to at all.
 *
 * CHANNEL. Every prompt from here is posted `channel: "external"`, which the
 * bus defines as "no harness is waiting" — see engine/inbox.js. That is what
 * puts it in the script bucket of `drover questions`.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { BusError, busGet, busPost } from './bus'
import { droverEnv } from './env'

export interface AskOption {
    id: string
    label: string
    description?: string
}

export interface AskArgs {
    title: string
    reason: string
    preview: string
    timeoutS: number
    session: string
    gate: string
    harness: string
    cwd: string
    confirm: boolean
    multi: boolean
    json: boolean
    options: AskOption[]
}

/** A refusal that carries the exit code the shell used and the words it said. */
export class AskUsageError extends Error {
    constructor(readonly code: number, readonly lines: string[]) {
        super(lines[0] ?? '')
        this.name = 'AskUsageError'
    }
}

export const askUsage = `drover ask — put a question on the phone, the watch and tmux, and wait for it.

USAGE
  drover ask "Which region?" use1 euw1 apse1
        Print the chosen option id on stdout. One argument per choice.

  drover ask --confirm "Roll the stack?"
        A yes/no gate. Exit 0 ONLY on allow, so \`if drover ask --confirm …\`
        reads the way it looks and fails closed on everything else.

  drover ask "Pick one" --option prod:"Production" --option dev:"Dev only"
        When the label should differ from the id, or carry a description:
        --option <id>:<label>[:<description>]

OPTIONS
  --confirm            yes/no instead of a list (a \`permission\` event)
  --multi              let the human pick MORE THAN ONE. stdout is one chosen
                       id per line, in the order they were picked.
  --option <spec>      one choice, id:label[:description]. Repeatable.
  --reason <text>      why you are asking; shown under the title
  --preview <text>     the command, the diff, the thing about to happen
  --timeout <seconds>  how long to wait (default 600). 0 waits forever.
  --session <id>       attach it to a session, so it shows there AND in the
                       all-questions view. Omitted means it belongs to no
                       session, which is the normal case for a script.
  --cwd <dir>          default: $PWD
  --gate <name>        a label for the publish ledger and the inbox
  --harness <name>     default: shell
  --json               print the whole resolved event instead of the option id

EXIT
  0  answered. stdout is the chosen option id ("allow"/"deny" with --confirm),
     and with --confirm only an allow exits 0.
  1  --confirm and the answer was deny
  3  nobody answered before the timeout
  4  withdrawn (the prompt was canceled)
  5  the bus is unreachable or refused the prompt
  2  bad arguments

A prompt this raises is CANCELED if you interrupt the script, so a card never
outlives the thing that asked. Answer it anywhere: first answer wins and every
other surface dismisses.

Envelope and endpoints: docs/hitl.md
`

/**
 * One choice, from the `id:label[:description]` spelling.
 *
 * A bare word is its own id AND label, which is what makes
 * `drover ask "Which region?" use1 euw1` a one-liner. The shell computes this
 * with ${x%%:*} and ${x#*:}, and the corner it leaves is deliberate: an id
 * with an empty label falls back to the id, and a description equal to the
 * label means there was no third field at all.
 */
export function parseAskOption(spec: string): AskOption {
    const id = spec.replace(/:.*$/s, '')
    const firstColon = spec.indexOf(':')
    const rest = firstColon === -1 ? spec : spec.slice(firstColon + 1)
    let label: string
    let description = ''
    if (rest === spec) {
        label = id
    } else {
        label = rest.replace(/:.*$/s, '')
        const afterSecond = rest.indexOf(':')
        description = afterSecond === -1 ? rest : rest.slice(afterSecond + 1)
        if (description === label) description = ''
    }
    if (id === '') throw new AskUsageError(2, [`drover ask: an option needs an id (got '${spec}')`])
    if (label === '') label = id
    return description === '' ? { id, label } : { id, label, description }
}

/**
 * The command line, exactly as the shell's `while [ $# -gt 0 ]` reads it.
 *
 * `shift 2` with one argument left is an error, and under `set -e` it aborts
 * with no message at all — the trap drover-flip-menu documents. Every
 * two-argument flag names its missing value instead.
 */
export function parseAskArgs(argv: string[], cwd: string = process.cwd()): AskArgs | 'help' {
    const out: AskArgs = {
        title: '', reason: '', preview: '', timeoutS: 600, session: '', gate: '',
        harness: 'shell', cwd, confirm: false, multi: false, json: false, options: [],
    }
    let positional = false
    let i = 0
    const need = (flag: string): string => {
        if (i + 1 >= argv.length) throw new AskUsageError(2, [`drover ask: ${flag} needs a value`])
        i += 1
        return argv[i]
    }
    for (; i < argv.length; i++) {
        const a = argv[i]
        switch (a) {
            case '--confirm': out.confirm = true; break
            case '--multi': out.multi = true; break
            case '--option': out.options.push(parseAskOption(need(a))); break
            case '--reason': out.reason = need(a); break
            case '--preview': out.preview = need(a); break
            case '--timeout': out.timeoutS = timeoutOf(need(a)); break
            case '--session': out.session = need(a); break
            case '--cwd': out.cwd = need(a); break
            case '--gate': out.gate = need(a); break
            case '--harness': out.harness = need(a); break
            case '--json': out.json = true; break
            case '-h':
            case '--help': return 'help'
            default:
                if (a.startsWith('-')) {
                    throw new AskUsageError(2, [`drover ask: unknown option '${a}' (try --help)`])
                }
                if (!positional) { out.title = a; positional = true } else { out.options.push(parseAskOption(a)) }
        }
    }

    // The order the shell validates in, because the first refusal is the one a
    // caller sees and swapping two of them changes the message.
    if (out.title === '') {
        throw new AskUsageError(2, ['drover ask: a question needs a title (try --help)'])
    }
    if (!Number.isFinite(out.timeoutS)) {
        throw new AskUsageError(2, ['drover ask: --timeout takes whole seconds'])
    }
    if (out.confirm && out.multi) {
        throw new AskUsageError(2, ['drover ask: --confirm is yes/no; --multi needs a list of choices'])
    }
    if (out.confirm) {
        // A permission with no options of its own gets allow/deny injected by
        // the bus, which is exactly what a confirm wants.
        out.options = []
    } else if (out.options.length === 0) {
        throw new AskUsageError(2, [
            'drover ask: a question needs at least one choice, or use --confirm',
            '  drover ask "Which region?" use1 euw1',
        ])
    }
    return out
}

/** `case "$timeout_s" in '' | *[!0-9]*)` — whole seconds, nothing else. */
function timeoutOf(raw: string): number {
    if (raw === '' || !raw.match(/^[0-9]+$/)) return Number.NaN
    return Number(raw)
}

/**
 * The event envelope, with the keys in the order `jq -n` wrote them.
 *
 * Key order is not cosmetic here: the fixture test compares these bytes to the
 * shell's own `jq -c` output, and a reordered object is a different string.
 *
 * --confirm is a `permission`, everything else a `question`. The bus enforces
 * the difference and it matters: a question refused with allow/deny is
 * WITHDRAWN from every surface, so posting the wrong kind loses the prompt
 * rather than mis-answering it.
 */
export function buildAskPayload(args: AskArgs, account: string): Record<string, unknown> {
    const nullable = (s: string): string | null => (s === '' ? null : s)
    return {
        kind: args.confirm ? 'permission' : 'question',
        title: args.title,
        reason: args.reason,
        preview: args.preview,
        // ttlMs 0 means never expire, which is what --timeout 0 asks for.
        ttlMs: args.timeoutS * 1000,
        // Only ever true on a question: --confirm and --multi together are
        // refused above, and the bus refuses a true one on any other kind.
        multiSelect: args.multi,
        // "external" = nothing in a harness is blocked on this answer; the
        // caller reads it off the bus itself. See engine/inbox.js.
        channel: 'external',
        options: args.options.length === 0 ? null : args.options,
        origin: {
            harness: args.harness,
            gate: nullable(args.gate),
            sessionId: nullable(args.session),
            cwd: nullable(args.cwd),
            account: nullable(account),
            surface: null,
        },
    }
}

/**
 * The answer, in the one vocabulary a caller has to learn.
 *
 * The bus normalizes a permission answered by its injected allow/deny buttons
 * back to action allow/deny, so optionId and action agree there; `text`
 * answers print the text. A multi-select prints one id per LINE rather than a
 * joined string, so a caller can pipe it to `while read` instead of
 * re-splitting on a separator that might be inside a label.
 */
export function answerOf(event: unknown): string {
    const r = (event as { resolution?: Record<string, unknown> })?.resolution ?? {}
    if (r.action === 'text') return String(r.text ?? '')
    const ids = r.optionIds
    if (Array.isArray(ids) && ids.length > 0) return ids.join('\n')
    if (r.optionId !== null && r.optionId !== undefined) return String(r.optionId)
    return String(r.action ?? '')
}

/**
 * Which account the asking shell is on (DROVE-31). `drover ask` runs from a
 * plain script with no hook environment, so DROVER_ACCOUNT is usually absent
 * and the prompt used to reach the phone with origin.account null. The config
 * dir this process inherited names it instead.
 *
 * Asked of libexec/drover-account-of rather than re-derived, because that file
 * is the one reader of how a config dir maps to an account name and a second
 * one here would drift the day it changed.
 */
export function askingAccount(env: NodeJS.ProcessEnv = process.env): string {
    const of = join(droverEnv(env).droverDir, 'libexec', 'drover-account-of')
    if (existsSync(of)) {
        const r = spawnSync(of, [], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        const said = (r.stdout ?? '').trim()
        if (r.status === 0 && said !== '') return said
    }
    return env.DROVER_ACCOUNT ?? ''
}

export async function run(args: string[]): Promise<number> {
    let parsed: AskArgs | 'help'
    try {
        parsed = parseAskArgs(args)
    } catch (error) {
        if (error instanceof AskUsageError) {
            for (const line of error.lines) process.stderr.write(line + '\n')
            return error.code
        }
        throw error
    }
    if (parsed === 'help') { process.stdout.write(askUsage); return 0 }
    const ask = parsed
    const base = droverEnv().droverUrl

    const payload = buildAskPayload(ask, askingAccount())
    let id: string
    try {
        const posted = await busPost('/v1/events', payload, 10_000, base)
        let body: unknown
        try { body = JSON.parse(posted.body) } catch { body = null }
        id = String((body as { id?: unknown })?.id ?? '')
        if (id === '') {
            process.stderr.write(`drover ask: the bus refused the prompt: ${posted.body}\n`)
            return 5
        }
    } catch (error) {
        if (error instanceof BusError) {
            for (const line of error.explain('the events endpoint')) process.stderr.write(line + '\n')
            return 5
        }
        throw error
    }

    /**
     * A card must never outlive the thing that asked. Interrupting the script
     * is the one way a helper like this strands a prompt on the wrist with no
     * producer left to answer to, and that is the exact failure the broker
     * exists to kill.
     */
    let answered = false
    const withdraw = (): void => {
        // Fire and forget: the process is on its way out and an unreachable
        // bus is not a reason to hang on the way.
        void busPost(`/v1/events/${id}/cancel`, { by: 'drover-ask' }, 3_000, base).catch(() => {})
    }
    const onSignal = (signal: NodeJS.Signals, code: number): void => {
        if (!answered) withdraw()
        process.off('SIGINT', sigint)
        process.off('SIGTERM', sigterm)
        process.exitCode = code
        // Give the cancel a moment to leave, then go. The shell's `curl -m 3`
        // has the same shape and the same ceiling.
        setTimeout(() => process.exit(code), 300).unref()
    }
    const sigint = (): void => onSignal('SIGINT', 130)
    const sigterm = (): void => onSignal('SIGTERM', 143)
    process.on('SIGINT', sigint)
    process.on('SIGTERM', sigterm)

    /**
     * The long poll, in a loop. One call is not enough either way: the bus
     * caps timeout_ms at 30 minutes, so a longer wait has to be re-armed, and
     * --timeout 0 means wait forever, which no single request can express. A
     * 204 from /wait is "still pending", not "gone", so the loop re-arms
     * rather than giving up — a poll that gives up first turns a live prompt
     * into a timeout nobody can explain.
     */
    const ttlMs = ask.timeoutS * 1000
    let pollMs = 600_000
    if (ttlMs > 0 && ttlMs < pollMs) pollMs = ttlMs
    const deadline = ask.timeoutS > 0 ? Date.now() + (ask.timeoutS + 5) * 1000 : 0

    let event: Record<string, unknown> | null = null
    for (;;) {
        let res
        try {
            res = await busGet(`/v1/events/${id}/wait?timeout_ms=${pollMs}`, pollMs + 10_000, base)
        } catch (error) {
            if (error instanceof BusError) {
                for (const line of error.explain('the answer')) process.stderr.write(line + '\n')
                return 5
            }
            throw error
        }
        let body: Record<string, unknown> | null = null
        try { body = JSON.parse(res.body) as Record<string, unknown> } catch { body = null }
        const state = typeof body?.state === 'string' ? body.state : ''
        if (state !== '' && state !== 'pending') { event = body; break }
        // Empty body = the 204 long-poll timeout. Re-arm unless our own
        // deadline has passed; the bus's TTL sweep will have expired the event
        // by then anyway and the next /wait returns it terminal.
        if (deadline !== 0 && Date.now() >= deadline) break
    }

    process.off('SIGINT', sigint)
    process.off('SIGTERM', sigterm)

    if (event === null) {
        withdraw()
        process.stderr.write(`drover ask: nobody answered inside ${ask.timeoutS}s\n`)
        return 3
    }
    answered = true

    const state = String(event.state ?? '')
    if (ask.json) process.stdout.write(JSON.stringify(event, null, 2) + '\n')

    if (state !== 'resolved') {
        if (state === 'expired') {
            if (!ask.json) process.stderr.write('drover ask: the prompt expired unanswered\n')
            return 3
        }
        if (!ask.json) process.stderr.write(`drover ask: the prompt was withdrawn (${state})\n`)
        return 4
    }

    const answer = answerOf(event)
    if (!ask.json) process.stdout.write(answer + '\n')

    if (ask.confirm) {
        // Fail closed. Only an allow is a yes, so `if drover ask --confirm …`
        // cannot be tricked into running by a timeout, a withdrawal or an
        // unreachable bus.
        return answer === 'allow' ? 0 : 1
    }
    return 0
}
