/**
 * The Fable credits dialog, put on the drover bus as a QUESTION (DROVE-279).
 *
 * The dialog next door is not a permission and it is not a confirmation. It is
 * a CHOICE between rows that Claude Code drew, one of which spends money, and
 * the only correct answer to it is a human's. So it travels the bus as
 * `kind: "question"` carrying the rows exactly as the pane drew them, the app
 * renders them through the AskUserQuestion card it already has, the watch
 * mirrors them through GateStore, and whatever comes back is typed into the
 * pane by `answerPaneCreditsRow`.
 *
 * WHY A QUESTION AND NOT A PERMISSION, in one line each:
 *
 *   - a permission's yes is `allow`, and this dialog has no `allow` — it has
 *     "Continue with Fable 5" and "Yes, buy usage credits", which are not the
 *     same answer;
 *   - `busResolutionFor` refuses to turn a bare approve into an option id for
 *     a question (droverBridge.ts), so nothing generic can answer this by
 *     accident, which is the DROVE-69 failure it was written to stop;
 *   - DROVE-277's auto-accept refuses it TWICE — `kind !== 'permission'` and
 *     `options?.length` — and that wall is already drawn and already tested in
 *     `autoAcceptGate.spec.ts`. Nothing here has to ask it not to.
 *
 * WHERE THE FAIL-SAFE LINE IS DRAWN, and it is not where `openCodexGate` draws
 * it. A Codex approval that cannot reach the bus falls through to the app's
 * own card, so a dead bus there means "carry on with the surfaces you had".
 * There is no second surface for THIS dialog: it is holding a tmux pane, and
 * the pane queue is blocked behind it. So every path that does not produce a
 * human's row produces the SAFE row instead:
 *
 *   - no bus, refused publish, no id back  -> safe row. The money question was
 *     never asked, so the answer is no.
 *   - the budget closed it                 -> safe row, and the event is
 *     withdrawn as `gate-timeout:fable-credits` so `endedBy.by` names us
 *     rather than the anonymous "producer" (DROVE-239).
 *   - withdrawn by somebody else (a phone Stop takes this path, DROVE-80)
 *                                          -> safe row.
 *   - resolved with free TEXT, or an option id that names no row
 *                                          -> safe row. Arbitrary text is
 *     never typed into a dialog whose second row is a purchase.
 *
 * "Safe row" is `creditsSafeRow`, which is null when the decline cannot be
 * recognised; the answerer turns that into an Escape. Neither buys anything,
 * and both unblock the pane.
 */

import { logger } from '@/ui/logger'

import { noteGate } from '@/drover/gateLedger'
import type { CreditsAnswerResult } from './paneCreditsAnswer'
import { creditsSafeRow, type PaneCreditsDialog } from './paneCreditsDialog'

/** The gate's name, in `origin.gate` and in the ledger's third column. */
export const creditsGateName = 'fable-credits'

/** The bus every shell gate uses when nothing says otherwise. */
const defaultBus = 'http://127.0.0.1:7970'

export interface PaneCreditsGateRequest {
    dialog: PaneCreditsDialog
    /** Claude Code's own session id: what routes the card and what
     *  `busHasPendingFor` matches, so this gate blocks the pane queue while it
     *  is open and unblocks it the moment it closes. */
    sessionId: string | null
    cwd: string | null
    account: string | null
    /** `$TMUX_PANE`. The binding that makes this THIS session's dialog. */
    surface: string | null
}

export type PaneCreditsGateOutcome =
    /** A human named a row. `by` is the bus's own word for which surface. */
    | { pick: 'row'; label: string; by: string }
    /** Nobody did. Take the safe row (or Escape), and say why in one clause. */
    | { pick: 'safe'; reason: string }

export interface PaneCreditsGateOptions {
    bus?: string
    timeoutMs?: number
    fetchImpl?: typeof fetch
    env?: NodeJS.ProcessEnv
}

/** What `GET /v1/events/<id>/wait` hands back once the prompt has ended. */
type WaitBody = {
    state?: string
    resolution?: { action?: string; optionId?: string; text?: string; by?: string } | null
}

/** Cap the prose we POST, the way every other producer caps its preview. */
const previewMax = 2000

/**
 * Raise the gate and wait for a human.
 *
 * Resolves exactly once, and never rejects: a caller holding a pane cannot be
 * left with an exception where an answer should be.
 */
export async function openPaneCreditsGate(
    req: PaneCreditsGateRequest,
    opts: PaneCreditsGateOptions = {},
): Promise<PaneCreditsGateOutcome> {
    const env = opts.env ?? process.env
    const doFetch = opts.fetchImpl ?? fetch
    const bus = (opts.bus ?? env.DROVER_URL ?? defaultBus).replace(/\/+$/, '')
    // The same budget and the same env var as every other harness, so all of
    // them time out together rather than drifting apart.
    const fromEnv = Number(env.DROVER_GATE_TIMEOUT_MS)
    const timeoutMs =
        opts.timeoutMs ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 580_000)

    // The rows go out with positional ids AND their own text as the label.
    // `busResolutionFor` matches an answer on `o.id === candidate || o.label
    // === candidate`, and the AskUserQuestion card the phone renders carries
    // labels only — so the label is what actually comes back, and the id is
    // there for the watch and the push, which speak ids.
    const options = req.dialog.rows.map((row) => ({ id: `row-${row.index}`, label: row.label }))
    const safe = creditsSafeRow(req.dialog)

    let created: { id?: string } | null = null
    try {
        const res = await doFetch(`${bus}/v1/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                kind: 'question',
                title: req.dialog.title,
                reason: 'Claude Code is asking about Fable 5 usage credits',
                preview: req.dialog.body.slice(0, previewMax) || req.dialog.title,
                channel: 'hook-wait',
                options,
                origin: {
                    harness: 'claude-code',
                    gate: creditsGateName,
                    sessionId: req.sessionId,
                    cwd: req.cwd,
                    account: req.account,
                    surface: req.surface,
                },
            }),
        })
        if (!res.ok) {
            noteGate('question', creditsGateName, `publish-failed http ${res.status}`)
            return safeArm(`the bus refused the publish (${res.status})`)
        }
        created = (await res.json()) as { id?: string }
    } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        noteGate('question', creditsGateName, `publish-failed ${why}`)
        return safeArm('the bus could not be reached')
    }
    const id = created?.id
    if (!id) {
        noteGate('question', creditsGateName, 'publish-failed no id')
        return safeArm('the bus returned no event id')
    }
    noteGate('question', creditsGateName, `published ${id}`)

    let body: WaitBody | null = null
    try {
        const res = await doFetch(`${bus}/v1/events/${id}/wait?timeout_ms=${timeoutMs}`)
        // 204 is the long-poll's own timeout, and it carries no body by
        // definition — so it is read as "still pending" without touching
        // res.json(), which would throw and be indistinguishable from the bus
        // dying mid-wait.
        if (res.status === 204) {
            await withdraw(doFetch, bus, id)
            noteGate('question', creditsGateName, 'unanswered-safe-row')
            return safeArm('nobody answered inside the budget')
        }
        if (!res.ok) {
            await withdraw(doFetch, bus, id)
            noteGate('question', creditsGateName, `wait-failed http ${res.status}`)
            return safeArm(`the bus would not hold the question (${res.status})`)
        }
        body = (await res.json()) as WaitBody
    } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        logger.debug(`[creditsGate] lost the bus while waiting: ${why}`)
        await withdraw(doFetch, bus, id)
        noteGate('question', creditsGateName, 'wait-failed lost-bus')
        return safeArm('the bus was lost while the question was open')
    }

    if (body?.state !== 'resolved') {
        // Canceled or expired. A phone Stop lands here (paneInject withdraws
        // every open gate rather than answering one), and so does the TTL.
        noteGate('question', creditsGateName, `withdrawn-safe-row ${body?.state ?? 'unreadable'}`)
        return safeArm(`the question ended ${body?.state ?? 'unreadably'} without an answer`)
    }
    const resolution = body.resolution ?? null
    const by = resolution?.by ?? 'unknown'
    if (resolution?.action === 'option') {
        const chosen = options.find((o) => o.id === resolution.optionId)
        if (chosen) {
            noteGate('question', creditsGateName, `answered-remotely ${chosen.id}`)
            return { pick: 'row', label: chosen.label, by }
        }
        noteGate('question', creditsGateName, 'answered-unmatched-safe-row')
        return safeArm(`the answer named ${resolution.optionId ?? 'no option'}, which is not a row`)
    }
    // Free text, an ack, anything else. Never typed: the second row of this
    // dialog is a purchase and arbitrary keystrokes have no business near it.
    noteGate('question', creditsGateName, `answered-unusable-safe-row ${resolution?.action ?? 'none'}`)
    return safeArm(`the answer was ${resolution?.action ?? 'empty'}, not one of the rows`)

    function safeArm(reason: string): PaneCreditsGateOutcome {
        logger.debug(
            `[creditsGate] taking the safe row (${safe?.label ?? 'none readable'}): ${reason}`,
        )
        return { pick: 'safe', reason }
    }
}

/**
 * Withdraw the card AND SAY WHO WITHDREW IT (DROVE-239).
 *
 * `cancelEvent` falls back to the string "producer" when the body says
 * nothing, which is how a gate that ran out of budget became
 * indistinguishable from a prompt some other producer pulled for its own
 * reasons. `gate-timeout:<gate>` is the spelling `lib/drover-gate.sh` already
 * uses, so one grep finds both.
 */
async function withdraw(doFetch: typeof fetch, bus: string, id: string): Promise<void> {
    try {
        await doFetch(`${bus}/v1/events/${id}/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ by: `gate-timeout:${creditsGateName}` }),
        })
    } catch {
        // The bus being unreachable now changes nothing: the safe row is taken
        // either way and the card ages out of every surface on its own TTL.
    }
}

/**
 * What goes in published.log's fourth column once the row has been typed.
 *
 * DROVE-239's split, in this gate's words: `-remotely` means a human decided,
 * and everything else means this process decided FOR him. That distinction is
 * the entire reason the ledger exists — the bus's `by` is what caught four
 * auto-allows, and the ledger has to carry the same fact without the bus's
 * memory — so it is a pure function with a test rather than a ternary buried
 * in the launcher.
 */
export function creditsLedgerVerdict(
    outcome: PaneCreditsGateOutcome,
    result: CreditsAnswerResult,
): string {
    if (result.state === 'typed') {
        return outcome.pick === 'row' ? `typed-remotely by ${outcome.by}` : 'typed-safe-row'
    }
    if (result.state === 'dismissed') return 'dismissed-nothing-bought'
    if (result.state === 'gone') return 'closed-elsewhere'
    return 'stuck-nothing-typed'
}
