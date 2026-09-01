/**
 * A gate this process raised, written where `drover status` already looks
 * (DROVE-279, keeping DROVE-239's property).
 *
 * DROVE-239's finding was not "add a field". It was that the bus knew WHO
 * ended a prompt and the ledger did not, so four destructive-bash gates a
 * stray keystroke allowed on 2026-08-31 left a trail indistinguishable from
 * four a human had read. `lib/drover-gate.sh` fixed that for the shell gates
 * by splitting its verdicts into `-locally` / `-remotely` and by naming itself
 * on the withdrawal (`{"by":"gate-timeout:$GATE"}`).
 *
 * A gate raised from happy-cli owes the same trail. `openCodexGate` writes
 * none, which was survivable while its only outcome was a deny; a gate whose
 * confirming row spends money is not survivable that way, because "nobody
 * answered and we took the safe row" and "Clay tapped the safe row" have to be
 * distinguishable AFTERWARDS, from the file, without the bus's memory.
 *
 * Format is `lib/drover-gate.sh`'s note(), byte for byte — tab-separated
 * `<iso8601> <kind> <gate> <verdict>` in published.log — because `drover
 * status` cuts on those positions and greps that vocabulary. Same file as the
 * shell gates, deliberately: it answers "has a prompt ever left this machine",
 * and a prompt raised from TypeScript is still a prompt.
 *
 * Never throws. A ledger that cannot be written is a reason to have no record,
 * never a reason to leave a dialog holding the pane.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { droverStateDir } from './messageLedger'

export function gateLedgerPath(): string {
    return join(droverStateDir(), 'published.log')
}

/**
 * One line. `kind` is the bus kind so a question is counted apart from a
 * permission, exactly as adapters/claude-pretooluse.sh counts its own.
 */
export function noteGate(kind: string, gate: string, verdict: string): void {
    try {
        const path = gateLedgerPath()
        mkdirSync(dirname(path), { recursive: true })
        const at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
        appendFileSync(path, `${at}\t${kind}\t${gate}\t${verdict}\n`)
    } catch {
        // Nothing to do about it, and nothing worth stranding a session over.
    }
}
