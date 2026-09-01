/**
 * `drover pick-account` — the start-path account decision (DROVE-21), as a verb.
 *
 * Cattle Drover: which account should a session START on? bin/drover asks
 * this before the first spawn — it is the one place the headroom logic lives,
 * so the shell never grows a second copy — and execs `drover account use
 * <answer>`. The answer is the name on stdout, nothing when there is no
 * opinion, and one line on stderr saying why.
 *
 * Lives in its own module (DROVE-288) so the verb loads only the registry,
 * the cooldown ledger and the resume-id parser: it runs before EVERY session
 * start, and when it sat in index.ts's static import graph it paid ~2s of
 * bundle-wide import cost to read a few JSON files.
 */

import chalk from 'chalk'

import { pickStartAccount } from '@/drover/flip/accounts'
import { resumedClaudeSessionId } from '@/resume/resumedClaudeSessionId'

export async function handlePickAccountCommand(own: string[]): Promise<never> {
  // Everything after `--` is the session's own argv, so --resume/--continue
  // and --model are read by the same parsers the session will use.
  const split = own.indexOf('--')
  const claudeArgs = split >= 0 ? own.slice(split + 1) : []
  const flags = split >= 0 ? own.slice(0, split) : own
  let cwd = process.cwd()
  let asJson = false
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--cwd' && flags[i + 1]) cwd = flags[++i]
    else if (flags[i] === '--json') asJson = true
    else if (flags[i] === '-h' || flags[i] === '--help') {
      console.log(`
${chalk.bold('drover pick-account')} [--cwd <dir>] [--json] [-- <claude args>]

Prints the account a session started with those args, in that directory,
would open on: where the resumed session was left, else the account last used
in the directory, else the first one with headroom. Reads only.
`)
      process.exit(0)
    }
  }
  const model = (() => {
    const i = claudeArgs.indexOf('--model')
    if (i >= 0 && claudeArgs[i + 1]) return claudeArgs[i + 1]
    const eq = claudeArgs.find((a) => a.startsWith('--model='))
    return eq ? eq.slice('--model='.length) : undefined
  })()
  const pick = pickStartAccount({
    cwd,
    sessionId: resumedClaudeSessionId(claudeArgs, cwd),
    ...(model ? { model } : {}),
  })
  if (asJson) {
    console.log(JSON.stringify({ account: pick.account?.name ?? null, via: pick.via, note: pick.note ?? null }))
  } else {
    if (pick.note) console.error(`drover: ${pick.note}`)
    if (pick.account) console.log(pick.account.name)
  }
  process.exit(0)
}
